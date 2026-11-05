// Only an explicit successful auth-off response permits offline access.
export const AUTH_MODE_KEY = 'ro-iptv:authMode';
export const LOCAL_LOCK_KEY = 'ro-iptv:localLock';
export const DEFAULT_SETTINGS = { epgUrls: [], refreshIntervalMinutes: 360, defaultCountry: '', recordingPadding: { before: 1, after: 5 } };
let generation = 0;
let controller = new AbortController();
export const sessionGeneration = () => generation;
export function invalidateSession() {
  generation++;
  controller.abort();
  controller = new AbortController();
}
export async function sessionFetch(url, options = {}) {
  const started = generation;
  let signal = controller.signal;
  if (options.signal && options.signal !== signal) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.any) signal = AbortSignal.any([signal, options.signal]);
    else {
      const joined = new AbortController(), sources = [signal, options.signal];
      const abort = () => { joined.abort(); for (const source of sources) source.removeEventListener('abort', abort); };
      for (const source of sources) source.addEventListener('abort', abort, { once: true });
      if (sources.some(source => source.aborted)) abort();
      signal = joined.signal;
    }
  }
  const response = await fetch(url, { ...options, signal, cache: 'no-store' });
  if (started !== generation) throw new Error('Session changed');
  return response;
}
export function storedAuthMode() {
  try { return localStorage.getItem(AUTH_MODE_KEY); } catch { return null; }
}
export function locallyLocked() {
  try { return localStorage.getItem(LOCAL_LOCK_KEY) === '1'; } catch { return true; }
}
export function rememberAuthMode(required) {
  localStorage.setItem(AUTH_MODE_KEY, required ? 'required' : 'open');
}
export function markLocalLock(locked) {
  if (locked) localStorage.setItem(LOCAL_LOCK_KEY, '1');
  else localStorage.removeItem(LOCAL_LOCK_KEY);
}
export async function clearPrivateStorage() {
  // Keep only explicitly nonprivate app preferences and the lock markers.
  const keep = new Set([AUTH_MODE_KEY, LOCAL_LOCK_KEY, 'ro-iptv:install-dismissed', 'ro-iptv:miniwin']);
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('ro-iptv:') && !keep.has(key)) storage.removeItem(key);
    }
  }
  await clearLegacyCacheMetadata();
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (/^(?:epg-cache|logo-cache)(?:-|$)/.test(name)) await caches.delete(name);
    }
  }
}

async function clearLegacyCacheMetadata() {
  if (typeof indexedDB === 'undefined') return;
  await new Promise((resolve, reject) => {
    let missing = false;
    const request = indexedDB.open('workbox-expiration');
    request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
    request.onerror = () => missing ? resolve() : reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache-entries')) { db.close(); resolve(); return; }
      const transaction = db.transaction('cache-entries', 'readwrite');
      const cursor = transaction.objectStore('cache-entries').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (/^(?:epg-cache|logo-cache)(?:-|$)/.test(row.value.cacheName || '')) row.delete();
        row.continue();
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Cache metadata cleanup failed')); };
    };
  });
}
