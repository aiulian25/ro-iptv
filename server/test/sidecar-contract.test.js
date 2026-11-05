import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
const wait = ms => new Promise(r => setTimeout(r, ms));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-aud020-contract-'));
test.after(() => fs.rm(root, { recursive: true, force: true }));
const sidecarModule = new URL('../lib/epgstore.js', import.meta.url).href;
const httpModule = new URL('../lib/http.js', import.meta.url).href;
function baseEnv(dir, extra = {}) {
  const env = { ...process.env, DATA_DIR: dir, PORT: '57017', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '', M3U_URL: '', EPG_URL: '', EPG_SIDECAR_ENABLED: '0', EPG_SIDECAR_URL: '', REFRESH_INTERVAL_MINUTES: '360', PROXY_BLOCK_PRIVATE: '1', PROXY_ALLOWED_CIDRS: '', RATE_LIMIT_DISABLED: '', RL_LOGIN_MAX: '2', ...extra };
  delete env.NODE_TEST_CONTEXT; return env;
}
test('sidecar activation gates source registration and the exact private-target exception together', async () => {
  for (const flag of ['0', '', '1']) {
    const dir = await fs.mkdtemp(path.join(root, 'sources-'));
    const script = `const e=await import(${JSON.stringify(sidecarModule)});const h=await import(${JSON.stringify(httpModule)});console.log(JSON.stringify({urls:await e.configuredEpgUrls(),blocked:h.isBlockedTarget(process.env.EPG_SIDECAR_URL),sibling:h.isBlockedTarget('http://127.0.0.1:9/other')}))`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: baseEnv(dir, { EPG_SIDECAR_ENABLED: flag, EPG_SIDECAR_URL: 'http://127.0.0.1:9/guide.xml' }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout);
    assert.deepEqual(value.urls, flag === '1' ? ['http://127.0.0.1:9/guide.xml'] : []);
    assert.equal(value.blocked, flag !== '1'); assert.equal(value.sibling, true);
  }
});
test('invalid activation and enabled-without-valid-URL fail before listening', async () => {
  for (const [flag, url] of [['true', 'http://epg/guide.xml'], ['1', ''], ['1', 'file:///data/guide.xml']]) {
    const dir = await fs.mkdtemp(path.join(root, 'invalid-'));
    const result = spawnSync(process.execPath, [new URL('../index.js', import.meta.url).pathname], { env: baseEnv(dir, { EPG_SIDECAR_ENABLED: flag, EPG_SIDECAR_URL: url }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /server listening/); assert.match(result.stderr, /EPG_SIDECAR/);
  }
});
async function start(dir, extra = {}) {
  await fs.mkdir(dir, { recursive: true });
  const hook = path.join(dir, 'hook.mjs');
  await fs.writeFile(hook, `import net from 'node:net';import http from 'node:http';import https from 'node:https';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(port,...args){console.log('REQUESTED_PORT='+port);this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.call(this,0,...args)};for(const transport of [http,https]){const request=transport.request;transport.request=function(...args){console.log('NETWORK_REQUEST');return request.apply(this,args)}};const original=globalThis.fetch;globalThis.fetch=(...args)=>{console.log('NETWORK_REQUEST');return original(...args)};`);
  let logs = '';
  const child = spawn(process.execPath, ['--import', hook, new URL('../index.js', import.meta.url).pathname], { env: baseEnv(dir, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const close = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } if (process.env.AUD020_LOG_DIR) { await fs.mkdir(process.env.AUD020_LOG_DIR, { recursive: true }); await fs.writeFile(path.join(process.env.AUD020_LOG_DIR, path.basename(dir) + '.log'), logs); } };
  for (let n = 0; n < 400 && !logs.includes('TEST_PORT='); n++) await wait(10);
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1]; if (!port) { await close(); throw new Error('Candidate failed to start: ' + logs); }
  return { base: 'http://127.0.0.1:' + port, close, logs: () => logs };
}
test('offline sidecar-off boot makes no sidecar/dataset requests; enabled peer and unavailable peer are distinct', { timeout: 20000 }, async t => {
  let hits = 0;
  const peer = http.createServer((req, res) => { hits++; if (req.url === '/dead.xml') res.writeHead(503).end('unavailable'); else res.end('<tv></tv>'); });
  await new Promise(r => peer.listen(0, '127.0.0.1', r));
  t.after(() => { peer.closeAllConnections(); return new Promise(r => peer.close(r)); });
  const url = 'http://127.0.0.1:' + peer.address().port;
  for (const [mode, flag, suffix] of [['off', '0', '/guide.xml'], ['on', '1', '/guide.xml'], ['unavailable', '1', '/dead.xml']]) {
    const dir = path.join(root, mode); const server = await start(dir, { EPG_SIDECAR_ENABLED: flag, EPG_SIDECAR_URL: url + suffix });
    try {
      assert.match(server.logs(), /REQUESTED_PORT=57017/);
      for (let n = 0; n < 200; n++) { try { const health = JSON.parse(await fs.readFile(path.join(dir, 'epg-health.json'))); if (flag === '0' || health.length) break; } catch {} await wait(10); }
      await wait(100);
      const status = await (await fetch(server.base + '/api/epg/sidecar')).json();
      assert.equal(status.configured, flag === '1'); assert.equal(status.live, mode === 'on');
      if (mode === 'off') { assert.equal(hits, 0); assert.doesNotMatch(server.logs(), /NETWORK_REQUEST|EPG sidecar configured/); assert.equal(await fs.access(path.join(dir, 'epg/channels.xml')).then(() => true, () => false), false); }
      else { assert.match(server.logs(), /EPG sidecar configured/); if (mode === 'unavailable') assert.ok(status.error); }
    } finally { await server.close(); }
  }
});
test('synthetic pinned secret/login rate reach runtime and stored auth survives empty bootstrap restart', { timeout: 20000 }, async () => {
  const dir = path.join(root, 'auth-runtime'), secret = 'synthetic-session-signing-secret';
  let server = await start(dir, { AUTH_PASSWORD: 'SyntheticBootstrap123', AUTH_SESSION_SECRET: secret, HSTS_MAX_AGE: '12345' });
  const post = (route, body, cookie) => fetch(server.base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.match((await fetch(server.base + '/api/auth/status')).headers.get('strict-transport-security'), /max-age=12345/);
    const login = await post('/api/auth/login', { username: 'admin', password: 'SyntheticBootstrap123' }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0]; const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const [payload, signature] = token.split('.'); assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
    const password = await post('/api/auth/password', { newPassword: 'Replacement123', remember: false }, cookie); assert.equal(password.status, 200);
    await server.close(); server = await start(dir, { AUTH_PASSWORD: '', AUTH_SESSION_SECRET: secret });
    assert.equal((await (await fetch(server.base + '/api/auth/status')).json()).authRequired, true);
    assert.equal((await post('/api/auth/login', { username: 'admin', password: 'Replacement123' })).status, 200);
    assert.equal((await post('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await post('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 429);
  } finally { await server.close(); }
});
