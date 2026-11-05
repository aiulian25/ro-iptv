import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import { sessionGeneration } from '../lib/privacy';
import StationEditor from './StationEditor';
import ConfirmButton from './ConfirmButton';

export default function LocalStations({ compact = false }) {
  const [snapshot, setSnapshot] = useState(null), [editing, setEditing] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const change = useStore(s => s.changeLocalStation);
  const reload = async () => {
    const generation = sessionGeneration();
    try { const result = await api.localStations(); if (generation === sessionGeneration()) { setSnapshot(result); setError(''); return result; } }
    catch (err) { if (generation === sessionGeneration()) setError(err.message); }
  };
  useEffect(() => { let active = true; const generation = sessionGeneration(); api.localStations().then(value => { if (active && generation === sessionGeneration()) setSnapshot(value); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, []);
  const remove = async id => {
    setBusy(true); setError('');
    try { setSnapshot(await change('DELETE', { revision: snapshot.revision }, id)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="Local radio stations" className={compact ? 'mb-4' : 'glass rounded-2xl p-5 md:p-6'}>
    {!compact && <><h2 className="text-lg text-primary font-semibold">Local radio stations</h2><p className="text-sm text-on-surface-variant">Managed here and shared with other devices, separately from imported playlists.</p></>}
    <div className="flex flex-wrap gap-3 mt-2">
      <button type="button" disabled={!snapshot || busy} onClick={() => setEditing({})} className="glass rounded-xl px-4 min-h-11">Add station</button>
      <button type="button" disabled={busy} onClick={reload} className="underline min-h-11">Reload station list</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!snapshot && !error && <p role="status">Loading local stations…</p>}
    {!compact && snapshot && <ul className="flex flex-col gap-3 mt-3">{snapshot.stations.map(station => <li key={station.id} className="glass rounded-xl p-3 flex flex-wrap gap-3 items-center">
      <span className="flex-1 min-w-0 break-words">{station.name}</span>
      <button type="button" disabled={busy} onClick={() => setEditing(station)} className="underline min-h-11" aria-label={`Edit ${station.name}`}>Edit</button>
      <ConfirmButton onConfirm={() => remove(station.id)} disabled={busy} label={`Remove ${station.name}`} className="text-error min-h-11" />
    </li>)}</ul>}
    {editing && <StationEditor station={editing.id ? editing : null} serverStation={snapshot?.stations.find(station => station.id === editing.id)} revision={snapshot?.revision} onReload={reload} onSaved={result => { setSnapshot(result); setEditing(null); }} onClose={() => setEditing(null)} />}
  </section>;
}
