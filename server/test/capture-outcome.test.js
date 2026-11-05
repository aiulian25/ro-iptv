import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const recorder = await import(process.env.AUD008_RECORDER_MODULE || '../lib/recorder.js');
async function setup(t, script, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-outcome-'));
  const fake = path.join(root, 'ffmpeg');
  await fs.writeFile(fake, '#!' + process.execPath + '\n' + script, { mode: 0o755 });
  const manager = recorder.createCaptureManager({ ffmpegPath: fake, idleTimeoutMs: 3000, stopGraceMs: 50, ...options });
  t.after(async () => { await manager.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager };
}
const partial = `const fs=require('node:fs');fs.writeFileSync(process.argv.at(-1),'SYNTHETIC-PARTIAL');`;
function run(f, options = {}) {
  let resolve, calls = 0;
  const done = new Promise((r) => { resolve = r; });
  f.manager.startCapture({ rec: { id: 'capture', url: 'http://fixture.invalid/' }, dataDir: f.root, maxMinutes: 1,
    onFinish(patch) { calls++; resolve(patch); }, ...options });
  return { done, calls: () => calls };
}
for (const code of [0, 7]) test('nonempty exit ' + code + ' retains truthful outcome and sanitized diagnostics', async (t) => {
  const f = await setup(t, partial + `process.stderr.write('http://user:synthetic-password@fixture.invalid/secret/path?token=synthetic-token\\n');process.exit(${code});`);
  const capture = run(f); const result = await capture.done; await f.manager.stopAll();
  assert.equal(result.status, code ? 'failed' : 'completed'); assert.equal(result.exitCode, code);
  assert.equal(result.partial, !!code); assert.equal(result.filename, 'capture.mp4'); assert.equal(result.size, 17);
  assert.doesNotMatch(result.error, /synthetic-|user:|fixture.invalid|secret\/path/); assert.equal(capture.calls(), 1);
  if (code) assert.match(result.error, /exit code 7/);
  assert.equal(await fs.readFile(path.join(f.root, 'recordings', result.filename), 'utf8'), 'SYNTHETIC-PARTIAL');
});
test('empty exit zero fails instead of Saved', async (t) => {
  const f = await setup(t, 'process.exit(0)');
  const result = await run(f).done;
  assert.equal(result.status, 'failed'); assert.equal(result.filename, ''); assert.equal(result.partial, false);
});
for (const reason of ['stopped', 'deadline', 'shutdown']) test('graceful ' + reason + ' classifies intentionally', async (t) => {
  const f = await setup(t, partial + `process.on('SIGINT',()=>{process.stderr.write('fixture-private-token');process.exit(255)});fs.writeFileSync(process.argv.at(-1)+'.ready','ready');setInterval(()=>{},1000);`, { stopGraceMs: 1000 });
  const capture = run(f, reason === 'deadline' ? { deadlineAt: Date.now() + 1000 } : {});
  if (reason !== 'deadline') {
    // Wait until the fixture has initialized its signal handler.
    for (let i = 0; i < 100; i++) { if (await fs.stat(path.join(f.root, 'recordings/capture.mp4.ready')).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 10)); }
    if (reason === 'shutdown') f.manager.stopAll(); else f.manager.stopCapture('capture');
  }
  const result = await capture.done; await f.manager.stopAll();
  assert.equal(result.status, reason === 'shutdown' ? 'interrupted' : 'completed');
  assert.equal(result.stopReason, reason); assert.equal(result.partial, reason === 'shutdown'); assert.equal(capture.calls(), 1);
  assert.doesNotMatch(result.error, /fixture-private-token/);
});
test('forced Stop preserves partial bytes with interrupted status and signal', async (t) => {
  const f = await setup(t, partial + "process.on('SIGINT',()=>{});setInterval(()=>{},1000);");
  const result = await run(f, { deadlineAt: Date.now() + 500 }).done;
  assert.equal(result.status, 'interrupted'); assert.equal(result.exitSignal, 'SIGKILL'); assert.equal(result.partial, true);
});
test('unexpected signal is interrupted, not Saved', async (t) => {
  const f = await setup(t, partial + "process.kill(process.pid,'SIGTERM');");
  const result = await run(f).done;
  assert.equal(result.status, 'interrupted'); assert.equal(result.exitSignal, 'SIGTERM'); assert.equal(result.partial, true);
});


test('late mux error on intentional stop remains failed and keeps safe diagnostic', async (t) => {
  const f = await setup(t, partial + `process.on('SIGINT',()=>{process.stderr.write('Malformed AAC bitstream http://secret-fixture.invalid/token');process.exit(255)});setInterval(()=>{},1000);`, { stopGraceMs: 1000 });
  const result = await run(f, { deadlineAt: Date.now() + 1000 }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.partial, true);
  assert.match(result.error, /AAC audio/); assert.doesNotMatch(result.error, /secret-fixture/);
});
