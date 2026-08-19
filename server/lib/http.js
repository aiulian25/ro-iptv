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

// Opt-in SSRF hardening for the upstream-fetching endpoints (proxy/playlist/epg)
// and the channel-index builder. This is a LITERAL-address check: a hostname that
// DNS-resolves to a private IP is NOT caught (full protection needs resolve-and-pin,
// which is out of scope here).
export const BLOCK_PRIVATE = process.env.PROXY_BLOCK_PRIVATE === '1';

export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

// True when PROXY_BLOCK_PRIVATE=1 and the target resolves to a literal private,
// loopback or link-local host. An unparseable target is refused (fail closed).
export function isBlockedTarget(target) {
  if (!BLOCK_PRIVATE) return false;
  if (isAllowedTarget(target)) return false;
  try {
    return isPrivateHost(new URL(target).hostname);
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
const ALLOWED_TARGETS = new Set([process.env.EPG_SIDECAR_URL].filter(Boolean));

export function isAllowedTarget(target) {
  return ALLOWED_TARGETS.has(target);
}

export async function guardedFetch(target, options = {}) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (!isValidUrl(url)) throw new Error('invalid url');
    if (isBlockedTarget(url)) throw new Error('refusing a private-network url');
    const response = await fetch(url, { ...options, redirect: 'manual' });
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
