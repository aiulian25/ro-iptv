// Remove old runtime responses and their URL-bearing expiration metadata.
// Only known RO-IPTV runtime caches are affected; keep the static shell.
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
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyCacheMetadata();
    for (const name of await caches.keys()) {
      if (/^(?:epg-cache|logo-cache)(?:-|$)/.test(name)) await caches.delete(name);
    }
  })());
});
