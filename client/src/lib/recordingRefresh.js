const PENDING = new Set(['scheduled', 'recording']);

// One app-level owner across all views. Delay the next poll until the current
// read settles; terminal-only state has no timer. Wake events also discover
// jobs created elsewhere without leaving an idle background polling loop.
export function startRecordingRefresh(store, { canAccess, document: doc = document, window: win = window, navigator: nav = navigator, delay = 4000 } = {}) {
  let disposed = false, timer = null, running = null;
  const reachable = () => canAccess(store.getState().auth) && !doc.hidden && nav.onLine !== false;
  const clear = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const pause = () => { clear(); running = null; store.getState().cancelRecordingsRefresh(); };
  const reconcile = () => {
    if (disposed) return;
    if (!reachable()) { pause(); return; }
    if (!store.getState().recordings.some(rec => PENDING.has(rec.status))) { clear(); return; }
    if (timer === null && !running) timer = win.setTimeout(refresh, delay);
  };
  function refresh() {
    clear();
    if (disposed || !reachable()) return;
    const request = store.getState().loadRecordings();
    if (request === running) return;
    running = request;
    Promise.resolve(request).catch(() => {}).finally(() => {
      if (disposed || running !== request) return;
      running = null; reconcile();
    });
  }
  const wake = () => { if (reachable()) refresh(); else pause(); };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.view === 'recordings' && previous.view !== state.view) refresh();
    else reconcile();
  });
  win.addEventListener('online', wake);
  win.addEventListener('offline', wake);
  win.addEventListener('focus', wake);
  doc.addEventListener('visibilitychange', wake);
  refresh();
  return () => {
    disposed = true; unsubscribe(); pause();
    win.removeEventListener('online', wake);
    win.removeEventListener('offline', wake);
    win.removeEventListener('focus', wake);
    doc.removeEventListener('visibilitychange', wake);
  };
}
