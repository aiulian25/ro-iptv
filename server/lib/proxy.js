import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guardedFetch } from './http.js';
import { rewriteManifest } from './manifest.js';

export function createStreamProxy({ headerTimeoutMs = 15000, idleTimeoutMs = 30000,
  manifestTimeoutMs = 15000, manifestMaxBytes = 1024 * 1024, maxConcurrent = 64 } = {}) {
  let active = 0;
  return async function proxy(req, res, { target, headers, extra = '' }) {
    if (active >= maxConcurrent) {
      res.setHeader('Retry-After', '2');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy capacity reached' }));
      return;
    }
    active++;
    const controller = new AbortController();
    let upstream, reader, headerTimer, manifestTimer, fetching;
    let fetchSettled = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abortedFetch = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', abortedFetch, { once: true });
    const previousTimeout = res.socket?.timeout || 0;
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableFinished) abort(); };
    req.once('aborted', abort);
    res.once('close', disconnected);
    const deadline = (ms) => setTimeout(abort, ms);
    // Read-idle only measures time waiting on upstream. Downstream inactivity
    // is enforced by the socket timeout, without penalizing healthy backpressure.
    const read = async () => {
      const timer = deadline(idleTimeoutMs);
      try { return await reader.read(); } finally { clearTimeout(timer); }
    };
    try {
      res.setTimeout(idleTimeoutMs, abort);
      headerTimer = deadline(headerTimeoutMs);
      fetching = guardedFetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: controller.signal,
      }).then((response) => {
        fetchSettled = true;
        if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw controller.signal.reason; }
        return response;
      }, (error) => { fetchSettled = true; throw error; });
      upstream = await Promise.race([fetching, aborted]);
      clearTimeout(headerTimer);
      // Upstream error pages may echo credentials. Preserve the status and
      // valid byte-range metadata, but never forward an arbitrary error body.
      if (upstream.status >= 400) {
        res.statusCode = upstream.status;
        const range = upstream.headers.get('content-range');
        if (range && /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/.test(range)) res.setHeader('content-range', range);
        res.setHeader('content-type', 'application/json');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: `upstream ${upstream.status}` }));
        return;
      }
      const finalUrl = upstream.url || target;
      res.statusCode = upstream.status;
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
      reader = upstream.body.getReader();
      const contentType = upstream.headers.get('content-type') || '';
      const initial = [];
      let done = false;
      let manifest = /mpegurl|m3u8/i.test(contentType);
      // A suffix is only a hint. Peek a bounded prefix for mislabelled or
      // extensionless manifests, retaining initial chunks for either path.
      if (!manifest) {
        manifestTimer = deadline(manifestTimeoutMs);
        const prefix = Buffer.alloc(1024); let length = 0;
        while (length < prefix.length) {
          const part = await read(); done = part.done;
          if (done) break;
          initial.push(part.value);
          const chunk = part.value.subarray(0, prefix.length - length); prefix.set(chunk, length); length += chunk.length;
          // A UTF-8 BOM may arrive across separate network chunks.
          if (length < 3 && prefix[0] === 0xef && (length === 1 || prefix[1] === 0xbb)) continue;
          const text = prefix.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '').trimStart();
          if (text.startsWith('#EXTM3U')) { manifest = true; break; }
          if (text && !'#EXTM3U'.startsWith(text)) break;
        }
      }
      if (manifest) {
        manifestTimer ||= deadline(manifestTimeoutMs);
        if (Number(upstream.headers.get('content-length')) > manifestMaxBytes) throw new Error('Manifest too large');
        const chunks = initial.map(chunk => Buffer.from(chunk));
        let bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (bytes > manifestMaxBytes) throw new Error('Manifest too large');
        while (!done) {
          const part = await read(); done = part.done;
          if (done) break;
          bytes += part.value.length;
          if (bytes > manifestMaxBytes) throw new Error('Manifest too large');
          chunks.push(Buffer.from(part.value));
        }
        clearTimeout(manifestTimer);
        const body = rewriteManifest(Buffer.concat(chunks).toString('utf8'), finalUrl, extra, manifestMaxBytes * 4);
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.removeHeader('content-length');
        res.end(body);
        return;
      }
      clearTimeout(manifestTimer);
      async function* chunks() {
        for (const chunk of initial) yield chunk;
        if (done) return;
        for (;;) {
          const { done, value } = await read();
          if (done) break;
          yield value;
        }
      }
      await pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 }), res, { signal: controller.signal });
    } catch {
      if (!res.headersSent && !res.destroyed) {
        for (const name of ['content-length', 'content-range', 'accept-ranges', 'content-type', 'cache-control']) res.removeHeader(name);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy fetch failed' }));
      } else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(headerTimer);
      clearTimeout(manifestTimer);
      controller.signal.removeEventListener('abort', abortedFetch);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
      else upstream?.body?.cancel().catch(() => {});
      req.off('aborted', abort);
      res.off('close', disconnected);
      res.off('timeout', abort);
      if (!res.destroyed) res.setTimeout(previousTimeout);
      if (fetching && !fetchSettled) fetching.then(() => { active--; }, () => { active--; });
      else active--;
    }
  };
}
