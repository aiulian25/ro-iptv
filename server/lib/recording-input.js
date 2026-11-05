// Strict-mode recording input. FFmpeg receives media bytes only, with its input
// protocol list restricted to pipe. All URL/redirect/key/segment I/O stays here.
import { createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { guardedFetch } from './http.js';

const MANIFEST_MAX = 1024 * 1024;
const SEGMENT_MAX = 64 * 1024 * 1024;
function attrs(line) {
  const result = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)) result[m[1]] = m[2] ?? m[3];
  return result;
}
async function bounded(response, max) {
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new Error('Recording resource too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
async function write(output, bytes, signal) {
  signal.throwIfAborted();
  if (!output.write(bytes)) await once(output, 'drain', { signal });
}

export async function relayRecording(url, output, { headers = {}, signal }) {
  const get = async (target, range) => {
    const response = await guardedFetch(target, { headers: { ...headers, ...(range ? { Range: range } : {}) }, signal });
    if (range && response.status !== 206) { await response.body?.cancel(); throw new Error('Recording byte range unsupported'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Recording upstream unavailable'); }
    return response;
  };
  let response = await get(url);
  // Sniff the initial bytes too: HLS providers often use extensionless endpoints.
  const firstReader = response.body.getReader();
  const first = await firstReader.read();
  const hls = /mpegurl|m3u8/i.test(response.headers.get('content-type') || '') ||
    /\.m3u8(?:\?|$)/i.test(response.url) || Buffer.from(first.value || []).toString('utf8').trimStart().startsWith('#EXTM3U');
  if (!hls) {
    try {
      if (first.value) await write(output, first.value, signal);
      for (;;) {
        const { done, value } = await firstReader.read();
        if (done) break;
        await write(output, value, signal);
      }
    } finally { await firstReader.cancel().catch(() => {}); }
    output.end();
    return;
  }
  // The first response is reconstructed with its consumed prefix for bounded read.
  let prefix = first.value;
  const stream = new ReadableStream({
    async pull(controller) {
      if (prefix) { controller.enqueue(prefix); prefix = null; return; }
      const next = await firstReader.read();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    cancel() { return firstReader.cancel(); },
  });
  let text = (await bounded(new Response(stream), MANIFEST_MAX)).toString('utf8');
  url = response.url || url;
  let lastSequence = -1;
  let mapWritten = '';
  let depth = 0;
  for (;;) {
    signal.throwIfAborted();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS manifest');
    const lines = text.split(/\r?\n/).map((s) => s.trim());
    if (lines.some((line) => /^#EXT-X-MEDIA:/.test(line) && attrs(line).URI)) {
      throw new Error('Separate HLS renditions are unsupported for strict recordings');
    }
    const variant = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:'));
    if (variant >= 0) {
      if (++depth > 5) throw new Error('HLS nesting limit exceeded');
      const next = lines.slice(variant + 1).find((line) => line && !line.startsWith('#'));
      if (!next) throw new Error('Missing HLS variant');
      response = await get(new URL(next, url).href);
      url = response.url;
      text = (await bounded(response, MANIFEST_MAX)).toString('utf8');
      continue;
    }
    let sequence = Number(lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] || 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid HLS sequence');
    let key = null;
    let map = null;
    let byteRange = null;
    let rangeEnd = 0;
    let rangeUrl = '';
    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:')) {
        const a = attrs(line);
        if (a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128' && a.URI && (!a.KEYFORMAT || a.KEYFORMAT === 'identity')) key = a;
        else throw new Error('Unsupported HLS encryption');
      } else if (line.startsWith('#EXT-X-MAP:')) map = attrs(line);
      else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = line.split(':')[1];
      else if (line && !line.startsWith('#')) {
        const target = new URL(line, url).href;
        const current = sequence++;
        let range;
        if (byteRange) {
          const m = byteRange.match(/^(\d+)(?:@(\d+))?$/);
          if (!m || (!m[2] && rangeUrl !== target)) throw new Error('Invalid HLS byte range');
          const offset = m[2] === undefined ? rangeEnd : Number(m[2]);
          rangeEnd = offset + Number(m[1]);
          rangeUrl = target;
          range = `bytes=${offset}-${rangeEnd - 1}`;
        }
        if (current <= lastSequence) { byteRange = null; continue; }
        let keyBytes;
        const decrypt = async (bytes, ivValue) => {
          if (!key) return bytes;
          keyBytes ||= await bounded(await get(new URL(key.URI, url).href), 16);
          if (keyBytes.length !== 16) throw new Error('Invalid HLS key');
          const iv = Buffer.alloc(16);
          if (ivValue) {
            if (!/^0x[0-9a-f]{1,32}$/i.test(ivValue)) throw new Error('Invalid HLS IV');
            Buffer.from(ivValue.slice(2).padStart(32, '0'), 'hex').copy(iv);
          } else iv.writeBigUInt64BE(BigInt(current), 8);
          const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv);
          return Buffer.concat([decipher.update(bytes), decipher.final()]);
        };
        if (map?.URI) {
          const mapUrl = new URL(map.URI, url).href;
          const identity = JSON.stringify([mapUrl, map.BYTERANGE, key]);
          if (mapWritten !== identity) {
            if (key && !key.IV) throw new Error('Encrypted HLS map requires IV');
            let range;
            if (map.BYTERANGE) {
              const m = map.BYTERANGE.match(/^(\d+)@(\d+)$/);
              if (!m) throw new Error('HLS map requires explicit byte offset');
              range = `bytes=${m[2]}-${Number(m[2]) + Number(m[1]) - 1}`;
            }
            await write(output, await decrypt(await bounded(await get(mapUrl, range), SEGMENT_MAX), key?.IV), signal);
            mapWritten = identity;
          }
        }
        await write(output, await decrypt(await bounded(await get(target, range), SEGMENT_MAX), key?.IV), signal);
        byteRange = null;
        lastSequence = current;
      }
    }
    if (lines.includes('#EXT-X-ENDLIST')) break;
    const seconds = Number(lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1] || 4);
    await delay(Math.min(10000, Math.max(500, seconds * 500)), undefined, { signal });
    response = await get(url);
    url = response.url;
    text = (await bounded(response, MANIFEST_MAX)).toString('utf8');
  }
  output.end();
}
