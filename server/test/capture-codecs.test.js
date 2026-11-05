import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
process.env.PROXY_BLOCK_PRIVATE = process.env.AUD008_STRICT || '';
process.env.PROXY_ALLOWED_CIDRS = '127.0.0.1/32';
const { createCaptureManager } = await import('../lib/recorder.js');
function command(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
}
test('generated AAC HLS/direct MP4 and MP3 copy cleanly without a blanket AAC filter', { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-codecs-'));
  const manager = createCaptureManager();
  t.after(async () => { await manager.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  command(['-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-g','10','-sc_threshold','0','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0',path.join(root,'source.m3u8')]);
  command(['-i',path.join(root,'source.m3u8'),'-c','copy','-movflags','+faststart',path.join(root,'direct.mp4')]);
  command(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:a','libmp3lame',path.join(root,'audio.mp3')]);
  const names = await fs.readdir(root);
  const assets = Object.fromEntries(await Promise.all(names.map(async (n) => ['/'+n,await fs.readFile(path.join(root,n))])));
  const origin = http.createServer((req,res) => {
    const body = assets[req.url]; if (!body) { res.writeHead(404); res.end(); return; }
    if (req.url.endsWith('.m3u8')) res.setHeader('content-type','application/vnd.apple.mpegurl');
    res.end(body);
  });
  await new Promise((r) => origin.listen(0,'127.0.0.1',r));
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  for (const [id, resource, expected] of [['hls','source.m3u8',['aac','h264']],['direct','direct.mp4',['aac','h264']],['mp3','audio.mp3',['mp3']]]) {
    let resolve; const finished = new Promise((r) => { resolve=r; });
    manager.startCapture({ rec:{id,url:`http://127.0.0.1:${origin.address().port}/${resource}`},dataDir:root,maxMinutes:1/60,onFinish:resolve });
    const result=await finished;
    assert.equal(result.status,'completed',result.error); assert.equal(result.partial,false); assert.equal(result.exitCode,0);
    const output=path.join(root,'recordings',result.filename);
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name','-of','json',output],{encoding:'utf8',timeout:5000});
    assert.equal(probe.status,0,probe.stderr); const meta=JSON.parse(probe.stdout);
    assert.deepEqual(meta.streams.map((s)=>s.codec_name).sort(),expected);
    assert.ok(Number(meta.format.duration)>=0.9 && Number(meta.format.duration)<1.5,meta.format.duration);
    command(['-i',output,'-f','null','-']);
    if(process.env.AUD008_MEDIA_DIR) { await fs.mkdir(process.env.AUD008_MEDIA_DIR,{recursive:true});await fs.copyFile(output,path.join(process.env.AUD008_MEDIA_DIR,id+'.mp4')); }
  }
});
