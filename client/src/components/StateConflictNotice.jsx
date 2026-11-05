import { useState } from 'react';
import { useStore } from '../store/useStore';
import Dialog from './Dialog';

// A rejected stale save is retained locally for an explicit, version-checked
// choice. Do not silently merge settings or discard a device's pending values.
export default function StateConflictNotice() {
  const conflicts = useStore(s => s.stateConflicts);
  const resolve = useStore(s => s.resolveStateConflict);
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const keys = Object.keys(conflicts), conflict = conflicts[selected];
  const choose = async choice => {
    setBusy(true); setError('');
    try { await resolve(selected, choice); setSelected(null); }
    catch { setError('Shared data changed again or could not be saved. Review the current copies and retry.'); }
    finally { setBusy(false); }
  };
  if (!keys.length) return null;
  return <>
    <div role="alert" className="fixed top-28 right-4 z-40 glass-dark p-3 rounded-xl max-w-[calc(100vw-2rem)]">
      Shared changes need review. <button className="text-primary underline" onClick={() => setSelected(keys[0])}>Review shared changes</button>
    </div>
    {conflict && <Dialog label={`Review shared ${selected} changes`} onClose={() => { if (!busy) setSelected(null); }} maxWidth="48rem">
      <div className="glass-dark p-6 rounded-xl max-h-[85vh] overflow-auto">
        <h2 className="text-xl font-semibold">Review shared {selected} changes</h2>
        <p>Another device saved a newer copy. Your pending changes are kept on this device.</p>
        <div className="grid md:grid-cols-2 gap-3 my-4">
          <section><h3>Your pending copy</h3><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(conflict.value, null, 2).slice(0, 4000)}</pre></section>
          <section><h3>Server copy</h3><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(conflict.current?.value, null, 2)?.slice(0, 4000)}</pre></section>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button disabled={busy} onClick={() => choose('server')}>Use server copy</button>
          <button disabled={busy} onClick={() => choose('local')}>Keep my pending copy</button>
          <button disabled={busy} onClick={() => setSelected(null)}>Close</button>
        </div>
      </div>
    </Dialog>}
  </>;
}
