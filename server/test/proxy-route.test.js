import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

test('actual proxy API rejects oversized manifests and keeps normal playback path', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-proxy-route-'));
  const hook = path.join(root, 'port.mjs');
  await fs.writeFile(hook, `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`);
  const origin = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end(req.url === '/big' ? '#EXTM3U\n#' + 'x'.repeat(2 * 1024 * 1024) : '#EXTM3U\nseg.ts\n');
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href,
    process.env.AUD006_SERVER_ENTRY || new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: root, PORT: '0', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '',
      EPG_URL: '', EPG_SIDECAR_URL: '', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1',
      PROXY_BLOCK_PRIVATE: '1', PROXY_ALLOWED_CIDRS: '127.0.0.1/32' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (v) => { logs += v; }); child.stderr.on('data', (v) => { logs += v; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !logs.includes('TEST_PORT='); i++) await new Promise((r) => setTimeout(r, 10));
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1]; assert.ok(port, logs);
  const base = `http://127.0.0.1:${port}`;
  const proxy = (name) => fetch(base + '/api/proxy?url=' + encodeURIComponent(`http://127.0.0.1:${origin.address().port}/${name}`));
  const big = await proxy('big'); assert.equal(big.status, 502); await big.text();
  const normal = await proxy('guide'); assert.equal(normal.status, 200);
  assert.match(await normal.text(), /api\/proxy\?url=/);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});
