import { panelsForView } from '../lib/mediaPanels';
import { channelIdentityMatches, channelIdentitySnapshot, remapReferences } from '@shared/channel-identity.js';
import { AUTH_MODE_KEY, LOCAL_LOCK_KEY, DEFAULT_SETTINGS, sessionGeneration, invalidateSession, storedAuthMode, locallyLocked, rememberAuthMode, markLocalLock, clearPrivateStorage } from '../lib/privacy';
import { create } from 'zustand';
import { api, setUnauthorizedHandler } from '../lib/api';
import { uid } from '../lib/uid';
import { channelCategories, countryName } from '../lib/country';
import { catchupUrl } from '../lib/catchup';
import { setAltNameIndex } from '../lib/epg';
import { parseM3U, effectiveKind, legacyChannelId } from '@shared/m3u.js';
import { channelCountry } from '@shared/country.js';
import { mergeGuides } from '@shared/normalize.js';

// Configured EPG source URLs (migrates the legacy single `epgUrl`).
export function epgSources(settings = {}) {
  const list = Array.isArray(settings.epgUrls) ? settings.epgUrls : [];
  const urls = [...list, settings.epgUrl].map((u) => (u || '').trim()).filter(Boolean);
  return [...new Set(urls)];
}

// Editable Settings fields, separate from server-only settings and immediate actions.
export function settingsFormValues(settings = {}) {
  return { epgUrls: epgSources(settings), refreshIntervalMinutes: settings.refreshIntervalMinutes ?? 360,
    defaultCountry: settings.defaultCountry || '', recordingPadding: settings.recordingPadding || { before: 1, after: 5 } };
}
export function hasSettingsDraft(editor, settings) {
  return !!editor && (!!editor.epgInput || !!editor.addUrl || !!editor.addName ||
    (!!editor.values && JSON.stringify(editor.values) !== JSON.stringify(settingsFormValues(settings))));
}

// A playlist is "predominantly radio" if its name says so or most channels are radio.
function autoContentKind(channels, name = '') {
  if (/\bradio\b/i.test(name)) return 'radio';
  if (!channels.length) return 'auto';
  const radio = channels.filter((c) => c.kind === 'radio').length;
  return radio / channels.length >= 0.7 ? 'radio' : 'auto';
}

const LS = {
  playlists: 'ro-iptv:playlists',
  pendingUploads: 'ro-iptv:pendingUploads',
  playlistChanges: 'ro-iptv:playlistChanges',
  favourites: 'ro-iptv:favourites',
  history: 'ro-iptv:history',
  lastChannel: 'ro-iptv:lastChannel',
  activePlaylist: 'ro-iptv:activePlaylist',
  settings: 'ro-iptv:settings',
  idv2: 'ro-iptv:idv2', // one-shot flag: channel ids migrated to content-derived v2
  stateConflicts: 'ro-iptv:stateConflicts',
  stateSync: 'ro-iptv:stateSync', // per-key last-applied updatedAt shadow for cross-device sync
};

// Cap a catchup window a minute short of now so we never request the still-airing tail.
const CATCHUP_END_MARGIN_MS = 60_000;
const HISTORY_CAP = 60;

// Keys mirrored to the server for cross-device sync (favourites / history / settings).
const SYNCED_STATE_KEYS = ['favourites', 'history', 'settings'];
const STATE_PUSH_DEBOUNCE_MS = 2000;

// Debounced push of a state key to the server, independently per key so a rapid
// favourites toggle can't cancel a pending settings write (and vice versa).
const statePushTimers = {};
const stateWrites = new Map();
const stateWriteChains = new Map();
let authCheck = null;
let playlistSync = null;
let playlistEpoch = 0;
let settingsCommit = Promise.resolve();
let settingsPending = 0;
let epgEpoch = 0;
let epgFlight = null;
let recordingsFlight = null;
let recordingsEpoch = 0;
const sessionTimers = new Set();
function sessionTimeout(fn, ms) {
  const timer = setTimeout(() => { sessionTimers.delete(timer); fn(); }, ms);
  sessionTimers.add(timer);
  return timer;
}
function cancelStatePushes() {
  for (const [key, timer] of Object.entries(statePushTimers)) { clearTimeout(timer); delete statePushTimers[key]; }
  for (const timer of sessionTimers) clearTimeout(timer);
  sessionTimers.clear();
}
function pushState(key, value) {
  if (!canAccess(useStore.getState().auth)) return;
  const generation = sessionGeneration();
  clearTimeout(statePushTimers[key]);
  statePushTimers[key] = setTimeout(() => {
    delete statePushTimers[key];
    const job = (stateWriteChains.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (generation !== sessionGeneration() || !canAccess(useStore.getState().auth)) return;
      if (key === 'settings') return useStore.getState().applySettings(value).catch(() => {});
      if (useStore.getState().stateConflicts[key]) return useStore.getState().recordStateConflict(key, value, useStore.getState().stateConflicts[key].current);
      const writeToken = {}; stateWrites.set(key, writeToken);
      try {
        const record = await api.saveState(key, value, load(LS.stateSync, {})[key] || 0);
        if (generation !== sessionGeneration()) return;
        save(LS.stateSync, { ...load(LS.stateSync, {}), [key]: record.updatedAt });
      } catch (error) {
        if (generation === sessionGeneration() && error.status === 409) useStore.getState().recordStateConflict(key, useStore.getState()[key], error.current);
      } finally { if (stateWrites.get(key) === writeToken) stateWrites.delete(key); }
    });
    stateWriteChains.set(key, job);
  }, STATE_PUSH_DEBOUNCE_MS);
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Last-played channel as persisted by playChannel() (null on fresh profiles).
export function loadLastChannel() {
  if (storedAuthMode() !== 'open' && !canAccess(useStore.getState().auth)) return null;
  return load(LS.lastChannel, null);
}

export function canAccess(auth) {
  return auth.checked && (!auth.required || (auth.authed && !auth.mustChange));
}

