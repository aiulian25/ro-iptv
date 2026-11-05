import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { recordingHttpFixture } from './helpers/recording-http-fixture.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('authenticated recording HTTP ranges, native media and file lifecycle', { timeout: 20000 }, async t => {
  const f = await recordingHttpFixture(); t.after(f.cleanup);
  const get = (id, range, options = {}) => fetch(`${f.base}/api/recordings/${id}/file${options.download ? '?dl=1' : ''}`, { method: options.method || 'GET', headers: { cookie: f.cookie, ...(range ? { range } : {}), ...options.headers } });
  await t.test('suffix range returns exactly the final four bytes', async () => {
    const r = await get('fixed', 'bytes=-4'); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 12-15/16'); assert.equal(r.headers.get('content-length'), '4'); assert.equal(await r.text(), 'cdef');
  });
  if (process.env.AUD023_BASELINE) return;
  await t.test('closed, open-ended, oversized and zero-padded integers have exact bounds', async () => {
    for (const [range, expected, span] of [
      ['bytes=0-3', '0123', '0-3'], ['bytes=12-', 'cdef', '12-15'], ['bytes=0-0', '0', '0-0'],
      ['bytes=15-99', 'f', '15-15'], ['bytes=-99', '0123456789abcdef', '0-15'], ['bytes=0001-0003', '123', '1-3'],
      ['bytes=-99999999999999999999999999999999', '0123456789abcdef', '0-15'],
      ['bytes=12-99999999999999999999999999999999', 'cdef', '12-15'], ['BYTES= 1-3', '123', '1-3'],
    ]) {
      const r = await get('fixed', range); assert.equal(r.status, 206, range); assert.equal(r.headers.get('content-range'), `bytes ${span}/16`); assert.equal(r.headers.get('content-length'), String(expected.length)); assert.equal(await r.text(), expected);
    }
  });
  await t.test('malformed and unsatisfiable byte ranges return an empty 416 with current size', async () => {
    for (const range of ['bytes=16-', 'bytes=100-200', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=abc', 'bytes=1-2junk', 'bytes=1-2=3', 'bytes=+1-2', 'bytes=1.5-2', 'bytes=1 - 2', 'bytes=99999999999999999999999999999999-']) {
      const r = await get('fixed', range); assert.equal(r.status, 416, range); assert.equal(r.headers.get('content-range'), 'bytes */16'); assert.equal(await r.text(), '');
    }
  });
  await t.test('full downloads, unknown units and unsupported multiple ranges use full 200', async () => {
    for (const range of [null, 'items=0-3', 'bytes=0-1,4-5']) {
      const r = await get('fixed', range, { download: true }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-range'), null); assert.equal(r.headers.get('content-length'), '16'); assert.equal(r.headers.get('accept-ranges'), 'bytes'); assert.equal(r.headers.get('content-type'), 'video/mp4'); assert.match(r.headers.get('content-disposition'), /attachment; filename="Fixture _ title.mp4"/); assert.equal(await r.text(), '0123456789abcdef');
    }
  });
  await t.test('If-Range without an advertised validator conservatively sends the full file', async () => {
    const r = await get('fixed', 'bytes=0-3', { headers: { 'if-range': '"obsolete-validator"' } }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-range'), null); assert.equal(await r.text(), '0123456789abcdef');
  });
  await t.test('HEAD ignores Range; empty files have full 200 and no invalid byte span', async () => {
    const head = await get('fixed', 'bytes=-4', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '16'); assert.equal(head.headers.get('content-range'), null); assert.equal(await head.text(), '');
    for (const range of [null, 'bytes=0-', 'bytes=-4']) { const r = await get('empty', range); assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), '0'); assert.equal(r.headers.get('content-range'), null); assert.equal(await r.text(), ''); }
  });
  await t.test('authentication, filename containment, missing files and directories remain guarded', async () => {
    assert.equal((await fetch(f.base + '/api/recordings/fixed/file', { headers: { range: 'bytes=-4' } })).status, 401);
    for (const [id, status] of [['bad', 400], ['missing', 404], ['absent', 404], ['directory', 404], ['vanish', 404]]) { const r = await get(id); assert.equal(r.status, status, id); assert.equal(r.headers.get('content-range'), null); await r.arrayBuffer(); }
  });
  await t.test('an already opened file survives unlink without a second path open', async () => {
    const r = await get('unlinked', 'bytes=-4'); assert.equal(r.status, 206); assert.equal(await r.text(), 'cdef'); await assert.rejects(fs.stat(path.join(f.dir, 'unlinked.mp4')), { code: 'ENOENT' });
  });
  await t.test('generated MP4 range downloads reconstruct the original playable file', async () => {
    const movie = path.join(f.dir, 'movie.mp4');
    const generated = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',movie], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(generated.error); assert.equal(generated.status, 0, generated.stderr);
    const source = await fs.readFile(movie), boundary = Math.floor(source.length / 2);
    const first = await get('movie', `bytes=0-${boundary - 1}`), last = await get('movie', `bytes=${boundary}-`), tail = await get('movie', 'bytes=-64');
    assert.equal(first.status, 206); assert.equal(last.status, 206); assert.deepEqual(Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await last.arrayBuffer())]), source); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), source.subarray(-64));
    const download = await get('movie', null, { download: true }); assert.deepEqual(Buffer.from(await download.arrayBuffer()), source);
  });
  await t.test('a read failure terminates the response while the server remains available', async () => {
    await assert.rejects(async () => { const r = await get('readerror'); await r.arrayBuffer(); });
    const r = await get('fixed', 'bytes=0-0'); assert.equal(await r.text(), '0'); assert.equal(f.child.exitCode, null);
  });
  await t.test('client disconnect cancels reading and closes every task-opened descriptor', async () => {
    await new Promise((resolve, reject) => {
      const req = http.get(f.base + '/api/recordings/large/file', { headers: { cookie: f.cookie } }, response => {
        response.once('data', () => { response.destroy(); resolve(); }); response.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      }); req.once('error', reject);
    });
    let metrics;
    for (let i = 0; i < 100; i++) { metrics = await f.metrics(); if (metrics.opened > 0 && metrics.opened === metrics.closed) break; await sleep(10); }
    assert.ok(metrics.opened > 0); assert.equal(metrics.closed, metrics.opened, JSON.stringify(metrics));
    const r = await get('fixed', 'bytes=0-0'); assert.equal(await r.text(), '0'); assert.equal(f.child.exitCode, null);
  });
});
