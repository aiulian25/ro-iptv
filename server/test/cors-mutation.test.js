// The cross-origin mutation guard (server/index.js).
//
// CORS and the mutation guard read the same CORS_ALLOWED_ORIGINS list, and in 1.4.x
// they disagreed about what an entry means: a documented schemeless "host:port" entry
// satisfied CORS but was silently ignored for mutations, so a correctly configured
// client got 403 on every write. Reads stay lenient and writes stay strict — but both
// must agree on which entries exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const REJECTED = 403;

// Boot the API with a given allow-list and return a POST-with-Origin probe. The
// guard runs before routing, so any /api path exercises it.
async function startApi(t, allowedOrigins) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-cors-'));
  const hook = path.join(root, 'port.mjs');
  await fs.writeFile(
    hook,
    `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`
  );
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, new URL('../index.js', import.meta.url).pathname], {
    env: {
      ...process.env,
      DATA_DIR: root,
      PORT: '0',
      AUTH_PASSWORD: '',
      AUTH_SESSION_SECRET: '',
      EPG_URL: '',
      EPG_SIDECAR_URL: '',
      M3U_URL: '',
      REFRESH_INTERVAL_MINUTES: '0',
      RATE_LIMIT_DISABLED: '1',
      CORS_ALLOWED_ORIGINS: allowedOrigins,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !logs.includes('TEST_PORT='); i++) await new Promise((r) => setTimeout(r, 10));
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1];
  assert.ok(port, logs);

  const probe = async (origin) => {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const res = await fetch(`http://127.0.0.1:${port}/api/probe`, { method: 'POST', headers, body: '{}' });
    return res.status;
  };
  return { port, probe };
}

test('an allow-listed origin may mutate, whatever form the entry takes', { timeout: 20000 }, async (t) => {
  const { port, probe } = await startApi(t, 'example.test:8080, https://app.example.test, plain.example.test');

  // The regression: a schemeless host:port entry. Accepted by CORS, and now by the
  // mutation guard too — on either scheme, since the entry pins neither.
  assert.notEqual(await probe('http://example.test:8080'), REJECTED, 'schemeless host:port, http');
  assert.notEqual(await probe('https://example.test:8080'), REJECTED, 'schemeless host:port, https');

  // A host-only entry matches any port, as the configuration comment documents.
  assert.notEqual(await probe('http://plain.example.test'), REJECTED, 'host-only entry');
  assert.notEqual(await probe('https://plain.example.test:9999'), REJECTED, 'host-only entry, any port');

  // An entry that names a scheme is matched exactly.
  assert.notEqual(await probe('https://app.example.test'), REJECTED, 'exact scheme-qualified entry');

  // Same-origin and header-less requests are unaffected.
  assert.notEqual(await probe(`http://127.0.0.1:${port}`), REJECTED, 'same origin');
  assert.notEqual(await probe(null), REJECTED, 'no Origin header');
});

test('listing https://host does not also admit http://host', { timeout: 20000 }, async (t) => {
  const { probe } = await startApi(t, 'https://app.example.test');

  assert.notEqual(await probe('https://app.example.test'), REJECTED, 'the scheme that was listed');
  assert.equal(await probe('http://app.example.test'), REJECTED, 'downgrading to http must not be admitted');
});

test('an unlisted origin is rejected', { timeout: 20000 }, async (t) => {
  const { probe } = await startApi(t, 'https://app.example.test');

  assert.equal(await probe('https://evil.test'), REJECTED);
  assert.equal(await probe('https://app.example.test.evil.test'), REJECTED, 'suffix must not match');
});

// "*" is a concession for reading. Absent or wildcard configuration must never be
// read as "any site may write" — that would make the guard pointless by default.
test('neither "*" nor an empty allow-list grants mutation', { timeout: 20000 }, async (t) => {
  const wildcard = await startApi(t, '*');
  assert.equal(await wildcard.probe('https://evil.test'), REJECTED, 'wildcard must not grant writes');
  assert.notEqual(await wildcard.probe(null), REJECTED, 'same-origin still works under wildcard');

  const empty = await startApi(t, '');
  assert.equal(await empty.probe('https://evil.test'), REJECTED, 'empty list must not grant writes');
  assert.notEqual(await empty.probe(null), REJECTED, 'same-origin still works with no list');
});
