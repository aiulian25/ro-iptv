import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { sessionGeneration } from '../lib/privacy';
import { downloadText } from '../lib/exportM3U';
import Dialog from './Dialog';
const MAX = 256 * 1024;

function ChannelMapping({ row, channels, value, disabled, onChange }) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
    const matches = [], needle = query.trim().toLowerCase();
    for (const channel of channels) {
      if (!needle || `${channel.name} ${channel.id}`.toLowerCase().includes(needle)) matches.push(channel);
      if (matches.length === 100) break;
    }
    const current = channels.find(channel => channel.id === value);
    if (current && !matches.some(channel => channel.id === value)) matches.unshift(current);
    return matches;
  }, [channels, query, value]);
  return <>
    <label className="block text-sm">Find destination for {row.name}<input maxLength={220} disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} className="glass rounded-xl p-3 w-full" /></label>
    <label className="block text-sm break-words">Map saved channel: {row.name}
      <select aria-label={`Map saved channel: ${row.name}`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} className="block w-full p-3 rounded-xl glass mt-1">
        <option value="">Choose a destination channel</option>
        {options.map(channel => <option key={channel.id} value={channel.id}>{channel.name} · {channel.playlistId}</option>)}
      </select>
    </label>
    <p className="text-xs">Up to 100 matches plus the selected channel. Search to narrow the choices.</p>
  </>;
}

