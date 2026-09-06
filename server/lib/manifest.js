// HLS manifest rewriting for the stream proxy.
//
// Every .m3u8 the proxy serves passes through here: nested playlists, segments and
// AES keys are pointed back at /api/proxy so the browser never talks to the origin
// directly. Extracted from index.js so the hot path of every HLS stream is testable.

// Query suffix that carries the same UA/Referer onto rewritten manifest URLs so
// nested playlists, keys and segments are fetched with the same headers.
export function proxyExtra(ua, ref) {
  return (ua ? `&ua=${encodeURIComponent(ua)}` : '') + (ref ? `&ref=${encodeURIComponent(ref)}` : '');
}

export function rewriteManifest(text, manifestUrl, extra = '') {
  const base = new URL(manifestUrl);
  // Relative proxy URL: the browser resolves it against the manifest's own URL,
  // so it inherits the page scheme (https) — no mixed content behind a TLS proxy,
  // and no dependency on req.protocol (which is http inside the container).
  // `extra` re-attaches the UA/Referer so segments inherit the same headers.
  const proxyBase = `/api/proxy?url=`;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // Rewrite URI="..." inside tags (keys, media, etc.)
        return line.replace(/URI="([^"]+)"/g, (full, uri) => {
          const abs = new URL(uri, base).toString();
          return `URI="${proxyBase}${encodeURIComponent(abs)}${extra}"`;
        });
      }
      const abs = new URL(trimmed, base).toString();
      return proxyBase + encodeURIComponent(abs) + extra;
    })
    .join('\n');
}
