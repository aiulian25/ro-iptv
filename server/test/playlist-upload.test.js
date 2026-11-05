import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-upload-'));
process.env.DATA_DIR = root;
const { listPlaylists, savePlaylist, commitPlaylistFile, deletePlaylist } = await import('../lib/playlists.js');
const { playlistFilePath, writeCollection, readCollection } = await import('../lib/store.js');
const text = '#EXTM3U\n#EXTINF:-1,Upload fixture\nhttps://fixture.invalid/live\n';
test.after(() => fs.rm(root, { recursive:true, force:true }));
async function noTemps() {
  for (const dir of [root,path.join(root,'playlists')]) {
    assert.equal((await fs.readdir(dir)).some(name=>name.endsWith('.tmp')),false);
  }
}
test('file-first legacy upload creates complete metadata; late metadata edits cannot clear or forge hasFile',async()=>{
  const result=await commitPlaylistFile('first',text,{name:'Original upload',contentKind:'radio'});
  assert.equal(result.hasFile,true);assert.equal(result.channelCount,1);assert.equal(result.type,'file');
  assert.equal(await fs.readFile(playlistFilePath('first'),'utf8'),text);
  const edited=await savePlaylist({id:'first',revision:result.revision,name:'Renamed',type:'file',hasFile:false});
  assert.equal(edited.hasFile,true);
  assert.equal((await savePlaylist({id:'forged',revision:0,hasFile:true})).hasFile,false);
  const list=await listPlaylists();assert.equal(list.find(p=>p.id==='first').hasFile,true);
  await noTemps();
});
test('legacy records with missing or stale file flags are repaired from safe filesystem paths',async()=>{
  await writeCollection('playlists',[{id:'first',name:'Legacy',hasFile:false},{id:'missing',hasFile:true},{id:'../escape',hasFile:true}]);
  const list=await listPlaylists();assert.equal(list[0].hasFile,true);assert.equal(list[1].hasFile,false);assert.equal(list[2].hasFile,false);
});
test('slow file commit, metadata update and repeated upload serialize without duplicate metadata or lost flags',async(t)=>{
  const rename=fs.rename;let entered,release;
  const waiting=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
  fs.rename=async(from,to)=>{if(to===playlistFilePath('slow')){entered();await gate}return rename(from,to)};
  t.after(()=>{fs.rename=rename;release()});
  const upload=commitPlaylistFile('slow',text,{name:'Slow upload'});await waiting;
  let finished=false;const edit=savePlaylist({id:'slow',revision:1,name:'Later edit',hasFile:false}).then(r=>{finished=true;return r});
  await new Promise(r=>setTimeout(r,10));assert.equal(finished,false);release();
  await upload;assert.equal((await edit).hasFile,true);
  await commitPlaylistFile('slow',text,{name:'Retried same id'});
  const records=await readCollection('playlists');assert.equal(records.filter(p=>p.id==='slow').length,1);
  await noTemps();
});
test('raw write/rename failures keep the old complete file and clean temporary files',async(t)=>{
  await commitPlaylistFile('failure',text,{name:'Before'});
  const write=fs.writeFile,rename=fs.rename;t.after(()=>{fs.writeFile=write;fs.rename=rename});
  fs.writeFile=async(file,data,...args)=>{
    if(String(file).startsWith(playlistFilePath('failure')+'.')){await write(file,'partial');throw Object.assign(new Error('disk full'),{code:'ENOSPC'})}
    return write(file,data,...args);
  };
  await assert.rejects(commitPlaylistFile('failure',text+'#new\n',{revision:1}),{code:'ENOSPC'});fs.writeFile=write;
  fs.rename=async(from,to)=>{if(to===playlistFilePath('failure'))throw Object.assign(new Error('rename refused'),{code:'EACCES'});return rename(from,to)};
  await assert.rejects(commitPlaylistFile('failure',text+'#new\n',{revision:1}),{code:'EACCES'});fs.rename=rename;
  assert.equal(await fs.readFile(playlistFilePath('failure'),'utf8'),text);await noTemps();
});
test('failed metadata commit rolls back a new file or restores an existing file; retry commits both',async(t)=>{
  await commitPlaylistFile('rollback-old',text,{name:'Old'});
  const rename=fs.rename;t.after(()=>{fs.rename=rename});
  fs.rename=async(from,to)=>{if(to===path.join(root,'playlists.json'))throw Object.assign(new Error('metadata full'),{code:'ENOSPC'});return rename(from,to)};
  await assert.rejects(commitPlaylistFile('rollback-new',text),{code:'ENOSPC'});
  await assert.rejects(fs.stat(playlistFilePath('rollback-new')),{code:'ENOENT'});
  await assert.rejects(commitPlaylistFile('rollback-old',text+'#changed\n',{name:'Changed',revision:1}),{code:'ENOSPC'});
  assert.equal(await fs.readFile(playlistFilePath('rollback-old'),'utf8'),text);
  assert.equal((await readCollection('playlists')).find(p=>p.id==='rollback-old').name,'Old');
  fs.rename=rename;assert.equal((await commitPlaylistFile('rollback-new',text)).hasFile,true);await noTemps();
});
test('invalid/oversized uploads never create a record and deletion shares the mutation boundary',async()=>{
  for(const id of ['../escape','bad/id',''])await assert.rejects(commitPlaylistFile(id,text),{status:400});
  await assert.rejects(commitPlaylistFile('binary','#EXTM3U\0'),{status:400});
  await assert.rejects(commitPlaylistFile('oversized','#EXTM3U\n'+'x'.repeat(25*1024*1024)),{status:413});
  await assert.rejects(commitPlaylistFile('invalid',''),{status:400});
  assert.equal((await commitPlaylistFile('basic','https://fixture.invalid/basic\n')).channelCount,1);
  await commitPlaylistFile('deleted',text);await deletePlaylist('deleted',1);
  assert.equal((await listPlaylists()).some(p=>p.id==='deleted'),false);
  await assert.rejects(fs.stat(playlistFilePath('deleted')),{code:'ENOENT'});await noTemps();
});
test('metadata and content revisions advance independently and reject stale overwrites',async()=>{
  await assert.rejects(savePlaylist({id:'unversioned-create',name:'Old automatic create'}),{status:409});
  const a=await savePlaylist({id:'versions',url:'https://fixture.invalid/list',name:'Versioned',revision:0});
  assert.equal(a.revision,1);assert.equal(a.contentRevision,1);
  const b=await savePlaylist({...a,enabled:false,operationId:'disable'});
  assert.equal(b.revision,2);assert.equal(b.contentRevision,1);
  await assert.rejects(savePlaylist({...a,enabled:true}),{status:409});
  const retry=await savePlaylist({...a,enabled:false,operationId:'disable'});assert.equal(retry.revision,2);
  const c=await savePlaylist({...b,refreshContent:true});assert.equal(c.revision,3);assert.equal(c.contentRevision,2);
  const d=await savePlaylist({...c,url:'https://fixture.invalid/new'});assert.equal(d.contentRevision,3);
});
test('tombstones prevent stale metadata and upload retries from recreating a deleted playlist',async()=>{
  const uploaded=await commitPlaylistFile('gone',text,{revision:0,operationId:'first-op'});
  await assert.rejects(deletePlaylist('gone',99),{status:409});
  await deletePlaylist('gone',uploaded.revision);await deletePlaylist('gone',uploaded.revision);
  assert.equal((await listPlaylists()).some(record=>record.id==='gone'),false);
  await assert.rejects(savePlaylist({...uploaded,enabled:true}),{status:410});
  await assert.rejects(savePlaylist({id:'gone',revision:0}),{status:410});
  await assert.rejects(commitPlaylistFile('gone',text,{revision:0,operationId:'first-op'}),{status:410});
  const marker=(await readCollection('playlists')).find(record=>record.id==='gone');
  assert.equal(marker.deleted,true);assert.equal(marker.url,undefined);assert.equal(marker.enabled,false);
});
test('uploaded content versions change only for new bytes and lost acknowledgements are idempotent',async()=>{
  const a=await commitPlaylistFile('content',text,{revision:0,operationId:'upload-a'});
  const b=await savePlaylist({...a,name:'Renamed',operationId:'rename'});
  const again=await commitPlaylistFile('content',text,{revision:0,operationId:'upload-a'});
  assert.equal(again.revision,b.revision);assert.equal(again.name,'Renamed');
  await assert.rejects(commitPlaylistFile('content',text+'#changed\n',{revision:a.revision,operationId:'stale'}),{status:409});
  const c=await commitPlaylistFile('content',text+'#changed\n',{revision:b.revision,operationId:'upload-c'});
  assert.equal(c.contentRevision,a.contentRevision+1);assert.equal(c.revision,b.revision+1);
});
test('a damaged authoritative collection fails closed instead of reporting an empty deletion snapshot',async()=>{
  const file=path.join(root,'playlists.json'),before=await fs.readFile(file);
  try {
    await fs.writeFile(file,'{invalid');await assert.rejects(listPlaylists());
    assert.equal(await fs.readFile(file,'utf8'),'{invalid');
  } finally {await fs.writeFile(file,before)}
});
