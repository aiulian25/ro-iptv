// HLS manifest rewriting (server/lib/manifest.js).
//
// This is the hot path of every HLS stream: the browser is handed a manifest whose
// every segment, key and nested playlist points back at /api/proxy. A regression here
// does not degrade playback, it ends it — for every channel at once.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteManifest, proxyExtra } from '../lib/manifest.js';

const MANIFEST_URL = 'https://h/a/b.m3u8';
const PROXY_PREFIX = '/api/proxy?url=';
const proxied = (absoluteUrl, extra = '') => `${PROXY_PREFIX}${encodeURIComponent(absoluteUrl)}${extra}`;

test('a relative segment resolves against the manifest and is proxied', () => {
  assert.equal(rewriteManifest('seg1.ts', MANIFEST_URL), proxied('https://h/a/seg1.ts'));
  assert.equal(rewriteManifest('seg1.ts', MANIFEST_URL), `${PROXY_PREFIX}https%3A%2F%2Fh%2Fa%2Fseg1.ts`);

  // The other shapes a playlist uses to point at a segment.
  assert.equal(rewriteManifest('/abs/seg.ts', MANIFEST_URL), proxied('https://h/abs/seg.ts'));
  assert.equal(rewriteManifest('../up/seg.ts', MANIFEST_URL), proxied('https://h/up/seg.ts'));
  assert.equal(rewriteManifest('//other/x.ts', MANIFEST_URL), proxied('https://other/x.ts'));
});

test('an absolute segment URL is proxied as it stands', () => {
  assert.equal(rewriteManifest('http://other/x.ts', MANIFEST_URL), proxied('http://other/x.ts'));
});

test('a URI="…" inside a tag is rewritten within its quotes, leaving the tag intact', () => {
  assert.equal(
    rewriteManifest('#EXT-X-KEY:METHOD=AES-128,URI="k.key"', MANIFEST_URL),
    `#EXT-X-KEY:METHOD=AES-128,URI="${proxied('https://h/a/k.key')}"`
  );

  // Attributes after the URI must survive, and other tags carry URIs too.
  assert.equal(
    rewriteManifest('#EXT-X-KEY:METHOD=AES-128,URI="https://other/k.key",IV=0x00', MANIFEST_URL),
    `#EXT-X-KEY:METHOD=AES-128,URI="${proxied('https://other/k.key')}",IV=0x00`
  );
  assert.equal(
    rewriteManifest('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/en.m3u8",NAME="English"', MANIFEST_URL),
    `#EXT-X-MEDIA:TYPE=AUDIO,URI="${proxied('https://h/a/audio/en.m3u8')}",NAME="English"`
  );
});

test('comment lines without a URI, and blank lines, are passed through untouched', () => {
  for (const line of ['#EXTM3U', '#EXT-X-VERSION:3', '#EXTINF:10.0,', '#EXT-X-ENDLIST', '', '   ']) {
    assert.equal(rewriteManifest(line, MANIFEST_URL), line, JSON.stringify(line));
  }
});

test('proxyExtra re-attaches the UA and Referer to every rewritten line', () => {
  const extra = proxyExtra('UA', 'R');
  assert.equal(extra, '&ua=UA&ref=R');

  const rewritten = rewriteManifest(
    ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="k.key"', '#EXTINF:10.0,', 'seg1.ts'].join('\n'),
    MANIFEST_URL,
    extra
  );

  assert.deepEqual(rewritten.split('\n'), [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,URI="${proxied('https://h/a/k.key', extra)}"`,
    '#EXTINF:10.0,',
    proxied('https://h/a/seg1.ts', extra),
  ]);

  // Every line that now points at the proxy carries the headers; nothing else changed.
  for (const line of rewritten.split('\n').filter((l) => l.includes(PROXY_PREFIX))) {
    assert.ok(line.includes('&ua=UA&ref=R'), line);
  }
});

test('proxyExtra encodes its values and omits what it was not given', () => {
  assert.equal(proxyExtra('Mozilla/5.0 (X)', 'http://r/'), '&ua=Mozilla%2F5.0%20(X)&ref=http%3A%2F%2Fr%2F');
  assert.equal(proxyExtra('UA', ''), '&ua=UA');
  assert.equal(proxyExtra('', 'R'), '&ref=R');
  assert.equal(proxyExtra('', ''), '');
  assert.equal(proxyExtra(undefined, undefined), '');
});

// Documented, not endorsed: `new URL` throws on a line like "http://", and the proxy
// route has no per-line guard — the throw reaches its catch and answers 502 for the
// WHOLE manifest, so one malformed line takes out the stream rather than one segment.
test('a line that is not a valid URL throws, which today 502s the entire manifest', () => {
  assert.throws(() => rewriteManifest('http://', MANIFEST_URL), TypeError);
  assert.throws(() => rewriteManifest('#EXT-X-KEY:METHOD=AES-128,URI="http://"', MANIFEST_URL), TypeError);

  // One bad line among good ones loses all of them, not just itself.
  assert.throws(() => rewriteManifest(['#EXTM3U', 'seg1.ts', 'http://'].join('\n'), MANIFEST_URL), TypeError);
});

// Rewriting is plumbing, not a security boundary: it will happily point the proxy at
// a scheme the proxy must refuse. /api/proxy re-validates every url it is handed
// (isValidUrl + isBlockedTarget), and that is where such a target is rejected.
test('rewriting does not validate the target scheme — the proxy route does', () => {
  assert.equal(rewriteManifest('file:///etc/passwd', MANIFEST_URL), proxied('file:///etc/passwd'));
  assert.equal(rewriteManifest('javascript:alert(1)', MANIFEST_URL), proxied('javascript:alert(1)'));
});

// Real manifests arrive with CRLF. Rewritten lines are trimmed (losing the \r) while
// untouched comment lines keep theirs, so the output is mixed — valid for players,
// but worth pinning: a change here would be invisible until a player got strict.
test('CRLF input keeps its carriage returns only on lines that were not rewritten', () => {
  assert.equal(
    rewriteManifest('#EXTINF:10.0,\r\nseg1.ts\r\n', MANIFEST_URL),
    `#EXTINF:10.0,\r\n${proxied('https://h/a/seg1.ts')}\n`
  );
});
