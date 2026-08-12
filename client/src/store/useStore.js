import { create } from 'zustand';
import { api, setUnauthorizedHandler } from '../lib/api';
import { parseM3U, effectiveKind, channelId } from '../lib/m3u';
import { uid } from '../lib/uid';
import { channelCountry, channelCategories, countryName } from '../lib/country';
import { catchupUrl } from '../lib/catchup';

// Configured EPG source URLs (migrates the legacy single `epgUrl`).
export function epgSources(settings = {}) {
  const list = Array.isArray(settings.epgUrls) ? settings.epgUrls : [];
  const urls = [...list, settings.epgUrl].map((u) => (u || '').trim()).filter(Boolean);
  return [...new Set(urls)];
}

// Merge several parsed EPG guides into one { channels, programmes } structure.
function mergeEpg(guides) {
  const channels = {};
  const programmes = {};
  for (const g of guides) {
    Object.assign(channels, g.channels || {});
    for (const [id, progs] of Object.entries(g.programmes || {})) {
      programmes[id] = (programmes[id] || []).concat(progs);
    }
  }
  for (const id of Object.keys(programmes)) {
    programmes[id].sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  return { channels, programmes };
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
  favourites: 'ro-iptv:favourites',
  history: 'ro-iptv:history',
  lastChannel: 'ro-iptv:lastChannel',
  activePlaylist: 'ro-iptv:activePlaylist',
  settings: 'ro-iptv:settings',
  idv2: 'ro-iptv:idv2', // one-shot flag: channel ids migrated to content-derived v2
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
function pushState(key, value) {
  clearTimeout(statePushTimers[key]);
  statePushTimers[key] = setTimeout(() => api.saveState(key, value).catch(() => {}), STATE_PUSH_DEBOUNCE_MS);
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
  } catch {
    /* quota / private mode */
  }
}

// Last-played channel as persisted by playChannel() (null on fresh profiles).
export function loadLastChannel() {
  return load(LS.lastChannel, null);
}

export const useStore = create((set, get) => ({
  // ---- data ----
  playlists: load(LS.playlists, []), // [{id,name,url,type,channelCount,updatedAt,enabled,contentKind}]
  channels: [], // combined channels from all ENABLED playlists (kind-routed)
  epg: null, // {channels, programmes}
  favourites: load(LS.favourites, []), // [channelId]
  history: load(LS.history, []), // [{id,name,logo,url,kind,at}]
  recordings: [],
  settings: load(LS.settings, { epgUrls: [], refreshIntervalMinutes: 360, defaultCountry: '', recordingPadding: { before: 1, after: 5 } }),
  epgLoading: false,

  // ---- ui ----
  view: 'home', // home | live | radio | recordings | settings
  sidebarPanel: 'channels', // channels | favourites | history | epg | categories | catchup
  selectedCountry: null, // null = country browser (grid); '' = Undefined bucket; code = a country
  activeCategory: 'All',
  search: '',
  currentChannel: null,
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
    const patch = { view, search: '' };
    // Entering Live TV opens at the user's default country (or the country grid).
    if (view === 'live') {
      patch.selectedCountry = get().settings.defaultCountry || null;
      patch.sidebarPanel = 'channels';
      patch.activeCategory = 'All';
    }
    set(patch);
  },
  setSidebarPanel: (sidebarPanel) => set({ sidebarPanel }),
  setSelectedCountry: (selectedCountry) => set({ selectedCountry, activeCategory: 'All' }),
  setCategory: (activeCategory) => set({ activeCategory }),
  setSearch: (search) => set({ search }),
  setToast: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => get().toast === toast && set({ toast: null }), 3200);
  },

  // Ask the server whether auth is required and whether we're already signed in.
  // A 401 from any guarded call later flips us back to the login screen.
  async checkAuth() {
    setUnauthorizedHandler(() => {
      const a = get().auth;
      if (a.authed) set({ auth: { ...a, authed: false } });
    });
    try {
      const s = await api.authStatus();
      const auth = {
        checked: true,
        required: !!s.authRequired,
        authed: !!s.authed,
        mustChange: !!s.mustChange,
        username: s.username || '',
      };
      set({ auth });
      return auth;
    } catch {
      // Status unreachable (e.g. offline). Don't trap the user: assume open so
      // the cached shell still loads; guarded calls will 401 if it's not.
      const auth = { checked: true, required: false, authed: true, mustChange: false, username: '' };
      set({ auth });
      return auth;
    }
  },

  async login(username, password, remember) {
    const s = await api.login(username, password, remember);
    set({
      auth: { checked: true, required: true, authed: true, mustChange: !!s.mustChange, username: s.username || username },
    });
    // Forced first-login change must happen before loading the app.
    if (!s.mustChange) await get().init();
  },

  async changePassword(newPassword, remember) {
    const s = await api.changePassword(newPassword, remember);
    set({ auth: { ...get().auth, mustChange: false, authed: true, username: s.username || get().auth.username } });
    await get().init();
  },

  // Voluntary change from Settings — requires the current password; the server
  // re-issues the session cookie, so no reload is needed.
  async updatePassword(currentPassword, newPassword) {
    await api.changePassword(newPassword, true, currentPassword);
  },

  async logout() {
    await api.logout();
    get().stopPlayback?.();
    set({ auth: { ...get().auth, authed: false, mustChange: false }, currentChannel: null });
  },

  async init() {
    set({ loading: true });
    try {
      const cfg = await api.config().catch(() => ({}));
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

      // Same guarantee for favourites / history / settings.
      await get()._syncState();

      // Auto-load a server-configured M3U_URL playlist on first run.
      const playlists = get().playlists;
      if (cfg.m3uUrl && !playlists.some((p) => p.url === cfg.m3uUrl)) {
        await get().addPlaylistFromUrl(cfg.m3uUrl, 'Server Playlist', { silent: true });
      }

      get()._rebuildChannels();

      get().loadRecordings();
      get().loadEpg();
    } catch (err) {
      set({ error: String(err.message || err) });
    } finally {
      set({ loading: false });
    }
  },

  async addPlaylistFromUrl(url, name, { silent } = {}) {
    set({ loading: true, error: null });
    try {
      const data = await api.fetchPlaylistFromUrl(url);
      const record = {
        id: uid(),
        name: name || url.split('/').pop() || 'Playlist',
        url,
        type: 'url',
        channelCount: data.count,
        updatedAt: new Date().toISOString(),
        enabled: true,
        contentKind: autoContentKind(data.channels, name),
        channels: data.channels,
      };
      get()._persistPlaylist(record);
      get()._rebuildChannels();
      if (!silent) get().setToast(`Loaded ${data.count} channels`);
      return record;
    } catch (err) {
      set({ error: String(err.message || err) });
      if (!silent) get().setToast(`Failed: ${err.message || err}`);
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  async addPlaylistFromText(text, name) {
    set({ loading: true, error: null });
    try {
      const channels = parseM3U(text);
      const record = {
        id: uid(),
        name: name || 'Uploaded Playlist',
        url: '',
        type: 'file',
        channelCount: channels.length,
        updatedAt: new Date().toISOString(),
        enabled: true,
        contentKind: autoContentKind(channels, name),
        channels,
      };
      get()._persistPlaylist(record);
      // Store the raw uploaded file server-side so it can be downloaded later.
      api.savePlaylistFile(record.id, text).catch(() => {});
      get()._rebuildChannels();
      get().setToast(`Loaded ${channels.length} channels`);
      return record;
    } catch (err) {
      set({ error: String(err.message || err) });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  _persistPlaylist(record) {
    // Store channels separately (can be large) keyed by playlist id.
    save(`ro-iptv:channels:${record.id}`, record.channels || []);
    const meta = { ...record };
    delete meta.channels;
    const playlists = [...get().playlists.filter((p) => p.id !== record.id), meta];
    set({ playlists });
    save(LS.playlists, playlists);
    // best-effort server-side persistence
    api.savePlaylist(meta).catch(() => {});
  },

  // Merge server-side playlists into local state and reconstruct any channels
  // that aren't cached on this origin (URL playlists re-fetch; uploaded files
  // re-parse from their stored .m3u). Makes the app work across origins/devices.
  async _hydratePlaylists() {
    let server = [];
    try {
      server = await api.listPlaylists();
    } catch {
      return; // offline / no backend — keep local only
    }
    const byId = new Map(get().playlists.map((p) => [p.id, p]));
    for (const sp of server) byId.set(sp.id, { ...byId.get(sp.id), ...sp });
    const merged = [...byId.values()];

    for (const p of merged) {
      const cached = load(`ro-iptv:channels:${p.id}`, null);
      if (cached && cached.length) continue;
      let channels = null;
      try {
        if (p.url) {
          channels = (await api.fetchPlaylistFromUrl(p.url)).channels;
        } else if (p.hasFile) {
          const res = await fetch(`/api/playlists/${p.id}/file`);
          if (res.ok) channels = parseM3U(await res.text());
        }
      } catch {
        /* skip this one */
      }
      if (channels && channels.length) save(`ro-iptv:channels:${p.id}`, channels);
    }

    set({ playlists: merged });
    save(LS.playlists, merged);
  },

  // Pull server-synced favourites/history/settings and merge into local. A per-key
  // shadow of the last-applied updatedAt skips records we've already seen (incl. our
  // own writes echoed back). Offline / no backend keeps local state untouched.
  async _syncState() {
    let records;
    try {
      records = await api.listState();
    } catch {
      return;
    }
    const shadow = load(LS.stateSync, {});
    const nextShadow = { ...shadow };
    for (const rec of records) {
      if (!SYNCED_STATE_KEYS.includes(rec.key)) continue;
      if (shadow[rec.key] && shadow[rec.key] >= rec.updatedAt) continue;
      get()._applyStateRecord(rec, !shadow[rec.key]);
      nextShadow[rec.key] = rec.updatedAt;
    }
    save(LS.stateSync, nextShadow);
  },

  // Merge one synced record into local state per its key's policy.
  _applyStateRecord(rec, firstSync) {
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
      set({ settings: merged });
      save(LS.settings, merged);
    }
  },

  // One-shot migration: legacy channel ids embedded the playlist index
  // (`${idx}-name`), so any upstream reorder detached favourites/history. Rewrite
  // cached channels to the content-derived v2 id and remap favourites/history.
  // Covers both stale caches (legacy ids still stored) and refreshed caches
  // (already v2 — the legacy id is recomputed from the index to find the mapping).
  _migrateChannelIds() {
    if (localStorage.getItem(LS.idv2)) return;
    const idRemap = new Map();
    for (const p of get().playlists) {
      const cacheKey = `ro-iptv:channels:${p.id}`;
      const chans = load(cacheKey, []) || [];
      const seen = new Map();
      let rewritten = false;
      chans.forEach((c, i) => {
        const legacyId = `${i}-${c.tvgId || c.name}`.replace(/[^a-zA-Z0-9-_]/g, '_');
        if (c.id === legacyId) {
          c.id = channelId(c, seen);
          rewritten = true;
        }
        idRemap.set(`${p.id}__${legacyId}`, `${p.id}__${c.id}`);
      });
      if (rewritten) save(cacheKey, chans);
    }
    if (idRemap.size) {
      const favourites = get().favourites.map((f) => idRemap.get(f) || f);
      const history = get().history.map((h) => (idRemap.has(h.id) ? { ...h, id: idRemap.get(h.id) } : h));
      set({ favourites, history });
      save(LS.favourites, favourites);
      save(LS.history, history);
    }
    localStorage.setItem(LS.idv2, '1');
  },

  // Combine channels from all ENABLED playlists into the working set. Channel ids
  // are namespaced by playlist so the same id in two files never collides, and a
  // playlist's contentKind ('live'/'radio') overrides per-channel detection.
  _rebuildChannels() {
    get()._migrateChannelIds();
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
    set({ channels: combined });
  },

  setPlaylistEnabled(id, enabled) {
    const playlists = get().playlists.map((p) => (p.id === id ? { ...p, enabled } : p));
    set({ playlists });
    save(LS.playlists, playlists);
    api.savePlaylist({ ...playlists.find((p) => p.id === id) }).catch(() => {});
    get()._rebuildChannels();
  },

  setPlaylistKind(id, contentKind) {
    const playlists = get().playlists.map((p) => (p.id === id ? { ...p, contentKind } : p));
    set({ playlists });
    save(LS.playlists, playlists);
    api.savePlaylist({ ...playlists.find((p) => p.id === id) }).catch(() => {});
    get()._rebuildChannels();
  },

  async refreshPlaylist(id) {
    const meta = get().playlists.find((p) => p.id === id);
    if (!meta || !meta.url) return;
    try {
      const data = await api.fetchPlaylistFromUrl(meta.url);
      get()._persistPlaylist({ ...meta, channelCount: data.count, updatedAt: new Date().toISOString(), channels: data.channels });
      get()._rebuildChannels();
      get().setToast('Playlist refreshed');
    } catch (err) {
      get().setToast(`Refresh failed: ${err.message || err}`);
    }
  },

  removePlaylist(id) {
    const playlists = get().playlists.filter((p) => p.id !== id);
    set({ playlists });
    save(LS.playlists, playlists);
    localStorage.removeItem(`ro-iptv:channels:${id}`);
    api.deletePlaylist(id).catch(() => {});
    get()._rebuildChannels();
  },

  // Background auto-refresh: re-fetch every enabled URL playlist.
  async refreshAllPlaylists() {
    const urlPlaylists = get().playlists.filter((p) => p.url && p.enabled !== false);
    for (const p of urlPlaylists) await get().refreshPlaylist(p.id);
  },

  // Destructive: delete every channel of a kind ('live' | 'radio') from all
  // playlists' caches, drop favourites of that kind, and rebuild. Recordings and
  // the server-stored raw .m3u files are intentionally kept.
  clearChannelsOfKind(kind) {
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
    updated.forEach((p) => api.savePlaylist({ ...p }).catch(() => {}));

    // Remove favourites of the deleted channels (the other kind's are preserved).
    const favourites = get().favourites.filter((id) => !purgedIds.has(id));
    set({ favourites });
    save(LS.favourites, favourites);

    // If the currently-playing channel was deleted, stop it.
    if (get().currentChannel && purgedIds.has(get().currentChannel.id)) set({ currentChannel: null });

    get()._rebuildChannels();
    get().setToast(`Deleted all ${kind === 'live' ? 'Live TV' : 'Radio'} channels`);
  },

  // Fetch every configured EPG source and merge them (iptv-org/epg is grabbed
  // per-site, so several guides are normal). Channels are keyed by xmltv_id.
  async loadEpg() {
    const urls = epgSources(get().settings);
    if (!urls.length) {
      set({ epg: null });
      return;
    }
    set({ epgLoading: true });
    try {
      const results = await Promise.allSettled(urls.map((u) => api.fetchEpg(u)));
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failed = results.length - ok.length;
      set({ epg: ok.length ? mergeEpg(ok) : null });
      if (failed) get().setToast(`${failed} of ${urls.length} EPG source(s) failed to load`);
    } catch (err) {
      get().setToast(`EPG load failed: ${err.message || err}`);
    } finally {
      set({ epgLoading: false });
    }
  },

  // Merge & persist a partial settings patch (used by the single-Save Settings page).
  // Reloads EPG when the source list changes.
  applySettings(partial) {
    const prev = get().settings;
    const settings = { ...prev, ...partial };
    set({ settings });
    save(LS.settings, settings);
    pushState('settings', settings);
    if ('epgUrls' in partial && JSON.stringify(partial.epgUrls) !== JSON.stringify(epgSources(prev))) {
      get().loadEpg();
    }
  },

  // ---- playback ----
  playChannel(channel) {
    set({ currentChannel: channel });
    save(LS.lastChannel, channel);
    const entry = { ...channel, at: Date.now() };
    const history = [entry, ...get().history.filter((h) => h.id !== channel.id)].slice(0, HISTORY_CAP);
    set({ history });
    save(LS.history, history);
    pushState('history', history);
  },

  restoreLastChannel() {
    const last = load(LS.lastChannel, null);
    if (last) set({ currentChannel: last });
  },

  // Play a past programme from a catchup-capable channel. Records the live channel
  // in history (keeps the live URL), then swaps in a catchup variant carrying the
  // archive URL so the player streams the archive with F19's seek bar.
  playCatchup(channel, programme) {
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
    set({ currentChannel: null });
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
    const fav = get().favourites;
    const next = fav.includes(channelId) ? fav.filter((f) => f !== channelId) : [...fav, channelId];
    set({ favourites: next });
    save(LS.favourites, next);
    pushState('favourites', next);
  },

  clearHistory() {
    set({ history: [] });
    save(LS.history, []);
    pushState('history', []);
  },

  // ---- recordings ----
  async loadRecordings() {
    try {
      const recordings = await api.listRecordings();
      set({ recordings });
    } catch {
      /* offline */
    }
  },

  async scheduleRecording(rec) {
    try {
      const saved = await api.saveRecording(rec);
      set({ recordings: [...get().recordings.filter((r) => r.id !== saved.id), saved] });
      get().setToast('Recording scheduled');
    } catch (err) {
      get().setToast(`Could not schedule: ${err.message || err}`);
    }
  },

  // Start capturing the given channel "now" to a file on the server.
  async startRecording(channel, programme, minutes) {
    if (!channel) return;
    try {
      const saved = await api.startRecording({
        channelId: channel.id,
        channelName: channel.name,
        channelLogo: channel.logo,
        url: channel.url,
        title: programme?.title || channel.name,
        httpUserAgent: channel.httpUserAgent || '',
        httpReferrer: channel.httpReferrer || '',
        durationMinutes: minutes || undefined,
      });
      set({ recordings: [...get().recordings.filter((r) => r.id !== saved.id), saved] });
      get().setToast('Recording started');
    } catch (err) {
      get().setToast(`Could not start recording: ${err.message || err}`);
    }
  },

  // Stop an in-progress capture. The server finalises the file; refresh shortly after.
  async stopRecording(id) {
    try {
      await api.stopRecording(id);
      get().setToast('Recording stopped');
      // Give ffmpeg a moment to finalise the MP4, then pull the final size/status.
      setTimeout(() => get().loadRecordings(), 2500);
      get().loadRecordings();
    } catch (err) {
      get().setToast(`Could not stop recording: ${err.message || err}`);
    }
  },


  async removeRecording(id) {
    try {
      await api.deleteRecording(id);
    } catch {
      /* ignore */
    }
    set({ recordings: get().recordings.filter((r) => r.id !== id) });
  },
}));

// ---- selectors (computed helpers) ----

// Country scope applies to the Live "browse" panels (channels/epg/categories),
// not to the cross-cutting Favourites/History collections.
const BROWSE_PANELS = new Set(['channels', 'epg', 'categories', 'catchup']);

export function isCountryScoped(state, kind) {
  return kind === 'live' && state.selectedCountry !== null && BROWSE_PANELS.has(state.sidebarPanel);
}

export function selectFilteredChannels(state, kind) {
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
