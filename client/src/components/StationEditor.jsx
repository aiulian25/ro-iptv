import { useEffect, useRef, useState } from 'react';
import { validateStation } from '@shared/station.js';
import { useStore } from '../store/useStore';
import { attachStream } from '../lib/playSource';
import Dialog from './Dialog';

export default function StationEditor({ station, serverStation, revision, onReload, onSaved, onClose }) {
  const [form, setForm] = useState(() => ({ name: '', url: '', country: '', genre: '', logo: '', ...station }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState('');
  const hls = useRef(null), audio = useRef(null), stop = useRef(null), previewEpoch = useRef(0);
  const save = useStore(s => s.changeLocalStation), stopPlayback = useStore(s => s.stopPlayback);
  const stopPreview = () => { previewEpoch.current++; stop.current?.(); stop.current = null; const media = audio.current; if (media) { media.pause(); media.removeAttribute('src'); media.load(); } };
  useEffect(() => () => stopPreview(), []);
  const change = (key, value) => { stopPreview(); setPreview(''); setForm(old => ({ ...old, [key]: value })); };
  const testPlay = () => {
    try {
      const candidate = validateStation(form); stopPreview(); stopPlayback(); setError(''); setPreview('Testing…');
      const epoch = previewEpoch.current;
      stop.current = attachStream(audio.current, { ...candidate, id: 'station-preview', kind: 'radio' }, {
        hlsRef: hls,
        onManifest: () => { if (epoch === previewEpoch.current) { audio.current?.play().catch(() => {}); setPreview('Use the audio controls to listen.'); } },
        onError: () => { if (epoch === previewEpoch.current) setPreview('Test playback failed. Check the URL, access policy or audio format.'); },
      });
    } catch (err) { setError(err.message); }
  };
  const submit = async event => {
    event.preventDefault(); setError('');
    try { const candidate = validateStation(form); setBusy(true); stopPreview(); const result = await save(station ? 'PUT' : 'POST', { ...candidate, revision }, station?.id); onSaved(result); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <Dialog label={station ? 'Edit local radio station' : 'Add radio station'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit} className="glass-dark rounded-2xl p-5 flex flex-col gap-3 max-h-[85vh] overflow-y-auto">
      <h2 className="text-xl font-semibold">{station ? 'Edit local radio station' : 'Add radio station'}</h2>
      <p className="text-sm text-on-surface-variant">Add one audio stream. Playlist imports are separate in Settings.</p>
      {['name', 'url', 'country', 'genre', 'logo'].map(key => <label key={key} className="text-sm">{{ name: 'Station name', url: 'Stream URL', country: 'Country code (optional)', genre: 'Genre (optional)', logo: 'Logo URL (optional)' }[key]}
        <input value={form[key]} onChange={event => change(key, event.target.value)} disabled={busy} required={key === 'name' || key === 'url'} maxLength={key === 'name' ? 120 : key === 'country' ? 2 : key === 'genre' ? 80 : 4096} className="glass rounded-xl p-3 w-full mt-1" />
      </label>)}
      <p className="text-sm text-on-surface-variant">Test play stops current playback and uses the normal stream/proxy policy. Saving does not test or contact the station.</p>
      <audio ref={audio} onPlaying={() => setPreview('Playing test stream.')} controls aria-label="Station test playback" className="w-full" />
      {preview && <p role="status">{preview}</p>}
      {station && serverStation && JSON.stringify(station) !== JSON.stringify(serverStation) && <details className="glass rounded-xl p-3">
        <summary>Current server copy</summary>
        <p className="break-words">{serverStation.name}</p><p className="break-all text-sm">{serverStation.url}</p>
        <p className="text-sm">{serverStation.country || 'No country'} · {serverStation.genre || 'Radio'}</p>
      </details>}
      {station && !serverStation && <p role="status">This station was removed on another device. Your form is kept; cancel to return to the list.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={testPlay} className="glass rounded-xl px-3 min-h-11">Test play</button>
        <button type="submit" disabled={busy || revision == null || (station && !serverStation)} className="bg-primary text-on-primary rounded-xl px-3 min-h-11">{busy ? 'Saving…' : 'Save station'}</button>
        <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { if (!await onReload()) setError('Could not reload stations. Your form is kept.'); } finally { setBusy(false); } }} className="underline min-h-11">Reload station list</button>
        <button type="button" disabled={busy} onClick={onClose} className="underline min-h-11">Cancel</button>
      </div>
    </form>
  </Dialog>;
}