export const useStore = create((set, get) => ({
  // ---- data ----
  playlists: load(LS.playlists, []), // [{id,name,url,type,channelCount,updatedAt,enabled,contentKind}]
  pendingUploads: (Array.isArray(load(LS.pendingUploads, [])) ? load(LS.pendingUploads, []) : [])
    .filter((upload) => upload && typeof upload.id === 'string' && typeof upload.text === 'string')
    .map((upload) => upload.status === 'conflict' ? upload : ({ ...upload, status: 'failed', error: 'Upload not confirmed. Retry to save it on the server.' })),
  playlistChanges: (Array.isArray(load(LS.playlistChanges, [])) ? load(LS.playlistChanges, []) : [])
    .filter((item) => item && typeof item.id === 'string' && item.record)
    .map((item) => ({ ...item, status: item.status === 'conflict' ? 'conflict' : 'failed' })),
  channels: [], // combined channels from all ENABLED playlists (kind-routed)
  identityPending: {},
  identityConflicts: {},
  epg: null, // {channels, programmes}
  favourites: load(LS.favourites, []), // [channelId]
  history: load(LS.history, []), // [{id,name,logo,url,kind,at}]
  recordings: [],
  settings: load(LS.settings, DEFAULT_SETTINGS),
  epgLoading: false,
  epgSourceRevision: null,
  epgError: null,
  stateConflicts: load(LS.stateConflicts, {}),
  settingsDraft: null, // session memory only; never persisted or synced
  settingsSaving: false,
  settingsError: null,

  // ---- ui ----
  view: 'home', // home | live | radio | recordings | settings
  browseScopes: {}, // in-memory filters for each media view
  sidebarPanel: 'channels', // channels | favourites | history | epg | categories | catchup
  selectedCountry: null, // Live null = country grid; Radio null / '*' = all; '' = Undefined bucket
  activeCategory: 'All',
  search: '',
  currentChannel: null,
  previousChannelId: null, // session only; resolve fresh metadata when toggling
  previousChannelShortcut: 'b',
  loading: false,
  error: null,
  toast: null,

  // ---- auth ----
  // checked: have we asked the server yet? required: is auth enforced?
  // authed: do we hold a valid session? mustChange: bootstrap password still in
  // use → force a change before entering the app. Until checked, App shows a splash.
  auth: { checked: false, required: false, authed: false, mustChange: false, username: '' },

  // ---- actions ----
  setView: (view) => {
    const state = get();
    if (state.view === view) return;
    const browseScopes = { ...state.browseScopes };
    if (panelsForView(state.view).length) {
      browseScopes[state.view] = { sidebarPanel: state.sidebarPanel, selectedCountry: state.selectedCountry,
        activeCategory: state.activeCategory, search: state.search };
    }
    const scope = panelsForView(view).length ? browseScopes[view] || {
      sidebarPanel: 'channels', selectedCountry: view === 'live' ? state.settings.defaultCountry || null : null,
      activeCategory: 'All', search: '',
    } : { search: '' };
    set({ view, browseScopes, ...scope });
  },
  setSidebarPanel: (panel) => {
    const state = get();
    if (!panelsForView(state.view).some(item => item.id === panel)) return;
    if (panel === 'countries') set({ sidebarPanel: 'channels', selectedCountry: null, activeCategory: 'All', search: '' });
    else set({ sidebarPanel: panel, ...(state.view === 'live' && panel === 'channels' && state.selectedCountry === null ? { selectedCountry: '*' } : {}) });
  },
  setSelectedCountry: (selectedCountry) => set({ selectedCountry, activeCategory: 'All' }),
  setCategory: (activeCategory) => set({ activeCategory }),
  setSearch: (search) => set({ search }),
  recordStateConflict(key, value, current) {
    const stateConflicts = { ...get().stateConflicts, [key]: { value, current } };
    set({ stateConflicts }); save(LS.stateConflicts, stateConflicts);
  },
  async resolveStateConflict(key, choice) {
    if (!canAccess(get().auth)) return;
    const conflict = get().stateConflicts[key]; if (!conflict) return;
    const generation = sessionGeneration();
    let record = conflict.current;
    if (choice === 'local') {
      try { record = await api.saveState(key, conflict.value, record?.updatedAt || 0); }
      catch (error) { if (generation === sessionGeneration() && error.status === 409) get().recordStateConflict(key, conflict.value, error.current); throw error; }
    } else {
      record = (await api.listState()).find(item => item.key === key) || { key, value: key === 'settings' ? {} : [], updatedAt: 0 };
    }
    if (generation !== sessionGeneration()) return;
    if (get().stateConflicts[key] !== conflict) {
      const latest = get().stateConflicts[key];
      if (latest) get().recordStateConflict(key, latest.value, record);
      return;
    }
    if (key === 'history') { set({ history: record.value }); save(LS.history, record.value); }
    else get()._applyStateRecord(record, false);
    if (key === 'settings') get().discardSettingsDraft();
    save(LS.stateSync, { ...load(LS.stateSync, {}), [key]: record.updatedAt });
    const stateConflicts = { ...get().stateConflicts }; delete stateConflicts[key];
    set({ stateConflicts }); save(LS.stateConflicts, stateConflicts);
  },
  updateSettingsDraft(update) {
    if (!canAccess(get().auth)) return;
    const editor = get().settingsDraft || { values: null, epgInput: '', addUrl: '', addName: '' };
    set({ settingsDraft: update(editor) });
  },
  discardSettingsDraft() { set({ settingsDraft: null }); },
  acknowledgeSettingsDraft(saved) {
    const current = get().settingsDraft;
    // Edits made during Save belong to the next draft. Input text is independent
    // of the committed fields and must not disappear with a delayed response.
    if (current && current.values === saved?.values) set({ settingsDraft: { ...current, values: null } });
  },
  setToast: (toast) => {
    set({ toast });
    if (toast) sessionTimeout(() => get().toast === toast && set({ toast: null }), 3200);
  },

  // Invalidate before awaiting cleanup: late reads and debounced writes cannot
  // bring the previous account back while logout or a new login is in progress.
  async _clearPrivateData() {
    invalidateSession();
    get().cancelRecordingsRefresh();
    playlistSync = null;
    stateWrites.clear(); stateWriteChains.clear();
    settingsCommit = Promise.resolve(); settingsPending = 0;
    epgEpoch++; epgFlight = null;
    const generation = sessionGeneration();
    cancelStatePushes();
    setAltNameIndex({});
    set({ playlists: [], pendingUploads: [], playlistChanges: [], identityPending: {}, identityConflicts: {}, channels: [], epg: null, favourites: [], history: [], recordings: [],
      settings: { ...DEFAULT_SETTINGS }, currentChannel: null, previousChannelId: null, previousChannelShortcut: 'b', loading: false, epgLoading: false,
      epgSourceRevision: null, epgError: null, stateConflicts: {}, settingsDraft: null, settingsSaving: false, settingsError: null,
      search: '', selectedCountry: null, activeCategory: 'All', sidebarPanel: 'channels', browseScopes: {}, view: 'home', error: null, toast: null });
    await clearPrivateStorage();
    return generation;
  },

  async _lock(message = '', broadcast = true) {
    set({ auth: { checked: true, required: true, authed: false, mustChange: false, username: '', notice: message } });
    try { if (broadcast) { markLocalLock(true); rememberAuthMode(true); } }
    catch {
      // A quota error must not leave a stale auth-off marker behind.
      try { localStorage.removeItem(AUTH_MODE_KEY); } catch { /* remain locked in memory */ }
    }
    try { return (await get()._clearPrivateData()) === sessionGeneration(); }
    catch {
      set({ auth: { ...get().auth, authed: false, notice: 'Browser data could not be cleared. Close this browser and clear this site’s data before sharing it.' } });
      return false;
    }
  },

  checkAuth() {
    // React development mode and concurrent callers share the same check.
    if (!authCheck) authCheck = get()._checkAuth().finally(() => { authCheck = null; });
    return authCheck;
  },

  async _checkAuth() {
    setUnauthorizedHandler(() => { void get()._lock('Your session ended. Sign in again.'); });
    const generation = sessionGeneration();
    let serverRequired;
    try {
      const s = await api.authStatus();
      if (generation !== sessionGeneration()) return get().auth;
      if (typeof s.authRequired !== 'boolean') throw new Error('Unknown authentication state');
      serverRequired = s.authRequired;
      // A still-valid cookie after failed logout does not undo the local lock.
      const locked = s.authRequired && locallyLocked();
      rememberAuthMode(s.authRequired);
      if (!s.authRequired) markLocalLock(false);
      const auth = { checked: true, required: s.authRequired, authed: !s.authRequired || (!!s.authed && !locked),
        mustChange: !!s.mustChange, username: s.username || '', notice: '' };
      if (s.authRequired) {
        // An unacknowledged upload is the only local data retained on startup,
        // and only after the server verifies the same account owns it.
        const playlistChanges = auth.authed && !auth.mustChange ? get().playlistChanges.filter((item) => item.owner === auth.username) : [];
        const pendingUploads = auth.authed && !auth.mustChange
          ? get().pendingUploads.filter((upload) => upload.owner === auth.username) : [];
        try {
          if ((await get()._clearPrivateData()) !== sessionGeneration()) return get().auth;
          if (playlistChanges.length) {
            set({ playlistChanges }); save(LS.playlistChanges, playlistChanges);
            for (const change of playlistChanges) {
              if (change.type === 'save' && change.status !== 'conflict' && change.cacheValid && Array.isArray(change.channels)) {
                save(`ro-iptv:channels:${change.id}`, change.channels);
                save(`ro-iptv:channelRevision:${change.id}`, change.refreshContent ? `pending:${change.operationId}` : change.record.contentRevision ?? null);
              }
            }
          }
          if (pendingUploads.length) { set({ pendingUploads }); save(LS.pendingUploads, pendingUploads); }
        } catch {
          await get()._lock('Browser data could not be cleared. Clear this site’s data before continuing.');
          return get().auth;
        }
        if (!auth.authed) {
          await get()._lock(locked && s.authed ? 'This browser is locked. The server still reports an active session. Retry sign-out before sharing this browser.' : '');
          return get().auth;
        }
      }
      set({ auth });
      return auth;
    } catch {
      if (generation !== sessionGeneration()) return get().auth;
      if (serverRequired !== true && storedAuthMode() === 'open' && !locallyLocked()) {
        try { rememberAuthMode(false); }
        catch {
          await get()._lock('Browser storage is unavailable. Connect and sign in to continue.');
          return get().auth;
        }
        const auth = { checked: true, required: false, authed: true, mustChange: false, username: '', notice: '' };
        set({ auth }); return auth;
      }
      await get()._lock('Cannot verify your session while offline. Connect and sign in to continue.');
      return get().auth;
    }
  },

  async login(username, password, remember) {
    if (!(await get()._lock())) throw new Error('Browser data could not be cleared. Clear this site’s data before signing in.');
    const generation = sessionGeneration();
    const s = await api.login(username, password, remember);
    if (generation !== sessionGeneration()) return;
    rememberAuthMode(true); markLocalLock(false);
    set({ auth: { checked: true, required: true, authed: true, mustChange: !!s.mustChange, username: s.username || username, notice: '' } });
    if (!s.mustChange) await get().init();
  },

  async changePassword(newPassword, remember) {
    const generation = sessionGeneration();
    const s = await api.changePassword(newPassword, remember);
    if (generation !== sessionGeneration()) return;
    markLocalLock(true);
    const auth = { ...get().auth, mustChange: false, authed: true, username: s.username || get().auth.username };
    set({ auth: { ...auth, checked: false } });
    if ((await get()._clearPrivateData()) !== sessionGeneration()) return;
    markLocalLock(false);
    set({ auth });
    await get().init();
  },

  async updatePassword(currentPassword, newPassword) {
    const generation = sessionGeneration();
    await api.changePassword(newPassword, true, currentPassword);
    if (generation !== sessionGeneration()) return;
    markLocalLock(true);
    const auth = get().auth;
    set({ auth: { ...auth, checked: false } });
    if ((await get()._clearPrivateData()) !== sessionGeneration()) return;
    markLocalLock(false);
    set({ auth });
    await get().init();
  },

  async logout() {
    await get()._lock();
    const generation = sessionGeneration();
    try { await api.logout(); }
    catch {
      if (generation === sessionGeneration()) set({ auth: { ...get().auth,
        notice: 'This browser is locked. Server sign-out failed; the session cookie may still be valid. Reconnect and retry sign-out before sharing this browser.' } });
      return false;
    }
    return true;
  },

  async init() {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    set({ loading: true });
    try {
      const cfg = await api.config().catch(() => ({}));
      if (generation !== sessionGeneration()) return;
      const settings = { ...get().settings };
      // Migrate legacy single epgUrl → epgUrls list; seed from server config.
      const urls = epgSources(settings);
      if (cfg.epgUrl) urls.push(cfg.epgUrl);
      settings.epgUrls = [...new Set(urls.map((u) => (u || '').trim()).filter(Boolean))];
      delete settings.epgUrl;
      if (cfg.refreshIntervalMinutes) settings.refreshIntervalMinutes = cfg.refreshIntervalMinutes;
      set({ settings });
      save(LS.settings, settings);

      // Pull playlists from the server so any origin/device sharing this backend
      // rebuilds the same channels (localStorage is per-origin).
      await get()._hydratePlaylists();
      if (generation !== sessionGeneration()) return;

      // Same guarantee for favourites / history / settings.
      await get()._syncState();
      if (generation !== sessionGeneration()) return;

      // Auto-load a server-configured M3U_URL playlist on first run.
      const playlists = get().playlists;
      if (cfg.m3uUrl && cfg.m3uSeedAllowed && !playlists.some((p) => p.url === cfg.m3uUrl)) {
        await get().addPlaylistFromUrl(cfg.m3uUrl, 'Server Playlist', { silent: true, id: cfg.m3uPlaylistId, operationId: cfg.m3uPlaylistId });
        if (generation !== sessionGeneration()) return;
      }

      get()._rebuildChannels();

      get().loadRecordings();
      get().loadEpg();
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      set({ error: String(err.message || err) });
    } finally {
      if (generation !== sessionGeneration()) return;
      set({ loading: false });
    }
  },

  async addPlaylistFromUrl(url, name, { silent, id, operationId } = {}) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    set({ loading: true, error: null });
    try {
      const data = await api.fetchPlaylistFromUrl(url);
      if (generation !== sessionGeneration()) return;
      const record = {
        id: id || uid(),
        name: name || url.split('/').pop() || 'Playlist',
        url,
        type: 'url',
        channelCount: data.count,
        updatedAt: new Date().toISOString(),
        enabled: true,
        contentKind: autoContentKind(data.channels, name),
        channels: data.channels,
      };
      const result = await get()._queuePlaylistChange(record, { create: true, refreshContent: true, operationId });
      if (generation !== sessionGeneration()) return;
      if (!silent && result === 'saved') get().setToast(`Loaded ${data.count} channels`);
      return record;
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      set({ error: String(err.message || err) });
      if (!silent) get().setToast(`Failed: ${err.message || err}`);
      throw err;
    } finally {
      if (generation !== sessionGeneration()) return;
      set({ loading: false });
    }
  },

  async restoreConfiguration(previewId) {
    if (!canAccess(get().auth)) throw new Error('Sign in before restoring configuration');
    const generation = sessionGeneration();
    const result = await api.restoreConfiguration(previewId);
    if (generation !== sessionGeneration()) throw new Error('Session changed');
    // Old debounced/in-flight curation writes must not reappear after restore.
    invalidateSession(); cancelStatePushes(); stateWrites.clear(); stateWriteChains.clear();
    settingsCommit = Promise.resolve(); settingsPending = 0; epgEpoch++; epgFlight = null;
    let browserCleanupFailed = false;
    for (const key of [LS.settings, LS.favourites]) {
      try { localStorage.removeItem(key); } catch { browserCleanupFailed = true; }
    }
    const shadow = { ...load(LS.stateSync, {}) }; delete shadow.settings; delete shadow.favourites;
    const stateConflicts = Object.fromEntries(Object.entries(get().stateConflicts).filter(([key]) => !['settings', 'favourites'].includes(key)));
    if (!save(LS.stateSync, shadow) || !save(LS.stateConflicts, stateConflicts)) browserCleanupFailed = true;
    set({ settingsDraft: null, settingsSaving: false, settingsError: null, stateConflicts, epg: null, epgSourceRevision: null });
    return { ...result, browserCleanupFailed };
  },

  async changeLocalStation(method, body, id) {
    if (!canAccess(get().auth)) throw new Error('Sign in before saving a station');
    const generation = sessionGeneration();
    const result = await api.changeLocalStation(method, body, id);
    if (generation !== sessionGeneration()) throw new Error('Session changed');
    if (!Number.isSafeInteger(result?.revision) || !Array.isArray(result?.stations)) throw new Error('Server did not acknowledge the station');
    // The server commit is already acknowledged; a failed view refresh must not
    // turn it into a blind retry of station creation.
    try { await get()._hydratePlaylists(); }
    catch { if (generation === sessionGeneration()) get().setToast('Station saved on server. Sync playlists to refresh this device.'); }
    if (generation !== sessionGeneration()) throw new Error('Session changed');
    return result;
  },

  async addPlaylistFromText(text, name) {
    if (!canAccess(get().auth)) return;
    const channels = parseM3U(text);
    const upload = { id: uid(), name: name || 'Uploaded Playlist', text,
      owner: get().auth.required ? get().auth.username : 'auth-off',
      contentKind: autoContentKind(channels, name), status: 'pending', error: '' };
    const pendingUploads = [...get().pendingUploads, upload];
    set({ pendingUploads });
    save(LS.pendingUploads, pendingUploads);
    return get().retryPlaylistUpload(upload.id);
  },

  async retryPlaylistUpload(id) {
    if (!canAccess(get().auth)) return;
    const upload = get().pendingUploads.find((item) => item.id === id);
    if (!upload || upload.status === 'saving') return;
    const generation = sessionGeneration();
    const patch = (fields) => {
      const pendingUploads = get().pendingUploads.map((item) => item.id === id ? { ...item, ...fields } : item);
      set({ pendingUploads });
      return save(LS.pendingUploads, pendingUploads);
    };
    const persistent = patch({ status: 'saving', error: '' });
    set({ loading: true, error: null });
    try {
      const response = await api.savePlaylistFile(id, upload.text, upload);
      if (generation !== sessionGeneration()) return;
      if (response?.playlist?.hasFile !== true || response.playlist.id !== id || !Number.isSafeInteger(response.playlist.revision) || !Number.isSafeInteger(response.playlist.contentRevision)) throw new Error('Server did not confirm the complete versioned upload. Update the server and retry.');
      const channels = await get()._canonicalChannels(id);
      if (generation !== sessionGeneration() || !channels) return;
      const record = { ...response.playlist, identityVersion:3, channels };
      const cached = get()._persistPlaylist(record, { server: false });
      const pendingUploads = get().pendingUploads.filter((item) => item.id !== id);
      set({ pendingUploads });
      save(LS.pendingUploads, pendingUploads);
      get()._rebuildChannels();
      get().setToast(cached ? `Saved ${channels.length} channels on server` : 'Saved on server; browser cache is unavailable. Reload to restore the playlist.');
      return record;
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      const conflict = err.status === 409 || err.status === 410;
      const message = conflict ? 'Upload changed or was deleted on another device. Download the pending copy for recovery or discard it; it will not overwrite the server.'
        : `Upload not saved: ${err.message || err}. Retry${persistent ? ' from this page.' : ' while this tab is open; browser storage is unavailable.'}`;
      patch({ status: conflict ? 'conflict' : 'failed', error: message });
      set({ error: message });
      get().setToast(message);
      throw err;
    } finally {
      if (generation === sessionGeneration()) set({ loading: get().pendingUploads.some((item) => item.status === 'saving') });
    }
  },

  discardPlaylistUpload(id) {
    if (!canAccess(get().auth) || get().pendingUploads.some((item) => item.id === id && item.status === 'saving')) return;
    const pendingUploads = get().pendingUploads.filter((item) => item.id !== id);
    set({ pendingUploads }); save(LS.pendingUploads, pendingUploads);
  },

  async _canonicalChannels(id, previous = null) {
    const generation = sessionGeneration();
    previous = previous || load(`ro-iptv:channels:${id}`, []);
    if (!previous.length) previous = get().identityPending[id] || load(`ro-iptv:identityPending:${id}`, []);
    if (!previous.length) previous = get().history.filter(channel => channel.playlistId === id || channel.id?.startsWith(id + '__'))
      .map(channel => ({ ...channel, id: channel.id.slice(id.length + 2) }));
    const legacySeen=new Map();
    const backup=previous.map((channel,index)=>({...channelIdentitySnapshot(channel),
      legacyAlias:channel.legacyAlias||legacyChannelId(channel,legacySeen),
      indexAlias:channel.indexAlias||`${index}-${channel.tvgId||channel.name}`.replace(/[^a-zA-Z0-9-_]/g,'_')}));
    set({identityPending:{...get().identityPending,[id]:backup}});
    const backupStored=save(`ro-iptv:identityPending:${id}`,backup);
    const failed=error=>{if(!backupStored&&generation===sessionGeneration())get().setToast('Channel migration is pending. Keep this tab open; browser storage is unavailable.');throw error};
    let result = await api.playlistChannels(id).catch(failed);
    if (generation !== sessionGeneration()) return null;
    if (result?.version !== 3 || !Array.isArray(result.channels)) throw new Error('Server channel identity migration is unavailable');
    const references=new Set([...(result.references||[]),...get().favourites,...Object.keys(get().settings.epgOverrides||{}),...get().history.map(channel=>channel.id),get().currentChannel?.id,get().previousChannelId,load(LS.lastChannel,null)?.id]
      .filter(ref=>typeof ref==='string').map(ref=>ref.startsWith(id+'__')?ref.slice(id.length+2):ref));
    const aliases = {}, seen = new Map();
    for (const [n,p] of channelIdentityMatches(previous,result.channels)) {
      const old=previous[p],fresh=result.channels[n];
      if (old.id !== fresh.id) aliases[old.id]=fresh.id;
      aliases[old.legacyAlias||legacyChannelId(old,seen)]=fresh.id;
      aliases[old.indexAlias||`${p}-${old.tvgId || old.name}`.replace(/[^a-zA-Z0-9-_]/g,'_')]=fresh.id;
    }
    const entries=Object.entries(aliases).filter(([old,target]) => references.has(old) && old!==target && result.aliases?.[old]!==target);
    for(let offset=0;offset<entries.length;offset+=500){
      result=await api.saveChannelAliases(id,Object.fromEntries(entries.slice(offset,offset+500))).catch(failed);
      if (generation !== sessionGeneration()) return null;
    }
    get()._applyChannelIdentity(id,result);
    localStorage.removeItem(`ro-iptv:identityPending:${id}`);
    set({identityPending:Object.fromEntries(Object.entries(get().identityPending).filter(([key])=>key!==id))});
    return result.channels;
  },

  _applyChannelIdentity(id, result) {
    const needed=new Set([...get().favourites,...Object.keys(get().settings.epgOverrides||{}),...get().history.map(channel=>channel.id),get().currentChannel?.id,get().previousChannelId,load(LS.lastChannel,null)?.id]);
    const aliases=Object.fromEntries(Object.entries(result.aliases||{}).filter(([old])=>needed.has(id+'__'+old)).map(([old,target])=>[id+'__'+old,id+'__'+target]));
    const meta=get().playlists.find(record=>record.id===id);
    const channels=result.channels.map(channel=>({...channel,id:id+'__'+channel.id,playlistId:id,kind:effectiveKind(meta?.contentKind,channel)}));
    const favourites=remapReferences(get().favourites,'favourites',aliases,channels);
    const history=remapReferences(get().history,'history',aliases,channels);
    const settings=remapReferences(get().settings,'settings',aliases,channels);
    const current=get().currentChannel;
    const remapSnapshot=old=>old ? remapReferences([old],'history',aliases,channels)[0] : null;
    const freshCurrent=remapSnapshot(current);
    const last=remapSnapshot(load(LS.lastChannel,null));
    if(last)save(LS.lastChannel,last);
    if(!load(`ro-iptv:identityBackup:${id}`,null)) save(`ro-iptv:identityBackup:${id}`,{version:2,aliases});
    const conflicts=[...(result.conflicts||[])];
    for(const [old,target]of Object.entries(aliases))if(Object.hasOwn(get().settings.epgOverrides||{},old)&&Object.hasOwn(get().settings.epgOverrides||{},target)&&get().settings.epgOverrides[old]!==get().settings.epgOverrides[target])conflicts.push({id:old,reason:'override-conflict'});
    const changed=(a,b)=>JSON.stringify(a)!==JSON.stringify(b);
    if(changed(favourites,get().favourites))pushState('favourites',favourites);
    if(changed(history,get().history))pushState('history',history);
    if(changed(settings,get().settings))pushState('settings',settings);
    set({favourites,history,settings,previousChannelId:aliases[get().previousChannelId]||get().previousChannelId,currentChannel:current?.isCatchup?{...current,id:freshCurrent.id}:freshCurrent,
      identityConflicts:{...get().identityConflicts,[id]:conflicts}});
    save(LS.favourites,favourites);save(LS.history,history);save(LS.settings,settings);
  },

  _persistPlaylist(record, { server = true, cacheChannels = true } = {}) {
    if (!canAccess(get().auth)) return;
    // Store channels separately (can be large) keyed by playlist id.
    const channelsSaved = cacheChannels && save(`ro-iptv:channels:${record.id}`, record.channels || []);
    const meta = { ...record };
    delete meta.channels;
    const playlists = [...get().playlists.filter((p) => p.id !== record.id), meta];
    set({ playlists });
    const metadataSaved = save(LS.playlists, playlists);
    if (cacheChannels) {
      save(`ro-iptv:channelRevision:${record.id}`, record.contentRevision ?? null);
      if(record.identityVersion===3)save(`ro-iptv:channelIdentityVersion:${record.id}`,3);
    }
    // Server writes use the explicit, revision-checked operation queue.
    if (server) void get()._queuePlaylistChange(record, { create: !record.revision, refreshContent: true });
    return channelsSaved && metadataSaved;
  },

  _savePlaylistChanges(playlistChanges) {
    const entries = playlistChanges.map((change) => ({ ...change, volatile: false }));
    const persistent = save(LS.playlistChanges, entries);
    set({ playlistChanges: persistent ? entries : entries.map((change) => ({ ...change, volatile: true })) });
    return persistent;
  },

  async _queuePlaylistChange(record, { type = 'save', create = false, refreshContent = false, operationId } = {}) {
    if (!canAccess(get().auth)) return;
    const existing = get().playlistChanges.find((change) => change.id === record.id);
    if (existing?.status === 'saving' || existing?.status === 'conflict') return;
    playlistEpoch++;
    const cachedChannels = record.channels || load(`ro-iptv:channels:${record.id}`, null);
    const cacheValid = Array.isArray(cachedChannels) && (Array.isArray(record.channels) || load(`ro-iptv:channelRevision:${record.id}`, null) === record.contentRevision);
    const change = { id: record.id, type, create: existing?.create ?? create,
      baseRevision: existing?.baseRevision ?? record.revision ?? 0,
      operationId: operationId || uid(), owner: get().auth.required ? get().auth.username : 'auth-off',
      channels: cacheValid ? cachedChannels : undefined, cacheValid,
      record: { ...record }, refreshContent: refreshContent || !!existing?.refreshContent,
      status: 'pending', error: '' };
    delete change.record.channels;
    get()._savePlaylistChanges([...get().playlistChanges.filter((item) => item.id !== record.id), change]);
    if (type === 'delete') get()._evictPlaylist(record.id);
    else {
      const channels = record.channels || load(`ro-iptv:channels:${record.id}`, null);
      const cacheChannels = Array.isArray(channels) && (Array.isArray(record.channels) || load(`ro-iptv:channelRevision:${record.id}`, null) === record.contentRevision);
      get()._persistPlaylist({ ...record, pending: true, channels: channels || [] }, { server: false, cacheChannels });
      if (change.refreshContent && cacheChannels) save(`ro-iptv:channelRevision:${record.id}`, `pending:${change.operationId}`);
    }
    get()._rebuildChannels();
    const result = await get()._flushPlaylistChange(record.id);
    if (result === 'conflict') {
      if (playlistSync) await playlistSync;
      await get()._hydratePlaylists({ replay: false });
    }
    return result;
  },

  async _flushPlaylistChange(id) {
    if (!canAccess(get().auth)) return;
    const change = get().playlistChanges.find((item) => item.id === id);
    if (!change || change.status === 'saving' || change.status === 'conflict') return;
    const generation = sessionGeneration();
    const patch = (fields) => get()._savePlaylistChanges(get().playlistChanges.map((item) => item.id === id ? { ...item, ...fields } : item));
    patch({ status: 'saving', error: '' });
    try {
      const result = change.type === 'delete'
        ? await api.deletePlaylist(id, change.baseRevision)
        : await api.savePlaylist({ ...change.record, revision: change.baseRevision,
          refreshContent: change.refreshContent, operationId: change.operationId });
      if (generation !== sessionGeneration()) return;
      if (change.type !== 'delete' && (result?.id !== id || !Number.isSafeInteger(result.revision) || result.revision < 1)) {
        throw new Error('Server did not acknowledge a versioned playlist');
      }
      playlistEpoch++;
      if (change.type !== 'delete') {
        let canonical=null;
        if(change.create) canonical=await get()._canonicalChannels(id);
        if(generation!==sessionGeneration())return;
        const channels = canonical || load(`ro-iptv:channels:${id}`, null);
        const cacheChannels = Array.isArray(channels) && (canonical || change.refreshContent || load(`ro-iptv:channelRevision:${id}`, null) === result.contentRevision);
        get()._persistPlaylist({ ...result, ...(canonical?{identityVersion:3}:{}), pending: false, channels: channels || [],
          ...(!cacheChannels ? { syncError: 'Current channels unavailable. Retry sync.' } : {}) }, { server: false, cacheChannels });
      }
      get()._savePlaylistChanges(get().playlistChanges.filter((item) => item.id !== id));
      get()._rebuildChannels();
      return 'saved';
    } catch (error) {
      if (generation !== sessionGeneration()) return;
      const conflict = error.status === 409 || error.status === 410;
      patch({ status: conflict ? 'conflict' : 'failed', error: conflict
        ? 'Changed or deleted on another device. The server version was kept. Discard this pending change.'
        : 'Not synced. Your change is kept on this device; retry when connected.' });
      get().setToast(conflict ? 'Playlist conflict: server version kept' : 'Playlist change pending sync');
      return conflict ? 'conflict' : 'pending';
    }
  },

  async retryPlaylistChanges() { await get()._hydratePlaylists(); },

  async discardPlaylistChange(id) {
    if (!canAccess(get().auth) || get().playlistChanges.some((item) => item.id === id && item.status === 'saving')) return;
    get()._savePlaylistChanges(get().playlistChanges.filter((item) => item.id !== id));
    get()._evictPlaylist(id);
    await get()._hydratePlaylists();
  },

  _evictPlaylist(id) {
    for (const key of [`ro-iptv:channels:${id}`, `ro-iptv:channelRevision:${id}`, `ro-iptv:channelIdentityVersion:${id}`]) localStorage.removeItem(key);
    const playlists = get().playlists.filter((record) => record.id !== id);
    const belongs = (channel) => channel?.playlistId === id || channel?.id?.startsWith(id + '__');
    const history = get().history.filter((channel) => !belongs(channel));
    set({ playlists, history, currentChannel: belongs(get().currentChannel) ? null : get().currentChannel });
    save(LS.playlists, playlists); save(LS.history, history);
    if (belongs(load(LS.lastChannel, null))) localStorage.removeItem(LS.lastChannel);
  },

  // A successful server read is authoritative. Offline data and explicit local
  // operations remain distinct, so a stale cache can never recreate a deletion.
  _hydratePlaylists(options) {
    if (!canAccess(get().auth)) return Promise.resolve();
    if (!playlistSync) {
      const task = get()._reconcilePlaylists(options).finally(() => { if (playlistSync === task) playlistSync = null; });
      playlistSync = task;
    }
    return playlistSync;
  },

  async _reconcilePlaylists({ replay = true } = {}) {
    let editEpoch = playlistEpoch;
    const generation = sessionGeneration();
    let server;
    try { server = await api.listPlaylists(); }
    catch { return; } // Failed reads preserve the intentional offline snapshot.
    if (generation !== sessionGeneration() || editEpoch !== playlistEpoch || !Array.isArray(server)) return;
    if (replay) {
      let attempted = false;
      for (const change of get().playlistChanges) {
        if (generation !== sessionGeneration()) return;
        if (change.status === 'conflict' || change.status === 'saving') continue;
        const current = server.find((record) => record.id === change.id);
        if (change.type === 'delete' && !current) {
          get()._savePlaylistChanges(get().playlistChanges.filter((item) => item.id !== change.id));
          continue;
        }
        if ((!current && !change.create) || (current && current.revision !== change.baseRevision && current.lastMutationId !== change.operationId)) {
          get()._savePlaylistChanges(get().playlistChanges.map((item) => item.id === change.id ? { ...item, status: 'conflict', error: 'Changed or deleted on another device. The server version was kept. Discard this pending change.' } : item));
          continue;
        }
        await get()._flushPlaylistChange(change.id); attempted = true;
      }
      if (attempted) {
        editEpoch = playlistEpoch;
        try { server = await api.listPlaylists(); } catch { return; }
        if (generation !== sessionGeneration() || editEpoch !== playlistEpoch || !Array.isArray(server)) return;
      }
    }
    const changes = get().playlistChanges;
    const explicitCreates = new Set(changes.filter((item) => item.create && item.status !== 'conflict').map((item) => item.id));
    for (const local of get().playlists) {
      if (!server.some((record) => record.id === local.id) && !explicitCreates.has(local.id)) {
        // Old releases did not distinguish a failed local create from a
        // remotely deleted copy. Keep an unversioned copy for export only.
        const channels = load(`ro-iptv:channels:${local.id}`, []);
        if (!local.revision && channels.length && !get().playlistChanges.some((item) => item.id === local.id)) {
          get()._savePlaylistChanges([...get().playlistChanges, { id: local.id, type: 'save', create: false,
            owner: get().auth.required ? get().auth.username : 'auth-off', status: 'conflict',
            record: { ...local, channels }, error: 'Legacy local copy is absent on the server. Download it for recovery; it will not be uploaded automatically.' }]);
        }
        get()._evictPlaylist(local.id);
      }
    }
    const merged = [];
    for (const record of server) {
      const change = changes.find((item) => item.id === record.id && item.status !== 'conflict' && item.baseRevision === record.revision);
      if (change?.type === 'delete') { get()._evictPlaylist(record.id); continue; }
      if (change) { merged.push({ ...record, ...change.record, pending: true }); continue; }
      const key = `ro-iptv:channels:${record.id}`;
      const versionKey = `ro-iptv:channelRevision:${record.id}`;
      const cached = load(key, null);
      if (Array.isArray(cached) && record.contentRevision != null && load(versionKey, null) === record.contentRevision && load(`ro-iptv:channelIdentityVersion:${record.id}`,null)===3) {
        merged.push(record); continue;
      }
      // Never keep old streams after learning their content version changed,
      // even if fetching the replacement subsequently fails.
      localStorage.removeItem(key); localStorage.removeItem(versionKey);
      let channels;
      try {
        channels = await get()._canonicalChannels(record.id, cached || []);
        if (generation !== sessionGeneration() || editEpoch !== playlistEpoch) return;
        if (!Array.isArray(channels)) throw new Error('Invalid playlist response');
        save(key, channels); save(versionKey, record.contentRevision ?? null); save(`ro-iptv:channelIdentityVersion:${record.id}`,3);
        merged.push(record);
      } catch {
        if (generation !== sessionGeneration()) return;
        if(get().currentChannel?.playlistId===record.id)set({currentChannel:null});
        merged.push({ ...record, syncError: 'Current channels unavailable. Retry sync.' });
      }
    }
    for (const change of changes) {
      if (change.create && change.type === 'save' && change.status !== 'conflict' && !server.some((record) => record.id === change.id)) merged.push({ ...change.record, pending: true });
    }
    if (editEpoch !== playlistEpoch) return;
    set({ playlists: merged }); save(LS.playlists, merged);
    get()._rebuildChannels();
  },

  // Pull server-synced favourites/history/settings and merge into local. A per-key
  // shadow of the last-applied updatedAt skips records we've already seen (incl. our
  // own writes echoed back). Offline / no backend keeps local state untouched.
  async _syncState() {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    let records;
    try {
      records = await api.listState();
      if (generation !== sessionGeneration()) return;
    } catch {
      if (generation !== sessionGeneration()) return;
      return;
    }
    const shadow = load(LS.stateSync, {});
    const nextShadow = { ...shadow };
    for (const rec of records) {
      if (!SYNCED_STATE_KEYS.includes(rec.key)) continue;
      if (shadow[rec.key] && shadow[rec.key] >= rec.updatedAt &&
          !(rec.key === 'settings' && get().epgSourceRevision == null)) continue;
      if ((rec.key === 'settings' && settingsPending) || statePushTimers[rec.key] || stateWrites.has(rec.key) || get().stateConflicts[rec.key]) continue;
      get()._applyStateRecord(rec, !shadow[rec.key]);
      nextShadow[rec.key] = rec.updatedAt;
    }
    save(LS.stateSync, nextShadow);
    // Migrate pre-sync local guide sources through the same acknowledged path.
    if (!records.some((rec) => rec.key === 'settings') && !settingsPending && epgSources(get().settings).length) {
      await get().applySettings({ epgUrls: epgSources(get().settings) }).catch(() => {});
    }
  },

  // Merge one synced record into local state per its key's policy.
  _applyStateRecord(rec, firstSync) {
    if (!canAccess(get().auth)) return;
    if (rec.key === 'favourites') {
      const server = Array.isArray(rec.value) ? rec.value : [];
      // First-ever sync unions with local stars; afterwards the server wins.
      const merged = firstSync ? [...new Set([...get().favourites, ...server])] : server;
      set({ favourites: merged });
      save(LS.favourites, merged);
      if (firstSync && merged.length !== server.length) pushState('favourites', merged);
      return;
    }
    if (rec.key === 'history') {
      const server = Array.isArray(rec.value) ? rec.value : [];
      const byId = new Map();
      for (const h of [...server, ...get().history]) {
        const existing = byId.get(h.id);
        if (!existing || (h.at || 0) > (existing.at || 0)) byId.set(h.id, h);
      }
      const merged = [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, HISTORY_CAP);
      set({ history: merged });
      save(LS.history, merged);
      return;
    }
    if (rec.key === 'settings') {
      const server = rec.value && typeof rec.value === 'object' ? rec.value : {};
      const merged = { ...get().settings, ...server };
      // Re-run the epgUrls migration on the merged value (dedupe/trim, drop legacy epgUrl).
      merged.epgUrls = [...new Set(epgSources(merged).map((u) => (u || '').trim()).filter(Boolean))];
      delete merged.epgUrl;
      const changed = JSON.stringify(epgSources(merged)) !== JSON.stringify(epgSources(get().settings)) ||
        (rec.epgSourceRevision != null && rec.epgSourceRevision !== get().epgSourceRevision);
      set({ settings: merged, epgSourceRevision: rec.epgSourceRevision || null });
      save(LS.settings, merged);
      if (changed) { epgEpoch++; set({ epg: null }); void get().loadEpg(); }
    }
  },

  // Combine channels from all ENABLED playlists into the working set. Channel ids
  // are namespaced by playlist so the same id in two files never collides, and a
  // playlist's contentKind ('live'/'radio') overrides per-channel detection.
  _rebuildChannels() {
    if (!canAccess(get().auth)) return;
    const combined = [];
    for (const p of get().playlists) {
      if (p.enabled === false) continue;
      const chans = load(`ro-iptv:channels:${p.id}`, []) || [];
      for (const c of chans) {
        // Re-derive kind with the current classifier (so already-stored channels
        // benefit from improved detection); a playlist's contentKind overrides it.
        const kind = effectiveKind(p.contentKind, c);
        combined.push({ ...c, id: `${p.id}__${c.id}`, playlistId: p.id, kind });
      }
    }
    const current = get().currentChannel;
    const freshCurrent = current ? combined.find((channel) => channel.id === current.id) : null;
    set({ channels: combined, previousChannelId: current && !freshCurrent ? null : get().previousChannelId, currentChannel: freshCurrent ? (current.isCatchup ? current : freshCurrent) : null });
    const last = load(LS.lastChannel, null);
    if (last) {
      const fresh = combined.find((channel) => channel.id === last.id);
      if (fresh) save(LS.lastChannel, fresh); else localStorage.removeItem(LS.lastChannel);
    }
  },

  async setPlaylistEnabled(id, enabled) {
    const record = get().playlists.find((item) => item.id === id);
    if (record) return get()._queuePlaylistChange({ ...record, enabled });
  },

  async setPlaylistKind(id, contentKind) {
    const record = get().playlists.find((item) => item.id === id);
    if (record) return get()._queuePlaylistChange({ ...record, contentKind });
  },

  async refreshPlaylist(id) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    const meta = get().playlists.find((p) => p.id === id);
    if (!meta?.url || get().playlistChanges.some((change) => change.id === id)) return;
    try {
      const channels = await get()._canonicalChannels(id);
      if(!channels)return;
      const data = {channels,count:channels.length};
      if (generation !== sessionGeneration()) return;
      const result = await get()._queuePlaylistChange({ ...meta, identityVersion:3, channelCount: data.count, channels: data.channels }, { refreshContent: true });
      if (generation === sessionGeneration() && result === 'saved') get().setToast('Playlist refreshed');
    } catch (err) {
      if (generation === sessionGeneration()) get().setToast(`Refresh failed: ${err.message || err}`);
    }
  },

  async removePlaylist(id) {
    const record = get().playlists.find((item) => item.id === id);
    if (record) return get()._queuePlaylistChange(record, { type: 'delete' });
  },

  // Background auto-refresh: re-fetch every enabled URL playlist.
  async refreshAllPlaylists() {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    await get()._hydratePlaylists();
    if (generation !== sessionGeneration()) return;
    const urlPlaylists = get().playlists.filter((p) => p.url && p.enabled !== false);
    for (const p of urlPlaylists) {
      if (generation !== sessionGeneration()) return;
      await get().refreshPlaylist(p.id);
    }
  },

  // Destructive: delete every channel of a kind ('live' | 'radio') from all
  // playlists' caches, drop favourites of that kind, and rebuild. Recordings and
  // the server-stored raw .m3u files are intentionally kept.
  clearChannelsOfKind(kind) {
    if (!canAccess(get().auth)) return;
    const purgedIds = new Set();
    const updated = get().playlists.map((p) => {
      const chans = load(`ro-iptv:channels:${p.id}`, []) || [];
      const kept = [];
      for (const c of chans) {
        const eff = effectiveKind(p.contentKind, c);
        if (eff === kind) purgedIds.add(`${p.id}__${c.id}`);
        else kept.push(c);
      }
      save(`ro-iptv:channels:${p.id}`, kept);
      return { ...p, channelCount: kept.length };
    });
    set({ playlists: updated });
    save(LS.playlists, updated);
    updated.forEach((p) => { void get()._queuePlaylistChange({ ...p, channels: load(`ro-iptv:channels:${p.id}`, []) }); });

    // Remove favourites of the deleted channels (the other kind's are preserved).
    const favourites = get().favourites.filter((id) => !purgedIds.has(id));
    set({ favourites });
    save(LS.favourites, favourites);

    // If the currently-playing channel was deleted, stop it.
    if (get().currentChannel && purgedIds.has(get().currentChannel.id)) set({ currentChannel: null });

    get()._rebuildChannels();
    get().setToast(`Deleted all ${kind === 'live' ? 'Live TV' : 'Radio'} channels`);
  },

  // Load the guide. The server merges every configured source and serves the
  // result from its persistent store, so this is one warm request. Older servers
  // (rolling upgrade, or a cached PWA shell talking to one) have no merged
  // endpoint — fall back to fetching and merging the sources here as before.
  async loadEpg() {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    // Explicit saves are acknowledged before any dependent read, including a
    // periodic/manual load that happened to start while a save was pending.
    await settingsCommit.catch(() => {});
    if (generation !== sessionGeneration() || !canAccess(get().auth)) return;
    const urls = epgSources(get().settings);
    const revision = get().epgSourceRevision;
    const key = JSON.stringify([generation, epgEpoch, revision, urls]);
    if (epgFlight?.key === key) return epgFlight.promise;
    const epoch = ++epgEpoch;
    const current = () => generation === sessionGeneration() && epoch === epgEpoch;
    const promise = (async () => {
      set({ epgLoading: true, epgError: null });
      try {
        if (!urls.length && !revision) { if (current()) set({ epg: null }); return; }
        let merged, legacy = false;
        try {
          merged = await api.fetchEpgMerged(revision);
        } catch (err) {
          // Only a genuinely absent endpoint uses the old per-source protocol.
          // Network failures, auth, throttling and server errors never fan out.
          if (err.status !== 404) throw err;
          legacy = true;
          const results = await Promise.allSettled(urls.map((url) => api.fetchEpg(url)));
          if (!current()) return;
          const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
          if (ok.length !== results.length) throw new Error('Some EPG sources failed. Retry loading the guide.');
          merged = ok.length ? mergeGuides(ok) : null;
        }
        if (!current()) return;
        if (revision && !legacy && merged?.sourceRevision !== revision) {
          throw new Error('Guide sources changed. Sync settings and retry.');
        }
        const altNames = await api.epgAltNames().catch(() => ({}));
        if (!current()) return;
        setAltNameIndex(altNames);
        const error = merged?.failedSourceCount ? 'Some EPG sources are unavailable. Check the sources and retry loading the guide.' : null;
        set({ epg: merged, epgError: error });
        if (error) get().setToast(error);
      } catch (err) {
        if (!current()) return;
        const message = `EPG load failed: ${err.message || err}. Retry loading the guide.`;
        set({ epgError: message }); get().setToast(message);
      } finally {
        if (current()) set({ epgLoading: false });
      }
    })();
    epgFlight = { key: JSON.stringify([generation, epoch, revision, urls]), promise };
    try { await promise; } finally { if (epgFlight?.promise === promise) epgFlight = null; }
  },

  // Merge & persist a partial settings patch (used by the single-Save Settings page).
  // Reloads EPG when the source list changes.
  applySettings(partial) {
    if (!canAccess(get().auth)) return Promise.reject(new Error('Sign in to save settings.'));
    const generation = sessionGeneration();
    settingsPending++;
    if (JSON.stringify(epgSources({ ...get().settings, ...partial })) !== JSON.stringify(epgSources(get().settings))) {
      epgEpoch++; set({ epgLoading: false });
    }
    set({ settingsSaving: true, settingsError: null });
    // Cancel a pre-existing debounced settings push; it must not overwrite this
    // explicit save after its acknowledgement. Serialize rapid explicit saves.
    clearTimeout(statePushTimers.settings);
    let sourcesChanged = false;
    const commit = settingsCommit.catch(() => {}).then(async () => {
      if (generation !== sessionGeneration()) throw new Error('Session changed');
      const prev = get().settings;
      const settings = { ...prev, ...partial };
      settings.epgUrls = epgSources(settings); delete settings.epgUrl;
      let record;
      try { record = await api.saveState('settings', settings, load(LS.stateSync, {}).settings || 0); }
      catch (error) { if (generation === sessionGeneration() && error.status === 409) get().recordStateConflict('settings', settings, error.current); throw error; }
      if (generation !== sessionGeneration()) throw new Error('Session changed');
      const confirmed = record.value || settings; // older servers may omit value
      const revision = record.epgSourceRevision || null;
      sourcesChanged = JSON.stringify(epgSources(confirmed)) !== JSON.stringify(epgSources(prev)) ||
        (revision != null && revision !== get().epgSourceRevision);
      if (sourcesChanged) epgEpoch++;
      set({ settings: confirmed, epgSourceRevision: revision, settingsError: null,
        ...(sourcesChanged ? { epg: null } : {}) });
      save(LS.settings, confirmed);
      const shadow = load(LS.stateSync, {});
      if (record.updatedAt) save(LS.stateSync, { ...shadow, settings: record.updatedAt });
      return record;
    });
    settingsCommit = commit;
    return (async () => {
      try {
        const record = await commit;
        if (sourcesChanged) await get().loadEpg();
        return record;
      } catch (err) {
        if (generation === sessionGeneration()) {
          const message = `Settings were not saved: ${err.message || err}. Retry Save.`;
          set({ settingsError: message }); get().setToast(message);
        }
        throw err;
      } finally {
        if (generation === sessionGeneration()) {
          settingsPending--; set({ settingsSaving: settingsPending > 0 });
        }
      }
    })();
  },

  // ---- playback ----
  playChannel(channel) {
    if (!canAccess(get().auth)) return;
    const current = get().channels.find((item) => item.id === channel?.id);
    if ((channel?.playlistId || channel?.id?.includes('__')) && !current) { get().setToast('Channel is no longer available. Sync playlists.'); return; }
    channel = current || channel;
    const previous = get().currentChannel;
    const isTunable = item => item && ['live', 'radio'].includes(item.kind);
    set({ currentChannel: channel,
      previousChannelId: isTunable(channel) && isTunable(previous) && previous.id !== channel.id
        ? previous.id : get().previousChannelId });
    save(LS.lastChannel, channel);
    const entry = { ...channel, at: Date.now() };
    const history = [entry, ...get().history.filter((h) => h.id !== channel.id)].slice(0, HISTORY_CAP);
    set({ history });
    save(LS.history, history);
    pushState('history', history);
  },

  restoreLastChannel() {
    if (!canAccess(get().auth)) return;
    const last = load(LS.lastChannel, null);
    if (last) set({ currentChannel: last });
  },

  // Play a past programme from a catchup-capable channel. Records the live channel
  // in history (keeps the live URL), then swaps in a catchup variant carrying the
  // archive URL so the player streams the archive with F19's seek bar.
  playCatchup(channel, programme) {
    if (!canAccess(get().auth)) return;
    channel = get().channels.find((item) => item.id === channel?.id);
    if (!channel) { get().setToast('Channel is no longer available. Sync playlists.'); return; }
    const endMs = Math.min(Date.parse(programme.stop), Date.now() - CATCHUP_END_MARGIN_MS);
    const url = catchupUrl(channel, Date.parse(programme.start), endMs);
    if (!url) {
      get().setToast('This channel has no usable catchup URL');
      return;
    }
    get().playChannel(channel);
    set({ currentChannel: { ...channel, url, isCatchup: true, catchupTitle: programme.title } });
  },

  // Stop playback entirely (clears the mini-player / current channel).
  stopPlayback() {
    set({ currentChannel: null, previousChannelId: null });
  },

  setPreviousChannelShortcut(key) {
    if (['b', 'p', ''].includes(key)) set({ previousChannelShortcut: key });
  },

  playPreviousChannel() {
    if (!canAccess(get().auth)) return;
    const { currentChannel, previousChannelId, channels, playlists } = get();
    if (!currentChannel || !['live', 'radio'].includes(currentChannel.kind) || !previousChannelId) {
      get().setToast('Play another channel first to use Previous channel.');
      return;
    }
    const previous = channels.find(channel => channel.id === previousChannelId && ['live', 'radio'].includes(channel.kind));
    if (!previous || playlists.some(playlist => playlist.id === previous.playlistId && playlist.enabled === false)) {
      get().setToast('The previous channel is unavailable. Its playlist may be disabled or the channel removed.');
      return;
    }
    get().playChannel(previous);
  },

  // Play the previous/next channel within the current filtered list (anchored to
  // the same kind as what's playing). Used by OS prev/next when off-view.
  _playRelative(dir) {
    const cur = get().currentChannel;
    if (!cur) return;
    const list = selectFilteredChannels(get(), cur.kind);
    if (!list.length) return;
    let idx = list.findIndex((c) => c.id === cur.id);
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    const nextIdx = (idx + dir + list.length) % list.length;
    get().playChannel(list[nextIdx]);
  },
  playNext() {
    get()._playRelative(1);
  },
  playPrev() {
    get()._playRelative(-1);
  },

  toggleFavourite(channelId) {
    if (!canAccess(get().auth)) return;
    const fav = get().favourites;
    const next = fav.includes(channelId) ? fav.filter((f) => f !== channelId) : [...fav, channelId];
    set({ favourites: next });
    save(LS.favourites, next);
    pushState('favourites', next);
  },

  clearHistory() {
    if (!canAccess(get().auth)) return;
    set({ history: [] });
    save(LS.history, []);
    pushState('history', []);
  },

  // ---- recordings ----
  cancelRecordingsRefresh() {
    recordingsEpoch++;
    recordingsFlight?.controller.abort();
    recordingsFlight = null;
  },

  loadRecordings() {
    if (!canAccess(get().auth)) return Promise.resolve();
    const generation = sessionGeneration();
    if (recordingsFlight?.generation === generation) return recordingsFlight.promise;
    const controller = new AbortController(), epoch = recordingsEpoch;
    const flight = { generation, controller, promise: null };
    const timeout = setTimeout(() => controller.abort(), 10000);
    recordingsFlight = flight;
    flight.promise = (async () => {
      try {
        const recordings = await api.listRecordings({ signal: controller.signal });
        if (!Array.isArray(recordings) || controller.signal.aborted || generation !== sessionGeneration() || epoch !== recordingsEpoch || !canAccess(get().auth)) return;
        set({ recordings });
      } catch { /* Keep the last known state while offline; the owner retries. */ }
      finally {
        clearTimeout(timeout); controller.abort();
        if (recordingsFlight === flight) recordingsFlight = null;
      }
    })();
    return flight.promise;
  },

  async scheduleRecording(rec) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    try {
      const saved = await api.saveRecording(rec);
      if (generation !== sessionGeneration()) return;
      get().cancelRecordingsRefresh();
      set({ recordings: [...get().recordings.filter((r) => r.id !== saved.id), saved] });
      get().setToast('Recording scheduled');
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      get().setToast(`Could not schedule: ${err.message || err}`);
    }
  },

  // Start capturing the given channel "now" to a file on the server.
  async startRecording(channel, programme, minutes) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    if (!channel) return;
    try {
      const saved = await api.startRecording({
        channelId: channel.id,
        channelTvgId: channel.tvgId || '', channelNumber: channel.chno ?? null,
        channelName: channel.name,
        channelLogo: channel.logo,
        url: channel.url,
        title: programme?.title || channel.name,
        httpUserAgent: channel.httpUserAgent || '',
        httpReferrer: channel.httpReferrer || '',
        durationMinutes: minutes || undefined,
      });
      if (generation !== sessionGeneration()) return;
      get().cancelRecordingsRefresh();
      set({ recordings: [...get().recordings.filter((r) => r.id !== saved.id), saved] });
      get().setToast('Recording started');
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      get().setToast(`Could not start recording: ${err.message || err}`);
    }
  },

  // Stop an in-progress capture. The server finalises the file; refresh shortly after.
  async stopRecording(id) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    try {
      await api.stopRecording(id);
      if (generation !== sessionGeneration()) return;
      get().cancelRecordingsRefresh();
      get().setToast('Recording stopped');
      // Give ffmpeg a moment to finalise the MP4, then pull the final size/status.
      sessionTimeout(() => { if (generation === sessionGeneration()) get().loadRecordings(); }, 2500);
      get().loadRecordings();
    } catch (err) {
      if (generation !== sessionGeneration()) return;
      get().setToast(`Could not stop recording: ${err.message || err}`);
    }
  },


  async removeRecording(id) {
    if (!canAccess(get().auth)) return;
    const generation = sessionGeneration();
    try {
      await api.deleteRecording(id);
      if (generation !== sessionGeneration()) return;
    } catch {
      if (generation !== sessionGeneration()) return;
      /* ignore */
    }
    get().cancelRecordingsRefresh();
    set({ recordings: get().recordings.filter((r) => r.id !== id) });
  },
}));

