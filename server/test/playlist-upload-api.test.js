import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const text='#EXTM3U\n#EXTINF:-1,Upload fixture\nhttps://fixture.invalid/live\n';
test('real upload API acknowledges complete files/metadata, restores after restart and reports 413/disk failures', {timeout:20000},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-upload-api-'));
  const hook=path.join(root,'hook.mjs');
  await fs.writeFile(hook,`import net from 'node:net';import {promises as fs,existsSync} from 'node:fs';import path from 'node:path';
const rename=fs.rename;fs.rename=async(from,to)=>{if(to===path.join(process.env.DATA_DIR,'playlists.json')&&existsSync(path.join(process.env.DATA_DIR,'fail-metadata')))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});return rename(from,to)};
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`);
  let child,logs='';
  async function stop(){if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}}
  t.after(async()=>{await stop();await fs.rm(root,{recursive:true,force:true})});
  async function start(){
    logs='';child=spawn(process.execPath,['--import',pathToFileURL(hook).href,process.env.AUD012_SERVER_ENTRY||process.env.AUD011_SERVER_ENTRY||new URL('../index.js',import.meta.url).pathname],{env:{...process.env,DATA_DIR:root,PORT:'0',AUTH_PASSWORD:'',AUTH_SESSION_SECRET:'',REFRESH_INTERVAL_MINUTES:'0',M3U_URL:'http://127.0.0.1:1/configured.m3u',EPG_URL:'',EPG_SIDECAR_URL:'',RATE_LIMIT_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>{logs+=d});child.stderr.on('data',d=>{logs+=d});
    for(let i=0;i<400&&!logs.includes('TEST_PORT=');i++)await new Promise(r=>setTimeout(r,10));
    const port=logs.match(/TEST_PORT=(\d+)/)?.[1];assert.ok(port,'API did not listen');return 'http://127.0.0.1:'+port;
  }
  let base=await start();
  const initialConfig=await (await fetch(base+'/api/config')).json();
  const upload=async(id,body=text)=>fetch(base+'/api/playlists/'+id+'/file?name='+encodeURIComponent('Original file'),{method:'PUT',headers:{'content-type':'text/plain'},body});
  const response=await upload('original');assert.equal(response.status,200);
  const ack=await response.json();assert.equal(ack.playlist?.hasFile,true);assert.equal(ack.playlist.name,'Original file');
  assert.equal(await fs.readFile(path.join(root,'playlists/original.m3u'),'utf8'),text);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'playlists.json'),'utf8')).find(p=>p.id==='original').hasFile,true);
  // A later metadata response must never clear the file's authoritative flag.
  const edited=await fetch(base+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'original',revision:ack.playlist.revision,name:'Later metadata',type:'file',hasFile:false})});assert.equal((await edited.json()).hasFile,true);
  await stop();base=await start();
  const list=await (await fetch(base+'/api/playlists')).json();assert.equal(list.find(p=>p.id==='original').hasFile,true);
  assert.equal(await (await fetch(base+'/api/playlists/original/file?dl=1')).text(),text);
  await fs.writeFile(path.join(root,'fail-metadata'),'1');
  const failed=await upload('disk-failure');assert.equal(failed.status,500);assert.match(await failed.text(),/Failed to store file/);
  await assert.rejects(fs.stat(path.join(root,'playlists/disk-failure.m3u')),{code:'ENOENT'});
  assert.equal((await (await fetch(base+'/api/playlists')).json()).some(p=>p.id==='disk-failure'),false);
  await fs.unlink(path.join(root,'fail-metadata'));assert.equal((await upload('disk-failure')).status,200);
  const oversized=await upload('too-large','#EXTM3U\n'+'x'.repeat(25*1024*1024));assert.equal(oversized.status,413);assert.match(await oversized.text(),/too large/i);
  await assert.rejects(fs.stat(path.join(root,'playlists/too-large.m3u')),{code:'ENOENT'});
  const current=(await (await fetch(base+'/api/playlists')).json()).find(record=>record.id==='original');
  const stale=await fetch(base+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...ack.playlist,name:'Stale edit'})});assert.equal(stale.status,409);
  const removed=await fetch(base+'/api/playlists/original?revision='+current.revision,{method:'DELETE'});assert.equal(removed.status,200);
  await stop();base=await start();
  assert.equal((await upload('original')).status,410,'a lost original upload acknowledgement cannot recreate a deleted id after restart');
  assert.equal((await fetch(base+'/api/playlists/original/file')).status,404);
  const resurrect=await fetch(base+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(current)});assert.equal(resurrect.status,410);
  assert.equal((await (await fetch(base+'/api/playlists')).json()).some(record=>record.id==='original'),false);
  assert.equal(initialConfig.m3uSeedAllowed,true);assert.match(initialConfig.m3uPlaylistId,/^configured-[a-f0-9]{32}$/);
  assert.equal((await (await fetch(base+'/api/config')).json()).m3uSeedAllowed,false);
  const seed=await fetch(base+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:initialConfig.m3uPlaylistId,revision:0,name:'Configured placeholder',url:''})});
  const seeded=await seed.json();assert.equal(seed.status,200);
  assert.equal((await fetch(base+'/api/playlists/'+seeded.id+'?revision='+seeded.revision,{method:'DELETE'})).status,200);
  const seedReplay=await fetch(base+'/api/playlists',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:initialConfig.m3uPlaylistId,revision:0,name:'Stale bootstrap'})});assert.equal(seedReplay.status,410);
  const files=[...await fs.readdir(root),...await fs.readdir(path.join(root,'playlists'))];assert.equal(files.some(name=>name.endsWith('.tmp')),false);
});
