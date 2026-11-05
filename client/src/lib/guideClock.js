// Guide time is separate from Home's one-second clock. One timer serves every
// mounted guide consumer, with no data fetches and no work while hidden/unused.
export function createGuideClock({ now = () => Date.now(), interval = 30000,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id),
  document: doc = globalThis.document } = {}) {
  let snapshot = now(), timer = null;
  const listeners = new Set();
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const publish = () => {
    const next = now();
    if (next === snapshot) return;
    snapshot = next;
    for (const notify of listeners) notify();
  };
  const arm = () => {
    clear();
    if (listeners.size && !doc?.hidden) timer = schedule(tick, interval - (now() % interval));
  };
  function tick() { timer = null; publish(); arm(); }
  const visibility = () => { if (!doc.hidden) publish(); arm(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) {
      listeners.add(notify);
      if (listeners.size === 1) {
        doc?.addEventListener('visibilitychange', visibility);
        publish(); arm();
      }
      return () => {
        listeners.delete(notify);
        if (!listeners.size) { clear(); doc?.removeEventListener('visibilitychange', visibility); }
      };
    },
  };
}
