import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
process.env.PROXY_BLOCK_PRIVATE='1';
process.env.PROXY_ALLOWED_CIDRS='127.0.0.1/32';
const {startCapture}=await import('../lib/recorder.js');

test('real ffmpeg strict capture uses pipe input for generated HLS and direct media', {timeout:15000}, async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-capture-egress-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source.ts');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-f','mpegts',source],{encoding:'utf8',timeout:10000});
  assert.ifError(generated.error);assert.equal(generated.status,0,generated.stderr);
  const bytes=await fs.readFile(source);
  const fragmented=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-c','copy','-f','hls','-hls_segment_type','fmp4','-hls_list_size','0',path.join(root,'fmp4.m3u8')],{encoding:'utf8',timeout:10000});
  assert.ifError(fragmented.error);assert.equal(fragmented.status,0,fragmented.stderr);
  const files=Object.fromEntries(await Promise.all((await fs.readdir(root)).filter(n=>/\.(mp4|m4s|m3u8)$/.test(n)).map(async n=>['/'+n,await fs.readFile(path.join(root,n))])));
  const hits=[];
  let stalledClosed=false;
  const origin=http.createServer((req,res)=>{
    hits.push(req.url);
    if(req.url==='/stall') {req.on('close',()=>{stalledClosed=true});return;}
    assert.equal(req.headers['user-agent'],'Capture-UA');
    assert.equal(req.headers.referer,'http://fixture.invalid/');
    if(files[req.url]) {res.end(files[req.url]);return;}
    if(req.url==='/escape') {res.setHeader('content-type','application/dash+xml');res.end('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><BaseURL>http://127.0.0.1:'+origin.address().port+'/secret</BaseURL></MPD>');return;}
    if(req.url==='/master') {res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10000\nmedia\n');}
    else if(req.url==='/media') {res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment\n#EXT-X-ENDLIST\n');}
    else if(req.url==='/bad') {res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXTINF:2,\nhttp://10.2.3.4/private.ts\n#EXT-X-ENDLIST\n');}
    else {res.setHeader('content-type','video/mp2t');res.end(bytes);}
  });
  await new Promise(r=>origin.listen(0,'127.0.0.1',r));
  t.after(()=>{origin.closeAllConnections();origin.close()});
  const base=`http://127.0.0.1:${origin.address().port}`;
  for(const [id,url] of [['hls','/master'],['direct','/direct'],['fmp4','/fmp4.m3u8'],['denied','/bad'],['escape','/escape'],['stalled','/stall']]) {
    let finish;
    const finished=new Promise(r=>{finish=r});
    startCapture({rec:{id,url:base+url},dataDir:root,maxMinutes:1/60,userAgent:'Capture-UA',referer:'http://fixture.invalid/',onFinish:finish});
    const result=await finished;
    if(id==='denied' || id==='escape' || id==='stalled') assert.equal(result.status,'failed');
    else {
      assert.equal(result.status,'completed',result.error);
      const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',path.join(root,'recordings',result.filename)],{encoding:'utf8',timeout:5000});
      assert.equal(probe.status,0,probe.stderr);assert.ok(Number(probe.stdout)>=0.9);
    }
  }
  assert.equal(stalledClosed,true);
  assert.deepEqual(hits.sort(),['/master','/media','/segment','/direct','/bad','/escape','/stall',...Object.keys(files)].sort());
});
