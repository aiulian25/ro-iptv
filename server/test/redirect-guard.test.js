// The target guard must survive a redirect: checking only the URL the user
// supplied is a filter one 302 walks straight past.
//
// PROXY_BLOCK_PRIVATE and EPG_SIDECAR_URL are read once at module load, so the
// stub server is started first and the module imported after the env is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

const PRIVATE_BODY = 'PRIVATE-NETWORK-SECRET';

// Everything here is loopback, which the guard treats as private. The entry point
// is allow-listed by exact URL (as a configured sidecar would be), so hop 0 is
// permitted and the test isolates whether the REDIRECT TARGET is checked.
const origin = http.createServer((req, res) => {
  if (req.url === '/redirect-to-private') {
    res.writeHead(302, { Location: `http://127.0.0.1:${origin.address().port}/secret` });
    return res.end();
  }
  if (req.url === '/redirect-to-allowed') {
    res.writeHead(302, { Location: `http://127.0.0.1:${origin.address().port}/redirect-to-private` });
    return res.end();
  }
  if (req.url === '/loop') {
    res.writeHead(302, { Location: `http://127.0.0.1:${origin.address().port}/loop` });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(PRIVATE_BODY);
});
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;

process.env.PROXY_BLOCK_PRIVATE = '1';
process.env.EPG_SIDECAR_URL = `${ORIGIN}/redirect-to-private`;
const { guardedFetch, isBlockedTarget } = await import('../lib/http.js');

test.after(() => origin.close());

test('the allow-listed entry point itself is permitted', () => {
  assert.equal(isBlockedTarget(`${ORIGIN}/redirect-to-private`), false);
  assert.equal(isBlockedTarget(`${ORIGIN}/secret`), true, 'only the exact URL, never the host');
});

test('a redirect into a private target is refused, not followed', async () => {
  await assert.rejects(() => guardedFetch(`${ORIGIN}/redirect-to-private`, {}), /private-network/);
});

test('the allowlist does not extend to a later hop', async () => {
  // Hop 0 is a plain private URL here, so this also confirms hop 0 is still checked.
  await assert.rejects(() => guardedFetch(`${ORIGIN}/redirect-to-allowed`, {}), /private-network/);
});

test('a redirect loop terminates instead of hanging', async () => {
  process.env.PROXY_BLOCK_PRIVATE = '';
  const { guardedFetch: unguarded } = await import(`../lib/http.js?loop=${ORIGIN.length}`);
  await assert.rejects(() => unguarded(`${ORIGIN}/loop`, {}), /too many redirects/);
});
