import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const invalidIds = ['../outside', '/tmp/outside', 'a/b', 'a\\b', '', 42, null, {}, [], 'bad\n'];
test('schedule API and scheduler enforce safe writer IDs', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-schedule-'));
  const dir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  await fs.mkdir(dir);
  await fs.mkdir(bin);
  const hook = path.join(root, 'timers.mjs');
  await fs.writeFile(hook, `import net from 'node:net'; const listen = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { this.once('listening', () => console.log('TEST_PORT=' + this.address().port)); return listen.apply(this, args); }; const interval = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 30000 ? 20 : ms, ...args);`);
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const output = process.argv.at(-1);
fs.appendFileSync(path.join(process.env.DATA_DIR, 'spawned'), output + '\\n');
if (path.dirname(output) !== path.join(process.env.DATA_DIR, 'recordings')) process.exit(9);
fs.writeFileSync(output, 'synthetic capture');
`, { mode: 0o755 });
  const start = new Date(Date.now() - 1000).toISOString();
  const end = new Date(Date.now() + 60000).toISOString();
  const job = { url: 'http://fixture.invalid/media', start, end, status: 'scheduled' };
  await fs.writeFile(path.join(dir, 'recordings.json'), JSON.stringify([
    ...invalidIds.map((id) => ({ ...job, id })),
    { ...job, id: 'invalid-time', end: 'invalid' },
    { ...job, id: 'legacy-job' },
  ]));
  let logs = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: dir, PATH: bin + path.delimiter + process.env.PATH,
      PORT: '0', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '', EPG_URL: '', EPG_SIDECAR_URL: '', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (v) => { logs += v; });
  child.stderr.on('data', (v) => { logs += v; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!logs.includes('TEST_PORT=') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1];
  assert.ok(port, logs);
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(base + '/api/recordings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const id of invalidIds) assert.equal((await post({ ...job, id })).status, 400, JSON.stringify(id));
  for (const extra of [{ status: 'completed' }, { filename: 'chosen.mp4' }, { size: 99 }, { start: 'bad' }, { end: start }, { start: 42 }, { start: null }]) {
    assert.equal((await post({ ...job, ...extra })).status, 400);
  }
  assert.equal((await post({ ...job, id: 'unknown-safe-id' })).status, 404);
  const future = { ...job, start: new Date(Date.now() + 60000).toISOString(), end: new Date(Date.now() + 120000).toISOString() };
  const createdResponse = await post(future);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  assert.equal((await post({ ...future, id: created.id, title: 'Updated' })).status, 200);
  const capturingResponse = await post(job);
  assert.equal(capturingResponse.status, 200);
  const capturing = await capturingResponse.json();
  let rows;
  for (let i = 0; i < 200; i++) {
    rows = await (await fetch(base + '/api/recordings')).json();
    if (['legacy-job', capturing.id].every((id) => rows.find((r) => r.id === id)?.status === 'completed')) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(rows.find((r) => r.id === 'legacy-job').status, 'completed');
  assert.ok(rows.filter((r) => r.id !== created.id && r.id !== capturing.id && r.id !== 'legacy-job').every((r) => r.status === 'failed'));
  assert.equal((await post({ ...future, id: 'legacy-job' })).status, 409);
  const outputs = (await fs.readFile(path.join(dir, 'spawned'), 'utf8')).trim().split('\n');
  assert.equal(rows.find((r) => r.id === capturing.id).status, 'completed');
  assert.deepEqual(outputs.sort(), ['legacy-job', capturing.id].map((id) => path.join(dir, 'recordings', id + '.mp4')).sort());
  assert.equal(await fs.readFile(outputs[0], 'utf8'), 'synthetic capture');
  assert.equal(await fs.stat(path.join(dir, 'outside.mp4')).then(() => true, () => false), false);
});
