import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, selectCountries, epgSources } from '../store/useStore';
import { countryFlag, countryName } from '../lib/country';
import { channelsToM3U, downloadText } from '../lib/exportM3U';
import { api, playlistDownloadUrl } from '../lib/api';
import Icon from '../components/Icon';
import ConfirmButton from '../components/ConfirmButton';
import PasswordSettings from '../components/PasswordSettings';
import EpgSuggestions, { MatchSummary } from '../components/EpgSuggestions';
import EpgCoverage from '../components/EpgCoverage';

function loadChannels(id) {
  try {
    return JSON.parse(localStorage.getItem(`ro-iptv:channels:${id}`)) || [];
  } catch {
    return [];
  }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

const REFRESH_OPTIONS = [
  [0, 'Disabled'],
  [60, 'Every hour'],
  [360, 'Every 6 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Every 24 hours'],
];

// Pre/post padding options (minutes) for EPG-scheduled recordings.
const PADDING_OPTIONS = [0, 1, 2, 5, 10, 15];
const DEFAULT_PADDING = { before: 1, after: 5 };
const paddingLabel = (m) => (m === 0 ? 'Off' : `${m} min`);

// Full-page Settings with a draft model: every *field* edit is staged locally and
// only committed when the single Save button is pressed. Playlist add/delete/refresh
// remain immediate data actions (with their own buttons), not draftable fields.
export default function SettingsPage() {
  const playlists = useStore((s) => s.playlists);
  const settings = useStore((s) => s.settings);
  const loading = useStore((s) => s.loading);
  const channels = useStore((s) => s.channels);

  // Countries available across the loaded channels (for the default-country picker).
  const countries = useMemo(() => selectCountries({ channels }, 'live'), [channels]);

  const addPlaylistFromUrl = useStore((s) => s.addPlaylistFromUrl);
  const addPlaylistFromText = useStore((s) => s.addPlaylistFromText);
  const removePlaylist = useStore((s) => s.removePlaylist);
  const refreshPlaylist = useStore((s) => s.refreshPlaylist);
  const setPlaylistEnabled = useStore((s) => s.setPlaylistEnabled);
  const setPlaylistKind = useStore((s) => s.setPlaylistKind);
  const clearChannelsOfKind = useStore((s) => s.clearChannelsOfKind);
  const applySettings = useStore((s) => s.applySettings);

  const liveCount = useMemo(() => channels.filter((c) => c.kind === 'live').length, [channels]);
  const radioCount = useMemo(() => channels.filter((c) => c.kind === 'radio').length, [channels]);
  const setToast = useStore((s) => s.setToast);
  const setView = useStore((s) => s.setView);

  // ---- committed snapshot the draft is diffed against ----
  const committed = {
    epgUrls: epgSources(settings),
    refreshIntervalMinutes: settings.refreshIntervalMinutes ?? 360,
    defaultCountry: settings.defaultCountry || '',
    recordingPadding: settings.recordingPadding || DEFAULT_PADDING,
  };

  const [draft, setDraft] = useState(committed);
  const [addUrl, setAddUrl] = useState('');
  const [addName, setAddName] = useState('');
  const [epgInput, setEpgInput] = useState('');
  const [epgCheck, setEpgCheck] = useState(null);
  const [epgChecking, setEpgChecking] = useState(false);
  const fileRef = useRef(null);

  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const addEpgSource = (url) => {
    const u = (url ?? epgInput).trim();
    if (!u || draft.epgUrls.includes(u)) return;
    setField('epgUrls', [...draft.epgUrls, u]);
    if (url === undefined) setEpgInput('');
    setEpgCheck(null);
  };
  const removeEpgSource = (u) => setField('epgUrls', draft.epgUrls.filter((x) => x !== u));

  // Check a pasted URL the same way a suggested one is checked, so a typo or a
  // guide that covers nothing shows up here rather than in the Live EPG panel
  // hours later. The source is still addable either way — a guide for channels
  // not added yet is legitimate.
  const checkEpgSource = async () => {
    const u = epgInput.trim();
    if (!u) return;
    setEpgChecking(true);
    setEpgCheck(null);
    try {
      setEpgCheck(await api.validateEpg(u));
    } catch (err) {
      setEpgCheck({ ok: false, error: err.message || String(err) });
    } finally {
      setEpgChecking(false);
    }
  };

  const dirty =
    JSON.stringify(draft.epgUrls) !== JSON.stringify(committed.epgUrls) ||
    draft.refreshIntervalMinutes !== committed.refreshIntervalMinutes ||
    draft.defaultCountry !== committed.defaultCountry ||
    JSON.stringify(draft.recordingPadding) !== JSON.stringify(committed.recordingPadding);

  // Warn on tab-close / refresh while there are unsaved field changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const onSave = () => {
    applySettings({
      epgUrls: draft.epgUrls,
      refreshIntervalMinutes: draft.refreshIntervalMinutes,
      defaultCountry: draft.defaultCountry,
      recordingPadding: draft.recordingPadding,
    });
    setToast('Settings saved');
  };

  // Download a playlist: the stored raw upload if present, else reconstruct from channels.
  const onDownload = (p) => {
    if (p.hasFile) {
      window.open(playlistDownloadUrl(p.id), '_blank');
      return;
    }
    const chans = loadChannels(p.id);
    downloadText(`${(p.name || 'playlist').replace(/[^a-zA-Z0-9-_ ]/g, '_')}.m3u`, channelsToM3U(chans));
  };

  const onDiscard = () => setDraft(committed);

  // ---- immediate data actions ----
  const onAddUrl = async () => {
    if (!addUrl.trim()) return;
    try {
      await addPlaylistFromUrl(addUrl.trim(), addName.trim() || undefined);
      setAddUrl('');
      setAddName('');
    } catch {
      /* toast shown by store */
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await addPlaylistFromText(text, file.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  };

  return (
    <div className="pt-24 md:pt-28 px-4 md:px-8 pb-28 min-h-screen">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('home')}
            className="text-on-surface-variant hover:text-on-surface"
            aria-label="Back to home"
          >
            <Icon name="arrow_back" className="text-2xl" />
          </button>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Icon name="settings" className="text-primary" /> Settings
          </h1>
        </div>

        {/* Playlists (immediate actions) */}
        <section className="glass rounded-2xl p-5 md:p-6">
          <h2 className="text-lg font-semibold text-primary mb-1">Playlists</h2>
          <p className="text-sm text-on-surface-variant mb-4">
            Add or remove playlists. Enabled playlists are combined; set each to show under Live TV or Radio.
          </p>

          <div className="flex flex-col gap-3 mb-5">
            <label className="sr-only" htmlFor="pl-name">Playlist name</label>
            <input
              id="pl-name"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Playlist name (optional)"
              className="glass rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="pl-url">Playlist URL</label>
              <input
                id="pl-url"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onAddUrl()}
                placeholder="https://example.com/playlist.m3u"
                className="flex-1 glass rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={onAddUrl}
                disabled={loading}
                className="bg-primary text-on-primary px-5 rounded-xl font-medium hover:scale-105 transition-transform disabled:opacity-50"
              >
                {loading ? '…' : 'Add'}
              </button>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="glass rounded-xl px-4 py-3 flex items-center justify-center gap-2 hover:bg-white/10"
            >
              <Icon name="upload_file" /> Upload .m3u / .m3u8 file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegurl"
              hidden
              onChange={onFile}
            />
          </div>

          {playlists.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No playlists yet — add one above.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {playlists.map((p) => {
                const enabled = p.enabled !== false;
                return (
                  <div key={p.id} className="glass rounded-xl p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      {/* Enable toggle — included in the combined channel set */}
                      <button
                        onClick={() => setPlaylistEnabled(p.id, !enabled)}
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? 'Disable' : 'Enable'} ${p.name}`}
                        className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${enabled ? 'bg-primary' : 'bg-surface-variant'}`}
                      >
                        <span
                          className={`block w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`}
                        />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`font-medium truncate ${enabled ? '' : 'text-on-surface-variant'}`}>{p.name}</p>
                        <p className="text-xs text-on-surface-variant truncate">
                          {p.channelCount} channels • {p.type} • updated {timeAgo(p.updatedAt)}
                        </p>
                      </div>
                      <button onClick={() => onDownload(p)} title="Download playlist" className="text-on-surface-variant hover:text-primary">
                        <Icon name="download" />
                      </button>
                      {p.url && (
                        <button onClick={() => refreshPlaylist(p.id)} title="Refresh now" className="text-on-surface-variant hover:text-primary">
                          <Icon name="sync" />
                        </button>
                      )}
                      <button onClick={() => removePlaylist(p.id)} title="Delete playlist" className="text-on-surface-variant hover:text-error">
                        <Icon name="delete" />
                      </button>
                    </div>
                    {/* Content type — route this playlist's channels to Live TV or Radio */}
                    <div className="flex items-center gap-2 pl-[52px]">
                      <label className="text-xs text-on-surface-variant" htmlFor={`kind-${p.id}`}>Show under</label>
                      <select
                        id={`kind-${p.id}`}
                        value={p.contentKind || 'auto'}
                        onChange={(e) => setPlaylistKind(p.id, e.target.value)}
                        className="glass rounded-lg px-2 py-1 text-xs outline-none"
                      >
                        <option value="auto">Auto-detect</option>
                        <option value="live">Live TV</option>
                        <option value="radio">Radio</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Preferences (single-Save fields) */}
        <section className="glass rounded-2xl p-5 md:p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold text-primary mb-1">EPG sources (XMLTV)</h2>
            <p className="text-sm text-on-surface-variant mb-3">
              Programme guide and Now/Next labels are pulled from these XMLTV guides. Add one or more —
              plain <code>.xml</code> or gzipped <code>.xml.gz</code>. Guides are matched to channels by
              their <code>tvg-id</code> (xmltv_id). Generate guides with{' '}
              <a href="https://github.com/iptv-org/epg" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                iptv-org/epg
              </a>{' '}
              (e.g. self-host → <code>http://your-host:3000/guide.xml</code>).
            </p>

            <EpgSuggestions epgUrls={draft.epgUrls} onAdd={addEpgSource} />

            <div className="flex flex-wrap gap-2 mb-1">
              <label className="sr-only" htmlFor="epg-url">EPG guide URL</label>
              <input
                id="epg-url"
                value={epgInput}
                onChange={(e) => {
                  setEpgInput(e.target.value);
                  setEpgCheck(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEpgSource())}
                placeholder="https://example.com/guide.xml.gz"
                className="flex-1 min-w-0 glass rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={checkEpgSource}
                disabled={epgChecking || !epgInput.trim()}
                className="glass px-5 py-3 rounded-xl font-medium hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                {epgChecking ? 'Checking…' : 'Check'}
              </button>
              <button
                onClick={() => addEpgSource()}
                className="bg-primary text-on-primary px-5 rounded-xl font-medium hover:scale-105 transition-transform"
              >
                Add
              </button>
            </div>
            {epgCheck && (
              <div className="mb-3">
                <MatchSummary result={epgCheck} />
              </div>
            )}
            {!epgCheck && <div className="mb-3" />}

            {draft.epgUrls.length === 0 ? (
              <p className="text-sm text-on-surface-variant">No EPG sources yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {draft.epgUrls.map((u) => (
                  <li key={u} className="glass rounded-xl px-3 py-2.5 flex items-center gap-3">
                    <Icon name="calendar_month" className="text-primary shrink-0" />
                    <span className="flex-1 min-w-0 text-sm font-mono truncate" title={u}>{u}</span>
                    <button
                      onClick={() => removeEpgSource(u)}
                      aria-label={`Remove ${u}`}
                      className="text-on-surface-variant hover:text-error shrink-0"
                    >
                      <Icon name="delete" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <EpgCoverage />

          <div>
            <h2 className="text-lg font-semibold text-primary mb-1">Default country for Live TV</h2>
            <p className="text-sm text-on-surface-variant mb-3">
              Live TV opens straight to this country. Choose “Show country list” to always start at the country browser.
            </p>
            <label className="sr-only" htmlFor="default-country">Default country</label>
            <select
              id="default-country"
              value={draft.defaultCountry}
              onChange={(e) => setField('defaultCountry', e.target.value)}
              className="glass rounded-xl px-4 py-3 outline-none w-full sm:w-auto max-w-full"
            >
              <option value="">Show country list</option>
              {countries.map(([code, count]) => (
                <option key={code || 'undef'} value={code}>
                  {countryFlag(code)} {countryName(code)} ({count})
                </option>
              ))}
            </select>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-primary mb-1">Auto-refresh</h2>
            <p className="text-sm text-on-surface-variant mb-3">
              How often the active playlist re-fetches in the background.
            </p>
            <label className="sr-only" htmlFor="refresh">Auto-refresh interval</label>
            <select
              id="refresh"
              value={draft.refreshIntervalMinutes}
              onChange={(e) => setField('refreshIntervalMinutes', parseInt(e.target.value, 10))}
              className="glass rounded-xl px-4 py-3 outline-none w-full sm:w-auto"
            >
              {REFRESH_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-primary mb-1">Recording padding</h2>
            <p className="text-sm text-on-surface-variant mb-3">
              Extra time captured around EPG-scheduled recordings, to absorb broadcast drift.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <label htmlFor="pad-before" className="block text-sm text-on-surface-variant mb-1">Start early</label>
                <select
                  id="pad-before"
                  value={draft.recordingPadding.before}
                  onChange={(e) => setField('recordingPadding', { ...draft.recordingPadding, before: parseInt(e.target.value, 10) })}
                  className="glass rounded-xl px-4 py-3 outline-none w-full"
                >
                  {PADDING_OPTIONS.map((m) => (
                    <option key={m} value={m}>{paddingLabel(m)}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="pad-after" className="block text-sm text-on-surface-variant mb-1">Stop late</label>
                <select
                  id="pad-after"
                  value={draft.recordingPadding.after}
                  onChange={(e) => setField('recordingPadding', { ...draft.recordingPadding, after: parseInt(e.target.value, 10) })}
                  className="glass rounded-xl px-4 py-3 outline-none w-full"
                >
                  {PADDING_OPTIONS.map((m) => (
                    <option key={m} value={m}>{paddingLabel(m)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* Account — voluntary password change (only when auth is enabled) */}
        <PasswordSettings />

        {/* Danger zone (immediate, two-step confirm) */}
        <section className="rounded-2xl p-5 md:p-6 border border-error/40 bg-error/5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-error flex items-center gap-2">
              <Icon name="warning" /> Danger zone
            </h2>
            <p className="text-sm text-on-surface-variant">
              Deletes channels and their favourites. Your recordings and uploaded m3u files are kept.
            </p>
          </div>
          <ConfirmButton
            label={`Delete all Live TV channels (${liveCount})`}
            confirmLabel="Delete Live TV"
            onConfirm={() => clearChannelsOfKind('live')}
            disabled={liveCount === 0}
          />
          <ConfirmButton
            label={`Delete all Radio channels (${radioCount})`}
            confirmLabel="Delete Radio"
            onConfirm={() => clearChannelsOfKind('radio')}
            disabled={radioCount === 0}
          />
        </section>

        <p className="text-xs text-on-surface-variant text-center">
          New feature settings will appear here and are saved with the same Save button.
        </p>
      </div>

      {/* Sticky single-Save action bar */}
      <div
        className={`fixed bottom-0 inset-x-0 z-30 transition-transform duration-300 ${
          dirty ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="glass-dark border-t border-white/10 px-4 md:px-8 py-3 flex items-center justify-between gap-4 max-w-3xl mx-auto rounded-t-2xl">
          <span className="text-sm text-on-surface-variant flex items-center gap-2">
            <Icon name="edit" className="text-base text-primary" /> You have unsaved changes
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onDiscard} className="px-4 py-2 rounded-full text-sm hover:bg-white/10 transition-colors">
              Discard
            </button>
            <button
              onClick={onSave}
              className="bg-primary text-on-primary px-6 py-2 rounded-full text-sm font-semibold hover:scale-105 transition-transform shadow-lg shadow-primary/20"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