// ---- selectors (computed helpers) ----

// Country scope applies to the Live "browse" panels (channels/epg/categories),
// not to the cross-cutting Favourites/History collections.
const BROWSE_PANELS = new Set(['channels', 'epg', 'categories', 'catchup']);

export function isCountryScoped(state, kind) {
  return state.selectedCountry != null && state.selectedCountry !== '*' &&
    (kind === 'radio' || (kind === 'live' && BROWSE_PANELS.has(state.sidebarPanel)));
}

export function selectFilteredChannels(state, kind) {
  // OS/media controls may navigate the playing kind while another view is open.
  // Use that kind's saved scope instead of the currently browsed kind's filters.
  if (kind && state.view && state.view !== kind) state = { ...state,
    ...(state.browseScopes?.[kind] || { sidebarPanel: 'channels', selectedCountry: null, activeCategory: 'All', search: '' }) };
  let list = state.channels;
  if (kind) list = list.filter((c) => c.kind === kind);
  if (isCountryScoped(state, kind)) list = list.filter((c) => channelCountry(c) === state.selectedCountry);
  if (state.sidebarPanel === 'favourites') list = list.filter((c) => state.favourites.includes(c.id));
  if (state.activeCategory && state.activeCategory !== 'All') {
    list = list.filter((c) => channelCategories(c).includes(state.activeCategory));
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter((c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }
  return list;
}

// Category chips for a given channel list (group-title may be ";"-joined).
export function selectCategoriesFor(channels) {
  const map = new Map();
  for (const c of channels) {
    for (const cat of channelCategories(c)) map.set(cat, (map.get(cat) || 0) + 1);
  }
  return [['All', channels.length], ...[...map.entries()].sort((a, b) => b[1] - a[1])];
}

// Countries present for a kind → [[code, count], …] sorted A→Z by country name
// (the "Undefined" bucket is always last).
export function selectCountries(state, kind) {
  let list = state.channels;
  if (kind) list = list.filter((c) => c.kind === kind);
  const map = new Map();
  for (const c of list) {
    const cc = channelCountry(c);
    map.set(cc, (map.get(cc) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => {
    if (!a[0]) return 1; // Undefined → end
    if (!b[0]) return -1;
    return countryName(a[0]).localeCompare(countryName(b[0]));
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if ((event.key === LOCAL_LOCK_KEY && event.newValue === '1') ||
        (event.key === AUTH_MODE_KEY && event.newValue === 'required')) {
      // Do not echo the event back: the initiating tab may already be signing
      // in with the new account/password while this tab clears its old state.
      void useStore.getState()._lock('Session changed in another tab. Sign in again.', false);
    }
  });
}
