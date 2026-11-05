import { sidecarUrl } from './sidecar.js';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

// Shared outbound-HTTP concerns: the identity RO-IPTV presents to upstreams and
// the safety checks every user-supplied target must pass. Kept in one place so
// the request-path endpoints (proxy / playlist / EPG) and the background
// wanted-channels builder enforce exactly the same rules.

export const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (RO-IPTV; +https://github.com/ro-iptv) AppleWebKit/537.36',
  Accept: '*/*',
};

export function isValidUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Blank preserves intentional trusted-LAN access. Strict mode resolves and pins
// every connection; explicit CIDRs are the only subnet exceptions.
export const BLOCK_PRIVATE = process.env.PROXY_BLOCK_PRIVATE === '1';
const privateRanges = new BlockList();
for (const cidr of ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
  '172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15',
  '198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4',
  '::/96','::1/128','fc00::/7','fe80::/10','ff00::/8','2001:db8::/32',
  '64:ff9b::/96','64:ff9b:1::/48','::ffff:0:0:0/96','2001::/32','2002::/16']) {
  const [address, prefix] = cidr.split('/');
  privateRanges.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
const lanRanges = new BlockList();
const lanCidrs = (process.env.PROXY_ALLOWED_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const cidr of lanCidrs) {
  const [address, prefix, extra] = cidr.split('/');
  const family = isIP(address);
  if (!family || extra || prefix === undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 6 ? 128 : 32)) {
    throw new Error('Invalid PROXY_ALLOWED_CIDRS entry');
  }
  lanRanges.addSubnet(address, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
}
function normalizedHost(host) { return host.toLowerCase().replace(/^\[|\]$/g, ''); }
export function isPrivateHost(hostname) {
  const h = normalizedHost(hostname);
  const family = isIP(h);
  if (!family) return h === 'localhost' || /\.(localhost|local|internal)$/.test(h);
  return privateRanges.check(h, family === 6 ? 'ipv6' : 'ipv4');
}
function allowedAddress(address) {
  const family = isIP(address);
  return !!family && (lanRanges.check(address, family === 6 ? 'ipv6' : 'ipv4') || !isPrivateHost(address));
}
// Synchronous preflight for literal destinations/internal names. DNS decisions
// are made inside guardedFetch before the socket is opened.
export function isBlockedTarget(target) {
  if (!BLOCK_PRIVATE) return false;
  if (isAllowedTarget(target)) return false;
  try {
    const host = normalizedHost(new URL(target).hostname);
    return isIP(host) ? !allowedAddress(host) : !lanCidrs.length && isPrivateHost(host);
  } catch {
    return true;
  }
}

const MAX_REDIRECT_HOPS = 5;

/**
 * fetch() that re-applies the target guard on every redirect hop. With
 * `redirect: 'follow'` a public URL can 302 into a private address and the guard
 * would never see it — which matters most for the unattended fetchers, whose
 * responses are parsed and written to the data volume.
 */
// An explicitly configured sidecar guide is reachable only on the container
// network, so the private-address block would refuse it. Exempting the exact
// configured URL (never a host or prefix) keeps the generic block intact: a
// redirect away from it is re-checked and still refused.
const ALLOWED_TARGETS = new Set([sidecarUrl].filter(Boolean));

export function isAllowedTarget(target) {
  return ALLOWED_TARGETS.has(target);
}

// A checked address is passed directly to the socket lookup callback. Preserve
// the URL hostname for Host/SNI/certificate verification, with no pooled sockets
// or second resolver call that could undo the decision.
async function pinnedFetch(target, options) {
  const url = new URL(target);
  const hostname = normalizedHost(url.hostname);
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  options.signal?.throwIfAborted();
  if (!addresses.length || (!isAllowedTarget(target) && addresses.some((a) => !allowedAddress(a.address)))) {
    throw new Error('refusing a private-network url');
  }
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = new Headers(options.headers || {});
    headers.set('Accept-Encoding', 'identity');
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET', headers: Object.fromEntries(headers),
      signal: options.signal, agent: false,
      lookup: (_name, opts, callback) => callback(null, opts.all ? [pinned] : pinned.address, pinned.family),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const noBody = options.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      let stream = incoming;
      const encoding = incoming.headers['content-encoding'];
      const decoder = noBody ? null : encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
        : encoding === 'br' ? createBrotliDecompress() : null;
      if (decoder) {
        incoming.on('error', (e) => decoder.destroy(e));
        decoder.on('close', () => incoming.destroy());
        stream = incoming.pipe(decoder);
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }
      const response = new Response(noBody ? null : Readable.toWeb(stream), {
        status: incoming.statusCode, headers: responseHeaders,
      });
      if (noBody) incoming.resume();
      Object.defineProperty(response, 'url', { value: target });
      resolve(response);
    });
    request.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Unsupported upstream upgrade')); });
    request.on('error', reject);
    request.end();
  });
}

export async function guardedFetch(target, options = {}) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (!isValidUrl(url)) throw new Error('invalid url');
    if (isBlockedTarget(url)) throw new Error('refusing a private-network url');
    const response = BLOCK_PRIVATE ? await pinnedFetch(url, options) : await fetch(url, { ...options, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    response.body?.cancel().catch(() => {});
    url = new URL(location, url).toString();
  }
  throw new Error('too many redirects');
}

/**
 * Download a guarded target into a Buffer, enforcing the cap WHILE reading so an
 * oversized or endless response can never be materialised first. Errors carry a
 * `status` so callers can surface the upstream's own code.
 */
export async function fetchToBuffer(url, { headers = FETCH_HEADERS, timeoutMs, maxBytes } = {}) {
  const response = await guardedFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw Object.assign(new Error(`upstream ${response.status}`), { status: response.status });
  }
  const declaredLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (declaredLength > maxBytes) throw Object.assign(new Error('response too large'), { status: 413 });

  const chunks = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        reader.cancel().catch(() => {});
        throw Object.assign(new Error('response too large'), { status: 413 });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}
