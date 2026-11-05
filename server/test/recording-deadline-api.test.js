import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('API validates durations, reports capacity, honors scheduled end and persists shutdown', { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-deadline-api-'));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
const fs=require('node:fs'); fs.writeFileSync(process.argv.at(-1),'synthetic partial');
fs.writeFileSync(process.argv.at(-1)+'.pid',String(process.pid));if(process.argv[process.argv.indexOf('-i')+1].endsWith('/failure')){process.stderr.write('synthetic-private-diagnostic');process.exit(7)};process.on('SIGINT',()=>{});setInterval(()=>{},1000);
`, { mode: 0o755 });
  const hook = path.join(root, 'port.mjs');
  await fs.writeFile(hook, `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?30:ms,...args);`);
  const env = { ...process.env, DATA_DIR: root, PATH: bin + path.delimiter + process.env.PATH,
    PORT: '0', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '', EPG_URL: '', EPG_SIDECAR_URL: '', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0',
    PROXY_BLOCK_PRIVATE: '', PROXY_ALLOWED_CIDRS: '', RATE_LIMIT_DISABLED: '1', RECORDING_MAX_MINUTES: '0.04', RECORDING_MAX_CONCURRENT: '1' };
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, new URL('../index.js', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (v) => { logs += v; }); child.stderr.on('data', (v) => { logs += v; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !logs.includes('TEST_PORT='); i++) await sleep(10);
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1]; assert.ok(port, logs);
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const body = { url: 'http://fixture.invalid/media' };
  for (const durationMinutes of [0, -1, null, false, '', 'bad', 'Infinity', {}, []]) {
    assert.equal((await post('/api/recordings/start', { ...body, durationMinutes })).status, 400);
  }
  const firstResponse = await post('/api/recordings/start', { ...body, durationMinutes: '1' });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(Date.parse(first.end) - Date.parse(first.start), 2400);
  assert.equal((await post('/api/recordings/start', body)).status, 503);
  let rows;
  for (let i = 0; i < 150; i++) {
    rows = await (await fetch(base + '/api/recordings')).json();
    if (rows.find((r) => r.id === first.id)?.stopReason === 'deadline') break;
    await sleep(30);
  }
  const terminalFirst = rows.find((r) => r.id === first.id);
  assert.equal(terminalFirst.stopReason, 'deadline');
  assert.equal(terminalFirst.status, 'interrupted');
  assert.equal(terminalFirst.exitSignal, 'SIGKILL');
  assert.equal(terminalFirst.partial, true);
  const capacity = rows.find((r) => r.id !== first.id); assert.equal(capacity.status, 'failed'); assert.equal(capacity.filename, '');
  const failureResponse = await post('/api/recordings/start', { url: 'http://fixture.invalid/failure' });
  assert.equal(failureResponse.status, 200); const failed = await failureResponse.json();
  let failure;
  for (let i = 0; i < 100; i++) {
    const current = await (await fetch(base + '/api/recordings')).json(); failure = current.find((r) => r.id === failed.id);
    if (failure.status === 'failed') break; await sleep(20);
  }
  assert.equal(failure.status, 'failed'); assert.equal(failure.exitCode, 7); assert.equal(failure.partial, true);
  assert.doesNotMatch(failure.error, /synthetic-private-diagnostic/);
  const download = await fetch(base + '/api/recordings/' + failed.id + '/file?dl=1');
  assert.equal(download.status, 200); assert.equal(await download.text(), 'synthetic partial');
  const end = Date.now() + 1000;
  const scheduledResponse = await post('/api/recordings', { ...body, start: new Date().toISOString(), end: new Date(end).toISOString() });
  assert.equal(scheduledResponse.status, 200); const scheduled = await scheduledResponse.json();
  let terminal;
  for (let i = 0; i < 120; i++) {
    rows = await (await fetch(base + '/api/recordings')).json(); terminal = rows.find((r) => r.id === scheduled.id);
    if (terminal?.stopReason === 'deadline') break; await sleep(30);
  }
  assert.equal(terminal.stopReason, 'deadline'); assert.ok(Date.parse(terminal.end) <= end + 1500);
  const shutdownResponse = await post('/api/recordings/start', body); assert.equal(shutdownResponse.status, 200);
  const shutdown = await shutdownResponse.json(); await sleep(80);
  const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'recordings.json'), 'utf8'));
  assert.equal(stored.find((r) => r.id === shutdown.id).stopReason, 'shutdown');
  const pid = Number(await fs.readFile(path.join(root, 'recordings', shutdown.id + '.mp4.pid')));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('invalid duration/concurrency/idle environment settings prevent listening', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-invalid-recording-env-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [key, value] of [['RECORDING_MAX_MINUTES', 'NaN'], ['RECORDING_MAX_MINUTES', '0'], ['RECORDING_MAX_CONCURRENT', '1.5'], ['RECORDING_INPUT_IDLE_SECONDS', 'Infinity']]) {
    const result = spawnSync(process.execPath, [new URL('../index.js', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: root, PORT: '0', [key]: value }, encoding: 'utf8', timeout: 3000,
    });
    assert.ifError(result.error); assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /server listening/);
  }
});
