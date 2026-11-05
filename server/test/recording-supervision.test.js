import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
const { createCaptureManager } = await import('../lib/recorder.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-supervisor-'));
  const fake = path.join(root, 'ffmpeg');
  await fs.writeFile(fake, `#!${process.execPath}
const fs=require('node:fs'); fs.writeFileSync(process.argv.at(-1)+'.pid',String(process.pid));
if(process.env.SUPERVISOR_STUB==='progress') {let n=0;setInterval(()=>process.stdout.write('out_time_us='+(++n)+'\\n'),20);}
process.on('SIGINT',()=>{});setInterval(()=>{},1000);
`, { mode: 0o755 });
  const manager = createCaptureManager({ maxConcurrent: 1, idleTimeoutMs: 2000, stopGraceMs: 70, ffmpegPath: fake, ...options });
  t.after(async () => { await manager.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager };
}
function capture(f, id, options = {}) {
  let calls = 0;
  let resolve;
  const finished = new Promise((r) => { resolve = r; });
  const started = Date.now();
  f.manager.startCapture({ rec: { id, url: 'http://fixture.invalid/' }, dataDir: f.root, maxMinutes: 1,
    onFinish(patch) { calls++; resolve(patch); }, ...options });
  return { finished, calls: () => calls, started };
}
test('wall deadline force-kills a child ignoring graceful stop, then finalizes once', async (t) => {
  const f = await fixture(t);
  const c = capture(f, 'deadline', { deadlineAt: Date.now() + 500 });
  const result = await c.finished;
  await f.manager.stopAll();
  assert.equal(result.stopReason, 'deadline'); assert.equal(c.calls(), 1);
  assert.ok(Date.now() - c.started < 2000);
  assert.equal(f.manager.isRecording('deadline'), false);
  const pid = Number(await fs.readFile(path.join(f.root, 'recordings/deadline.mp4.pid')));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('idle timeout supervises a silent child independently of the wall deadline', async (t) => {
  const f = await fixture(t, { idleTimeoutMs: 120 });
  const c = capture(f, 'idle');
  const result = await c.finished; await f.manager.stopAll();
  assert.equal(result.stopReason, 'idle-timeout'); assert.equal(result.status, 'failed'); assert.equal(c.calls(), 1);
});
test('advancing progress preserves activity until the wall deadline', async (t) => {
  const old = process.env.SUPERVISOR_STUB; process.env.SUPERVISOR_STUB = 'progress';
  t.after(() => { if (old === undefined) delete process.env.SUPERVISOR_STUB; else process.env.SUPERVISOR_STUB = old; });
  const f = await fixture(t, { idleTimeoutMs: 750 });
  const c = capture(f, 'progress', { deadlineAt: Date.now() + 1500 });
  await sleep(1100); assert.equal(f.manager.isRecording('progress'), true);
  assert.equal((await c.finished).stopReason, 'deadline');
});
test('capacity, invalid limits and repeated Stop do not spawn or finalize extra children', async (t) => {
  const f = await fixture(t);
  for (const value of [0, -1, NaN, Infinity, '1', 1e20]) {
    assert.throws(() => capture(f, 'invalid', { maxMinutes: value }), /Invalid recording duration/);
  }
  assert.throws(() => capture(f, 'expired', { deadlineAt: Date.now() - 1 }), /deadline/);
  const first = capture(f, 'one');
  assert.throws(() => capture(f, 'two'), { code: 'RECORDING_CAPACITY', status: 503 });
  assert.equal(f.manager.stopCapture('one'), true); f.manager.stopCapture('one');
  await first.finished; await sleep(10); assert.equal(first.calls(), 1);
  const next = capture(f, 'two'); f.manager.stopCapture('two'); await next.finished;
  assert.equal(await fs.stat(path.join(f.root, 'recordings/invalid.mp4.pid')).then(() => true, () => false), false);
  await f.manager.stopAll();
  assert.throws(() => capture(f, 'late'), { status: 503 });
});
test('spawn failure closes exactly once and releases capacity', async (t) => {
  const f = await fixture(t, { ffmpegPath: '/nonexistent/fixture-ffmpeg' });
  const c = capture(f, 'missing'); await c.finished; await sleep(10);
  assert.equal(c.calls(), 1); assert.equal(f.manager.isRecording('missing'), false);
});
for (const route of ['headers', 'midstream']) test('real ffmpeg stalled ' + route + ' releases sockets at wall deadline', { timeout: 10000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-real-supervisor-'));
  const media = path.join(root, 'sample.ts');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', media], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(generated.error); assert.equal(generated.status, 0, generated.stderr);
  const bytes = await fs.readFile(media); let closed = false;
  const origin = http.createServer((req, res) => { req.on('close', () => { closed = true; }); if (route === 'midstream') { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.write(bytes); } });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const manager = createCaptureManager({ idleTimeoutMs: 3000, stopGraceMs: 100 });
  t.after(async () => { await manager.stopAll(); origin.closeAllConnections(); origin.close(); await fs.rm(root, { recursive: true, force: true }); });
  let finish; const finished = new Promise((r) => { finish = r; });
  const started = Date.now();
  manager.startCapture({ rec: { id: 'real', url: `http://127.0.0.1:${origin.address().port}/` }, dataDir: root, maxMinutes: 1 / 60, onFinish: finish });
  assert.equal((await finished).stopReason, 'deadline'); await manager.stopAll();
  assert.ok(Date.now() - started < 2500); assert.equal(manager.isRecording('real'), false);
  for (let i = 0; i < 50 && !closed; i++) await sleep(10);
  assert.equal(closed, true);
});


test('Stop racing the deadline shares one terminal callback', async (t) => {
  const f = await fixture(t);
  const c = capture(f, 'race', { deadlineAt: Date.now() + 250 });
  const timer = setTimeout(() => { f.manager.stopCapture('race'); f.manager.stopCapture('race'); }, 250);
  t.after(() => clearTimeout(timer));
  const result = await c.finished; await f.manager.stopAll();
  assert.ok(['deadline', 'stopped'].includes(result.stopReason)); assert.equal(c.calls(), 1);
});
