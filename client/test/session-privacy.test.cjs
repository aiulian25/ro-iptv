const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
const source = process.env.AUD013_STORE_SOURCE || process.env.AUD012_STORE_SOURCE || process.env.AUD011_STORE_SOURCE || process.env.AUD010_STORE_SOURCE || path.join(client, 'src/store/useStore.js');
const bundle = buildSync({ stdin: { contents: fs.readFileSync(source, 'utf8'), resolveDir: path.join(client,'src/store'), sourcefile: 'useStore.js' }, bundle:true, write:false, format:'cjs', platform:'node', alias:{'@shared':path.resolve(client,'../shared')} }).outputFiles[0].text;
const sharedContext={module:{exports:{}},exports:{},URL};
vm.runInNewContext(buildSync({entryPoints:[path.resolve(client,'../shared/m3u.js')],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,sharedContext);
const sharedParser=sharedContext.module.exports;
function storage(seed={}) {
  const data = {...seed};
  return new Proxy({getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=String(v)},removeItem:k=>{delete data[k]}}, {
    ownKeys:()=>Object.keys(data),getOwnPropertyDescriptor:(_t,k)=>k in data?{enumerable:true,configurable:true}:undefined,
  });
}
function fixture(seed={}) {
  const localStorage=storage(seed),sessionStorage=storage({'ro-iptv:directok':'{"secret-url":true}'});
  const cached=new Set(['epg-cache','logo-cache','workbox-precache-static','unrelated-cache']);
  const calls=[], timers=new Map(), events={};let serial=0;
  let reply=()=>({});
  const context={process:{env:{NODE_ENV:'production'}},module:{exports:{}},exports:{},require,console,AbortController,Response,URL,URLSearchParams,crypto:globalThis.crypto,
    localStorage,sessionStorage,caches:{keys:async()=>[...cached],delete:async(name)=>cached.delete(name)},
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
    window:{addEventListener:(name,fn)=>{events[name]=fn}},
    fetch:async(url,options)=>{calls.push({url,options});const value=await reply(url,options);return value instanceof Response?value:new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})},
  };
  vm.runInNewContext(bundle,context);
  const store=context.module.exports.useStore;
  return {store,localStorage,sessionStorage,cached,calls,timers,events,reply:fn=>{reply=fn}};
}
const secret='synthetic-session-private-marker';
const seed={
  'ro-iptv:authMode':'required','ro-iptv:playlists':JSON.stringify([{id:'p',url:secret}]),
  'ro-iptv:channels:p':JSON.stringify([{id:'c',name:'Fixture',url:secret}]),
  'ro-iptv:history':JSON.stringify([{id:'c',url:secret}]),'ro-iptv:lastChannel':JSON.stringify({url:secret}),
  'ro-iptv:identityPending:p':JSON.stringify([{id:'old',name:secret,identityRouteKey:'fingerprint'}]),
  'ro-iptv:pendingUploads':JSON.stringify([{id:'retry',owner:'first',text:secret}]),
  'ro-iptv:settings':JSON.stringify({epgUrls:[secret]}),'ro-iptv:install-dismissed':'1',
};
function authenticated(f){f.store.setState({auth:{checked:true,required:true,authed:true,mustChange:false,username:'first'}})}
function noPrivateData(f){
  const state=f.store.getState();
  assert.doesNotMatch(JSON.stringify({playlists:state.playlists,channels:state.channels,epg:state.epg,history:state.history,settings:state.settings,pendingUploads:state.pendingUploads,playlistChanges:state.playlistChanges,identityPending:state.identityPending,identityConflicts:state.identityConflicts,recordings:state.recordings,currentChannel:state.currentChannel}),new RegExp(secret));
  for(const k of Object.keys(f.localStorage))assert.doesNotMatch(f.localStorage.getItem(k),new RegExp(secret));
  assert.equal(f.sessionStorage.getItem('ro-iptv:directok'),null);
  assert.equal(f.cached.has('epg-cache'),false);assert.equal(f.cached.has('logo-cache'),false);
  assert.equal(f.cached.has('workbox-precache-static'),true);assert.equal(f.cached.has('unrelated-cache'),true);
}
test('logout clears private state, pending pushes, playback memo and legacy caches before offline reload',async()=>{
  const f=fixture(seed);authenticated(f);f.reply(url=>url==='/api/auth/logout'?{ok:true}:{});
  f.store.getState().playChannel({id:'c',url:secret});f.store.getState().toggleFavourite('c');
  assert.ok(f.timers.size);
  await f.store.getState().logout();noPrivateData(f);assert.equal(f.store.getState().auth.authed,false);
  assert.equal(f.timers.size,0);
  for(const {fn} of f.timers.values())fn();
  assert.equal(f.calls.filter(c=>c.url.startsWith('/api/state/')).length,0);
  const reload=fixture(Object.fromEntries(Object.keys(f.localStorage).map(k=>[k,f.localStorage.getItem(k)])));
  reload.reply(()=>{throw new Error('offline')});const auth=await reload.store.getState().checkAuth();
  assert.equal(auth.required,true);assert.equal(auth.authed,false);reload.store.getState().restoreLastChannel();assert.equal(reload.store.getState().currentChannel,null);
});
test('failed server logout stays locally locked, visible and cannot be undone by a valid cookie',async()=>{
  const f=fixture(seed);authenticated(f);f.reply(()=>new Response('{}',{status:503}));
  assert.equal(await f.store.getState().logout(),false);noPrivateData(f);
  assert.match(f.store.getState().auth.notice,/Server sign-out failed/);
  f.reply(()=>({authRequired:true,authed:true,username:'first'}));
  const auth=await f.store.getState().checkAuth();assert.equal(auth.authed,false);
});
test('offline protected and unknown origins lock; confirmed auth-off keeps allowed offline data',async()=>{
  for(const mode of ['required',null,'open']){
    const f=fixture({...seed,'ro-iptv:authMode':mode});f.reply(()=>{throw new Error('offline')});
    const auth=await f.store.getState().checkAuth();assert.equal(auth.required,mode!=='open');assert.equal(auth.authed,mode==='open');
    if(mode==='open'){f.store.getState().restoreLastChannel();assert.equal(f.store.getState().currentChannel.url,secret)}else noPrivateData(f);
  }
});
test('late playlist, recording and init responses cannot restore private data after logout',async()=>{
  for(const action of ['addPlaylistFromUrl','loadRecordings','init','_hydratePlaylists','_syncState','loadEpg']){
    const f=fixture(seed);authenticated(f);let release;
    f.reply(url=>url==='/api/auth/logout'?{ok:true}:new Promise(r=>{release=r}));
    const pending=f.store.getState()[action](secret,'Fixture');
    for (let i=0; i<40 && typeof release!=='function'; i++) await Promise.resolve();
    assert.equal(typeof release,'function','Request must be in flight before logout');
    await f.store.getState().logout();
    release(action==='loadRecordings'?[{url:secret}]:action==='_hydratePlaylists'?[{id:'old',url:secret}]:action==='_syncState'?[{key:'history',value:[{url:secret}]}]:{m3uUrl:secret,channels:[{url:secret}],sourceCount:1});
    await pending;noPrivateData(f);assert.equal(f.store.getState().auth.authed,false);
    assert.ok(f.calls[0].options.signal.aborted);
  }
});
test('a completed old response body cannot contaminate a newly signed-in account',async()=>{
  const f=fixture(seed);authenticated(f);let releaseBody;
  const response=new Response();response.json=()=>new Promise(r=>{releaseBody=r});
  f.reply(url=>url==='/api/recordings'?response:{ok:true});
  const pending=f.store.getState().loadRecordings();
  for(let i=0;i<10&&!releaseBody;i++)await Promise.resolve();
  assert.ok(releaseBody);await f.store.getState().logout();
  authenticated(f);releaseBody([{url:secret}]);await pending;noPrivateData(f);
});
test('new login and password rotation drop the previous account state and never persist passwords',async()=>{
  for(const action of ['login','updatePassword','changePassword']){
    const f=fixture(seed);authenticated(f);
    f.reply(url=>url==='/api/auth/login'||url==='/api/auth/password'?{username:'second',mustChange:false}:url==='/api/playlists'||url==='/api/state'||url==='/api/recordings'?[]:{});
    await f.store.getState()[action]('synthetic-old-password','synthetic-new-password',true);
    noPrivateData(f);assert.equal(f.store.getState().auth.authed,true);
    for(const k of Object.keys(f.localStorage))assert.doesNotMatch(f.localStorage.getItem(k),/synthetic-(?:old|new)-password/);
  }
});
test('401 clears private state and a storage event locks other tabs',async()=>{
  const f=fixture(seed);authenticated(f);
  f.reply(()=>({authRequired:true,authed:true}));await f.store.getState().checkAuth();
  f.store.getState().playChannel({id:'c',url:secret});f.reply(()=>new Response('{}',{status:401}));
  await f.store.getState().loadRecordings();await Promise.resolve();noPrivateData(f);assert.equal(f.store.getState().auth.authed,false);
  authenticated(f);f.events.storage({key:'ro-iptv:localLock',newValue:'1'});await Promise.resolve();assert.equal(f.store.getState().auth.authed,false);
});
test('concurrent auth checks share a request and bootstrap sessions cannot load private data',async()=>{
  const f=fixture(seed);let release;
  f.reply(()=>new Promise(r=>{release=r}));
  const first=f.store.getState().checkAuth(),second=f.store.getState().checkAuth();
  assert.equal(first,second);release({authRequired:true,authed:true,mustChange:true});
  await first;await f.store.getState().init();f.store.getState().restoreLastChannel();
  assert.equal(f.calls.length,1);assert.equal(f.store.getState().currentChannel,null);noPrivateData(f);
});
test('cleanup failure is visible and prevents a new login from unlocking private leftovers',async()=>{
  const f=fixture(seed);authenticated(f);f.localStorage.removeItem=()=>{throw new Error('storage unavailable')};
  f.reply(()=>({ok:true}));await f.store.getState().logout();
  assert.equal(f.store.getState().auth.authed,false);assert.match(f.store.getState().auth.notice,/could not be cleared/);
  await assert.rejects(()=>f.store.getState().login('next','password',false),/could not be cleared/);
  assert.equal(f.calls.filter(c=>c.url==='/api/auth/login').length,0);
});
test('a marker write failure cannot revive a previously open origin after protected status',async()=>{
  const f=fixture({...seed,'ro-iptv:authMode':'open'});
  f.localStorage.setItem=()=>{throw new Error('quota exceeded')};
  f.reply(()=>({authRequired:true,authed:true}));
  const auth=await f.store.getState().checkAuth();
  assert.equal(auth.required,true);assert.equal(auth.authed,false);
  assert.notEqual(f.localStorage.getItem('ro-iptv:authMode'),'open');noPrivateData(f);
});
const uploadText='#EXTM3U\n#EXTINF:-1,Upload fixture\nhttps://fixture.invalid/live\n';
function acknowledgement(f) {
  const id=f.store.getState().pendingUploads[0].id;
  return {version:3,channels:[{id:'c3-upload',name:'Upload fixture',url:'https://fixture.invalid/live',group:''}],aliases:{},conflicts:[],ok:true,playlist:{id,name:'Upload fixture',type:'file',url:'',hasFile:true,channelCount:1,revision:1,contentRevision:1}};
}
test('uploaded playlist waits for complete server acknowledgement before exposing channels or success',async()=>{
  const f=fixture();authenticated(f);let release,finished=false;
  f.reply(url=>url.includes('/file?')?new Promise(r=>{release=r}):acknowledgement(f));
  const pending=f.store.getState().addPlaylistFromText(uploadText,'Upload fixture').then(r=>{finished=true;return r});
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(finished,false);assert.equal(f.store.getState().playlists.length,0);assert.equal(f.store.getState().channels.length,0);
  assert.equal(f.store.getState().pendingUploads[0].status,'saving');assert.equal(f.store.getState().toast,null);
  release(acknowledgement(f));const record=await pending;
  assert.equal(record.hasFile,true);assert.equal(f.store.getState().pendingUploads.length,0);
  assert.equal(f.store.getState().channels.length,1);assert.match(f.store.getState().toast,/Saved 1 channels on server/);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].options.method,'PUT');assert.ok(f.calls[1].url.endsWith('/channels'));
});
test('413, disk/server and network errors retain the original payload and id for a successful retry',async()=>{
  for(const status of [413,500,null]){
    const f=fixture();authenticated(f);
    f.reply(()=>{if(status===null)throw new Error('offline');return new Response('{"error":"Upload failed"}',{status})});
    await assert.rejects(()=>f.store.getState().addPlaylistFromText(uploadText,'Retry fixture'));
    const failed=f.store.getState().pendingUploads[0];assert.equal(failed.status,'failed');assert.equal(failed.text,uploadText);
    assert.match(failed.error,/Upload not saved/);assert.equal(f.store.getState().playlists.length,0);
    const saved=acknowledgement(f);f.reply(()=>saved);await f.store.getState().retryPlaylistUpload(failed.id);
    assert.equal(f.store.getState().pendingUploads.length,0);assert.equal(f.store.getState().playlists[0].id,failed.id);
    assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  }
});
test('unconfirmed acknowledgement stays retryable; browser quota failure after commit reports server success honestly',async()=>{
  const f=fixture();authenticated(f);f.reply(()=>({ok:true}));
  await assert.rejects(()=>f.store.getState().addPlaylistFromText(uploadText,'Fixture'),/did not confirm/);
  assert.equal(f.store.getState().pendingUploads[0].status,'failed');
  const ack=acknowledgement(f);f.reply(()=>ack);
  const setItem=f.localStorage.setItem;f.localStorage.setItem=(key,value)=>{if(key.startsWith('ro-iptv:channels:'))throw new Error('quota');return setItem(key,value)};
  await f.store.getState().retryPlaylistUpload(ack.playlist.id);
  assert.match(f.store.getState().toast,/Saved on server; browser cache is unavailable/);
  assert.equal(f.store.getState().pendingUploads.length,0);assert.equal(f.store.getState().playlists[0].hasFile,true);
});
test('pending raw upload survives verified same-account reload and is erased on account switch or logout',async()=>{
  const f=fixture({'ro-iptv:authMode':'required','ro-iptv:pendingUploads':JSON.stringify([{id:'retry',owner:'first',text:uploadText,name:'Retry'}])});
  f.reply(url=>url==='/api/auth/status'?{authRequired:true,authed:true,username:'first'}:url==='/api/auth/login'?{username:'second'}:url==='/api/playlists'||url==='/api/state'||url==='/api/recordings'?[]:{});
  await f.store.getState().checkAuth();assert.equal(f.store.getState().pendingUploads[0].text,uploadText);
  assert.equal(f.store.getState().pendingUploads[0].status,'failed');
  await f.store.getState().login('second','password',false);assert.equal(f.store.getState().pendingUploads.length,0);
  assert.equal(f.localStorage.getItem('ro-iptv:pendingUploads'),null);
});
test('a late upload acknowledgement cannot restore raw data or channels after logout',async()=>{
  const f=fixture();authenticated(f);let release;
  f.reply(url=>url==='/api/auth/logout'?{ok:true}:new Promise(r=>{release=r}));
  const pending=f.store.getState().addPlaylistFromText(uploadText,'Fixture');const ack=acknowledgement(f);
  await f.store.getState().logout();release(ack);await pending;
  assert.equal(f.store.getState().pendingUploads.length,0);assert.equal(f.store.getState().channels.length,0);
  assert.equal(f.store.getState().playlists.length,0);assert.equal(f.localStorage.getItem('ro-iptv:pendingUploads'),null);
});
function playlistSeed(record,channels=[{id:'old',name:'Old',url:'https://fixture.invalid/old',group:''}]) {
  return {'ro-iptv:authMode':'open','ro-iptv:playlists':JSON.stringify([record]),['ro-iptv:channels:'+record.id]:JSON.stringify(channels),['ro-iptv:channelIdentityVersion:'+record.id]:'3',['ro-iptv:channelRevision:'+record.id]:JSON.stringify(record.contentRevision)};
}
const versioned={id:'p',name:'Fixture',url:'https://fixture.invalid/list',type:'url',enabled:true,revision:1,contentRevision:1};
test('authoritative empty server list evicts local playlists, channels and playing/history snapshots',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);f.store.getState()._rebuildChannels();
  f.store.getState().playChannel(f.store.getState().channels[0]);f.reply(()=>[]);
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().playlists.length,0);assert.equal(f.store.getState().channels.length,0);
  assert.equal(f.localStorage.getItem('ro-iptv:channels:p'),null);assert.equal(f.store.getState().currentChannel,null);assert.equal(f.store.getState().history.length,0);
  f.store.getState().setPlaylistEnabled('p',true);assert.equal(f.calls.length,1,'no save of an absent playlist');
});
test('new content revision replaces nonempty caches; empty replacements and failed replacement reads never resurrect old streams',async()=>{
  for(const outcome of ['new','empty','failed']){
    const f=fixture(playlistSeed(versioned));authenticated(f);
    f.reply(url=>{if(url==='/api/playlists')return [{...versioned,revision:2,contentRevision:2}];if(outcome==='failed')throw new Error('offline source');return {version:3,aliases:{},conflicts:[],channels:outcome==='empty'?[]:[{id:'new',name:'New',url:'https://fixture.invalid/new',group:''}]}});
    await f.store.getState()._hydratePlaylists();
    assert.equal(f.store.getState().channels.length,outcome==='new'?1:0);
    assert.equal(f.store.getState().channels.some(c=>c.url.endsWith('/old')),false);
    if(outcome==='failed')assert.match(f.store.getState().playlists[0].syncError,/unavailable/);
    else assert.equal(f.localStorage.getItem('ro-iptv:channelRevision:p'),'2');
  }
});
test('metadata-only revision disables the playlist without refetching unchanged content',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);f.reply(()=>[{...versioned,revision:2,enabled:false}]);
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().channels.length,0);assert.equal(f.calls.length,1);
  assert.ok(f.localStorage.getItem('ro-iptv:channels:p'));
});
test('offline edits stay explicitly pending, reconnect replays against the base revision',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);f.reply(()=>{throw new Error('offline')});
  await f.store.getState().setPlaylistEnabled('p',false);
  assert.equal(f.store.getState().playlistChanges[0].status,'failed');assert.equal(f.store.getState().playlists[0].pending,true);
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().playlists.length,1);
  let server={...versioned};f.reply((url,options)=>{
    if(options?.method==='POST'){const body=JSON.parse(options.body);assert.equal(body.revision,1);server={...server,enabled:body.enabled,revision:2,lastMutationId:body.operationId};return server}
    return [server];
  });
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().playlistChanges.length,0);assert.equal(f.store.getState().playlists[0].revision,2);assert.equal(f.store.getState().playlists[0].enabled,false);
});
test('remote delete or edit conflicts with offline work, never recreating or overwriting the server record',async()=>{
  for(const deleted of [true,false]){
    const f=fixture(playlistSeed(versioned));authenticated(f);f.reply(()=>{throw new Error('offline')});await f.store.getState().setPlaylistEnabled('p',false);
    const writes=f.calls.length;f.reply(()=>deleted?[]:[{...versioned,revision:2,name:'Remote edit'}]);
    await f.store.getState()._hydratePlaylists();assert.equal(f.calls.length,writes+1);
    assert.equal(f.store.getState().playlistChanges[0].status,'conflict');
    assert.equal(f.store.getState().playlists.length,deleted?0:1);
    if(!deleted)assert.equal(f.store.getState().playlists[0].name,'Remote edit');
  }
});
test('authoritative deletions preserve an explicitly pending raw upload and an explicit unsynced new URL playlist',async()=>{
  const f=fixture();authenticated(f);f.reply(url=>url.startsWith('/api/playlist?')?{count:1,channels:[{id:'c',name:'New',url:'https://fixture.invalid/new',group:''}]}:Promise.reject(new Error('offline')));
  await f.store.getState().addPlaylistFromUrl('https://fixture.invalid/newlist','Pending new');
  assert.equal(f.store.getState().playlistChanges[0].create,true);
  await assert.rejects(()=>f.store.getState().addPlaylistFromText(uploadText,'Pending file'));
  f.reply(url=>url==='/api/playlists'?[]:Promise.reject(new Error('write unavailable')));
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().pendingUploads[0].text,uploadText);
  assert.equal(f.store.getState().playlists[0].pending,true);assert.equal(f.store.getState().playlistChanges[0].status,'failed');
});
test('a delayed old list cannot overwrite a local mutation acknowledged while it was loading',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);let release;
  f.reply((url,options)=>options?.method==='POST'?{...versioned,revision:2,enabled:false}:new Promise(r=>{release=r}));
  const sync=f.store.getState()._hydratePlaylists();await f.store.getState().setPlaylistEnabled('p',false);
  release([{...versioned}]);await sync;assert.equal(f.store.getState().playlists[0].revision,2);assert.equal(f.store.getState().playlists[0].enabled,false);
});
test('unversioned legacy local-only content is retained for export, without recreating a server playlist',async()=>{
  const f=fixture(playlistSeed({...versioned,revision:undefined,contentRevision:undefined}));authenticated(f);f.reply(()=>[]);
  await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().playlists.length,0);
  const recovery=f.store.getState().playlistChanges[0];assert.equal(recovery.status,'conflict');assert.equal(recovery.create,false);assert.equal(recovery.record.channels.length,1);
  await f.store.getState()._hydratePlaylists();assert.equal(f.calls.length,2);
});
test('a deleted upload id remains a recoverable conflict and cannot automatically recreate server data',async()=>{
  const f=fixture();authenticated(f);f.reply(()=>new Response('{"error":"Deleted"}',{status:410}));
  await assert.rejects(()=>f.store.getState().addPlaylistFromText(uploadText,'Deleted upload'));
  const pending=f.store.getState().pendingUploads[0];assert.equal(pending.status,'conflict');assert.equal(pending.text,uploadText);assert.match(pending.error,/will not overwrite/);
});
test('verified same-account pending metadata keeps its channel payload after protected reload',async()=>{
  const change={id:'pending',owner:'first',type:'save',create:true,baseRevision:0,operationId:'op',cacheValid:true,status:'failed',record:{id:'pending',name:'Pending URL',url:'https://fixture.invalid/list'},channels:[{id:'c',name:'Pending channel',url:'https://fixture.invalid/live',group:''}]};
  const f=fixture({'ro-iptv:authMode':'required','ro-iptv:playlistChanges':JSON.stringify([change])});
  f.reply(()=>({authRequired:true,authed:true,username:'first'}));await f.store.getState().checkAuth();
  assert.equal(JSON.parse(f.localStorage.getItem('ro-iptv:channels:pending'))[0].name,'Pending channel');
  await f.store.getState().logout();assert.equal(f.store.getState().playlistChanges.length,0);assert.equal(f.localStorage.getItem('ro-iptv:channels:pending'),null);
});
test('a metadata edit after failed content loading cannot mark an empty fallback as a valid content cache',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);let server={...versioned,revision:2,contentRevision:2},available=false;
  f.reply((url,options)=>{if(options?.method==='POST'){const body=JSON.parse(options.body);server={...server,enabled:body.enabled,revision:server.revision+1};return server}if(url==='/api/playlists')return [server];if(!available)throw new Error('source unavailable');return {version:3,aliases:{},conflicts:[],channels:[{id:'new',name:'New',url:'https://fixture.invalid/new',group:''}]}});
  await f.store.getState()._hydratePlaylists();await f.store.getState().setPlaylistEnabled('p',false);
  assert.equal(f.localStorage.getItem('ro-iptv:channelRevision:p'),null);
  available=true;await f.store.getState()._hydratePlaylists();assert.equal(f.localStorage.getItem('ro-iptv:channelRevision:p'),'2');
  assert.equal(JSON.parse(f.localStorage.getItem('ro-iptv:channels:p'))[0].id,'new');
  await f.store.getState().setPlaylistEnabled('p',true);assert.equal(f.store.getState().channels.length,1);
});
test('metadata rebuilds preserve a valid catchup session, while stale deleted history cannot restart playback',async()=>{
  const f=fixture(playlistSeed(versioned));authenticated(f);f.store.getState()._rebuildChannels();
  const channel=f.store.getState().channels[0];f.store.setState({currentChannel:{...channel,isCatchup:true,url:'https://fixture.invalid/archive'}});
  f.store.getState()._rebuildChannels();assert.equal(f.store.getState().currentChannel.isCatchup,true);
  f.reply(()=>[]);await f.store.getState()._hydratePlaylists();f.store.getState().playChannel({...channel,playlistId:undefined});assert.equal(f.store.getState().currentChannel,null);
});
test('startup does not re-add a configured default playlist after the server closes its initial seed window',async()=>{
  const f=fixture();authenticated(f);
  f.reply(url=>url==='/api/config'?{m3uUrl:'https://fixture.invalid/deleted-default',m3uSeedAllowed:false,m3uPlaylistId:'configured-fixture'}:url==='/api/playlists'||url==='/api/state'||url==='/api/recordings'?[]:{});
  await f.store.getState().init();assert.equal(f.calls.some(call=>call.options?.method==='POST'||call.url.startsWith('/api/playlist?')),false);assert.equal(f.store.getState().playlists.length,0);
});
const identityText=(name,url,id='guide')=>`#EXTM3U\n#EXTINF:-1 tvg-id="${id}",${name}\n${url}\n`;
test('canonical identity migration keeps v2 stars/manual links and refreshes history, last and current playback snapshots',async()=>{
 const old=sharedParser.parseM3U(identityText('Old','https://fixture.invalid/old?token=a'))[0];old.id=sharedParser.legacyChannelId(old,new Map());
 const fresh=sharedParser.parseM3U(identityText('Renamed','https://fixture.invalid/new?token=b'))[0];
 const before='p__'+old.id,after='p__'+fresh.id;
 const f=fixture({...playlistSeed(versioned,[old]),'ro-iptv:channelIdentityVersion:p':'2','ro-iptv:favourites':JSON.stringify([before]),'ro-iptv:history':JSON.stringify([{...old,id:before,playlistId:'p',at:77}]),'ro-iptv:lastChannel':JSON.stringify({...old,id:before,playlistId:'p'}),'ro-iptv:settings':JSON.stringify({epgOverrides:{[before]:'manual-guide'}})});authenticated(f);f.store.getState()._rebuildChannels();f.store.setState({currentChannel:{...old,id:before,playlistId:'p'}});
 let aliases={};f.reply((url,options)=>{if(url==='/api/playlists')return [{...versioned,revision:2,contentRevision:2}];if(url.endsWith('/aliases'))aliases={...aliases,...JSON.parse(options.body).aliases};return {version:3,channels:[fresh],aliases,conflicts:[]}});
 await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().favourites[0],after);assert.equal(f.store.getState().settings.epgOverrides[after],'manual-guide');assert.equal(f.store.getState().settings.epgOverrides[before],undefined);
 assert.equal(f.store.getState().history[0].url,fresh.url);assert.equal(f.store.getState().history[0].at,77);assert.equal(f.store.getState().currentChannel.url,fresh.url);assert.equal(JSON.parse(f.localStorage.getItem('ro-iptv:lastChannel')).url,fresh.url);assert.equal(f.localStorage.getItem('ro-iptv:channelIdentityVersion:p'),'3');assert.ok(f.localStorage.getItem('ro-iptv:identityBackup:p'));
});
test('ambiguous identity migration leaves old references intact and surfaces review instead of guessing',async()=>{
 const old=sharedParser.parseM3U(identityText('Same','https://fixture.invalid/old',''))[0];old.id=sharedParser.legacyChannelId(old,new Map());
 const fresh=sharedParser.parseM3U(identityText('Same','https://fixture.invalid/new',''))[0];const ref='p__'+old.id;
 const f=fixture({...playlistSeed(versioned,[old]),'ro-iptv:favourites':JSON.stringify([ref]),'ro-iptv:settings':JSON.stringify({epgOverrides:{[ref]:'manual'}})});authenticated(f);
 f.reply(url=>url==='/api/playlists'?[{...versioned,revision:2,contentRevision:2}]:{version:3,channels:[fresh],aliases:{},conflicts:[{id:fresh.id,reason:'unmatched-channel'}]});
 await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().favourites[0],ref);assert.equal(f.store.getState().settings.epgOverrides[ref],'manual');assert.equal(f.store.getState().identityConflicts.p.length,1);assert.equal(f.store.getState().currentChannel,null);
});
test('failed alias registration retains migration evidence across reload without serving old streams',async()=>{
 const old=sharedParser.parseM3U(identityText('Old','https://fixture.invalid/old?token=a'))[0];old.id=sharedParser.legacyChannelId(old,new Map());
 const fresh=sharedParser.parseM3U(identityText('New','https://fixture.invalid/moved?token=b'))[0];const before='p__'+old.id;
 const f=fixture({...playlistSeed(versioned,[old]),'ro-iptv:channelIdentityVersion:p':'2','ro-iptv:favourites':JSON.stringify([before])});authenticated(f);
 f.reply(url=>{if(url==='/api/playlists')return[{...versioned,revision:2,contentRevision:2}];if(url.endsWith('/aliases'))return new Response('{}',{status:503});return{version:3,channels:[fresh],aliases:{},conflicts:[]}});
 await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().channels.length,0);assert.equal(f.store.getState().favourites[0],before);
 const evidence=JSON.parse(f.localStorage.getItem('ro-iptv:identityPending:p'));assert.equal(evidence[0].id,old.id);assert.equal(evidence[0].url,undefined);
 const reload=fixture(Object.fromEntries(Object.keys(f.localStorage).map(key=>[key,f.localStorage.getItem(key)])));authenticated(reload);let aliases={};
 reload.reply((url,options)=>{if(url==='/api/playlists')return[{...versioned,revision:2,contentRevision:2}];if(url.endsWith('/aliases'))aliases={...aliases,...JSON.parse(options.body).aliases};return{version:3,channels:[fresh],aliases,conflicts:[]}});
 await reload.store.getState()._hydratePlaylists();assert.equal(reload.store.getState().favourites[0],'p__'+fresh.id);assert.equal(reload.localStorage.getItem('ro-iptv:identityPending:p'),null);assert.equal(reload.store.getState().channels[0].url,fresh.url);
});
test('pre-v2 index IDs migrate only after a unique canonical match',async()=>{
 const old=sharedParser.parseM3U(identityText('Old Name','https://fixture.invalid/old?token=a'))[0];old.id='0-guide';
 const fresh=sharedParser.parseM3U(identityText('New Name','https://fixture.invalid/new?token=b'))[0],ref='p__'+old.id;
 const f=fixture({...playlistSeed(versioned,[old]),'ro-iptv:channelIdentityVersion:p':'1','ro-iptv:favourites':JSON.stringify([ref]),'ro-iptv:settings':JSON.stringify({epgOverrides:{[ref]:'manual'}})});authenticated(f);let aliases={};
 f.reply((url,options)=>{if(url==='/api/playlists')return[{...versioned,revision:2,contentRevision:2}];if(url.endsWith('/aliases'))aliases={...aliases,...JSON.parse(options.body).aliases};return{version:3,channels:[fresh],aliases,conflicts:[]}});
 await f.store.getState()._hydratePlaylists();assert.equal(f.store.getState().favourites[0],'p__'+fresh.id);assert.equal(f.store.getState().settings.epgOverrides['p__'+fresh.id],'manual');assert.equal(f.store.getState().settings.epgOverrides[ref],undefined);
});