export default function BackupRestore() {
  const channels = useStore(s => s.channels), restore = useStore(s => s.restoreConfiguration);
  const [archive, setArchive] = useState(null), [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mapping, setMapping] = useState({}), [guideUrls, setGuideUrls] = useState({}), [guideTargets, setGuideTargets] = useState({});
  const [complete, setComplete] = useState(false), [page, setPage] = useState(0);
  const channelIds = useMemo(() => new Set(channels.map(channel => channel.id)), [channels]);
  const exportBackup = async () => {
    const generation = sessionGeneration(); setBusy(true); setError('');
    try { const value = await api.exportConfiguration(); if (generation === sessionGeneration()) downloadText('ro-iptv-config-v1.json', JSON.stringify(value), 'application/json'); }
    catch (err) { if (generation === sessionGeneration()) setError(err.message); }
    finally { setBusy(false); }
  };
  const selectFile = async event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const generation = sessionGeneration(); setError(''); setPreview(null); setBusy(true);
    try {
      if (file.size > MAX) throw new Error('Backup exceeds 256 KiB');
      const value = JSON.parse(await file.text());
      // Validate on the server before displaying any imported structure.
      const result = await api.previewConfiguration({ archive: value });
      if (generation !== sessionGeneration()) return;
      setPage(0); setMapping({}); setGuideUrls({}); setGuideTargets({}); setArchive(value); setPreview(result); setComplete(false);
    } catch (err) { if (generation === sessionGeneration()) setError(err instanceof SyntaxError ? 'Invalid JSON backup. Nothing was restored.' : err.message); }
    finally { setBusy(false); }
  };
  const change = (setter, key, value) => { setter(old => ({ ...old, [key]: value })); setPreview(null); setError(''); };
  const previewRestore = async () => {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api.previewConfiguration({ archive, channels: mapping, guideUrls, guideTargets })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setError('');
    try {
      const result = await restore(preview.previewId); setComplete(true);
      if (result.browserCleanupFailed) setError('Restored on the server, but browser data could not be refreshed. Clear this site’s stored data before reopening it.');
      else window.location.reload();
    } catch (err) { setError(err.message); setPreview(null); }
    finally { setBusy(false); }
  };
  return <section aria-label="Configuration backup and restore" className="glass rounded-2xl p-5 md:p-6">
    <h2 className="text-lg font-semibold text-primary">Administration · Configuration backup</h2>
    <p className="text-sm text-on-surface-variant my-2">Export saved server preferences, favourites and manual guide links. Source URLs/headers, playlist files, local stations, history, authentication and recordings are excluded. Import sources on the destination first, then map saved channels and re-enter guide URLs.</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={exportBackup} className="glass rounded-xl px-4 min-h-11">Export backup</button>
      <label className="glass rounded-xl px-4 py-3">Preview restore<input type="file" accept="application/json,.json" disabled={busy} onChange={selectFile} className="block max-w-full text-sm mt-1" aria-label="Select configuration backup" /></label>
    </div>
    {error && !archive && <p role="alert">{error}</p>}
    {archive && <Dialog label="Preview configuration restore" onClose={() => { if (!busy && !complete) { setArchive(null); setPreview(null); setError(''); } }} maxWidth="48rem">
      <div className="glass-dark rounded-2xl p-5 max-h-[85vh] overflow-y-auto flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Preview configuration restore</h2>
        <p>Version 1 · {archive.channels.filter(row => row.favourite).length} favourites · {archive.channels.filter(row => row.guideTarget !== null || row.needsGuideTarget).length} manual links · {archive.guideSources.length} guide addresses excluded.</p>
        <p className="text-sm">Preferences: auto-refresh {archive.preferences.refreshIntervalMinutes ? `${archive.preferences.refreshIntervalMinutes} minutes` : 'off'}; default country {archive.preferences.defaultCountry || 'none'}; guide {archive.preferences.epgView}; recording padding {archive.preferences.recordingPadding.before} minutes before / {archive.preferences.recordingPadding.after} minutes after.</p>
        <p className="text-sm">Source credentials are not in this archive. No source files, local stations, history, auth or recording data will be replaced. Restore replaces the included preferences, favourites and manual links, discards unsaved edits to those sections in this browser, then reloads. A private previous-state snapshot is retained on the server.</p>
        {archive.channels.slice(page * 20, page * 20 + 20).map(row => <div key={row.key} className="glass rounded-xl p-3">
          <ChannelMapping row={row} channels={channels} disabled={busy || complete}
            value={mapping[row.key] ?? (channelIds.has(row.sourceChannelId) ? row.sourceChannelId : '')}
            onChange={value => change(setMapping, row.key, value)} />
          {row.needsGuideTarget ? <label className="block text-sm mt-2">Guide target for {row.name}<input maxLength={256} disabled={busy || complete} value={guideTargets[row.key] || ''} onChange={event => change(setGuideTargets, row.key, event.target.value)} className="glass rounded-xl p-3 w-full" /></label> : row.guideTarget !== null && <p className="text-sm break-all">Manual guide target: {row.guideTarget}</p>}
        </div>)}
        {archive.channels.length > 20 && <nav aria-label="Saved channel pages" className="flex gap-3 flex-wrap">
          <button type="button" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>Previous 20</button>
          <span>{page * 20 + 1}–{Math.min(page * 20 + 20, archive.channels.length)} of {archive.channels.length}</span>
          <button type="button" disabled={busy || (page + 1) * 20 >= archive.channels.length} onClick={() => setPage(value => value + 1)}>Next 20</button>
        </nav>}
        {archive.guideSources.map(key => <label key={key} className="text-sm">Re-enter guide URL: {key}<input maxLength={4096} disabled={busy || complete} value={guideUrls[key] || ''} onChange={event => change(setGuideUrls, key, event.target.value)} className="glass rounded-xl p-3 w-full" /></label>)}
        {preview && <div role="status">
          <p>{preview.canRestore ? 'Ready to restore the reviewed configuration.' : 'Resolve missing entries, then preview again.'}</p>
          <p>{preview.unresolved.channels.length} unmapped channels · {preview.unresolved.guideUrls.length} missing guide URLs · {preview.unresolved.guideTargets.length} missing guide targets</p>
          <p>{preview.counts.preferences} preference fields · {preview.counts.favourites} favourites · {preview.counts.manualLinks} manual links</p>
        </div>}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy || complete} onClick={previewRestore} className="glass rounded-xl px-3 min-h-11">Validate preview</button>
          <button type="button" disabled={busy || complete || !preview?.canRestore} onClick={confirm} className="bg-primary text-on-primary rounded-xl px-3 min-h-11">Restore reviewed configuration</button>
          <button type="button" disabled={busy || complete} onClick={() => { setArchive(null); setPreview(null); setError(''); }} className="underline min-h-11">Cancel</button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
