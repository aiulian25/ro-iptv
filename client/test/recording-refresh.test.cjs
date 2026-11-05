const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
const bundle = buildSync({ entryPoints:[path.join(client,'src/store/useStore.js')],bundle:true,write:false,format:'cjs',platform:'node',alias:{'@shared':path.resolve(client,'../shared')} }).outputFiles[0].text;
const owner = fs.readFileSync(path.join(client,'src/lib/recordingRefresh.js'),'utf8').replace('export function','function');
const tick = async () => { for(let i=0;i<50;i++)await Promise.resolve(); };
const deferred = () => { let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}; };
function events(extra={}) { const handlers=new Map();return {...extra,addEventListener:(name,fn)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);},removeEventListener:(name,fn)=>handlers.get(name)?.delete(fn),emit:name=>{for(const fn of handlers.get(name)||[])fn();},count:()=>[...handlers.values()].reduce((n,s)=>n+s.size,0)}; }
function fixture(initial=[{id:'r',status:'scheduled'}]) {
  let now=0,id=0,reply=()=>initial;const timers=new Map(),calls=[];const storage={getItem:()=>null,setItem(){},removeItem(){}};
  const setTimeout=(fn,ms)=>{const n=++id;timers.set(n,{fn,at:now+ms,ms});return n;},clearTimeout=n=>timers.delete(n);
  const win=events({setTimeout,clearTimeout}),doc=events({hidden:false}),nav={onLine:true};
  const context={module:{exports:{}},exports:{},require,process:{env:{NODE_ENV:'production'}},console,Response,AbortController,AbortSignal,URL,URLSearchParams,localStorage:storage,sessionStorage:storage,window:win,document:doc,navigator:nav,setTimeout,clearTimeout,fetch:async(url,options)=>{calls.push({url,options,at:now});const value=await reply(url,options);return value instanceof Response?value:new Response(JSON.stringify(value));}};
  vm.runInNewContext(bundle,context);vm.runInNewContext(owner,context);const store=context.module.exports.useStore;
  store.setState({auth:{checked:true,required:false,authed:true},recordings:initial,view:'recordings'});
  const start=()=>context.startRecordingRefresh(store,{canAccess:context.module.exports.canAccess,document:doc,window:win,navigator:nav});
  const advance=async(ms)=>{const end=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await tick();}now=end;await tick();};
  return {store,start,calls,timers,win,doc,nav,advance,reply:fn=>reply=fn,reads:()=>calls.filter(c=>c.url==='/api/recordings'&&(!c.options.method||c.options.method==='GET'))};
}
test('scheduled to recording to completed/missed/failed updates on one four-second cadence then idles',async()=>{
  for(const status of ['completed','missed','failed']){
    const f=fixture();let rows=[{id:'r',status:'scheduled'}];f.reply(()=>rows);const stop=f.start();await tick();assert.equal(f.reads().length,1);
    await f.advance(3999);assert.equal(f.reads().length,1);rows=[{id:'r',status:'recording',size:9}];await f.advance(1);assert.equal(f.store.getState().recordings[0].status,'recording');
    rows=[{id:'r',status}];await f.advance(4000);assert.equal(f.store.getState().recordings[0].status,status);assert.deepEqual(f.reads().map(r=>r.at),[0,4000,8000]);await f.advance(20000);assert.equal(f.reads().length,3);stop();assert.equal(f.timers.size,0);
  }
});
test('navigation shares the updater and terminal reconnect/return catches up',async()=>{
  const f=fixture([]);let rows=[];f.reply(()=>rows);const stop=f.start();await tick();await f.advance(8000);assert.equal(f.reads().length,1);
  f.store.setState({view:'live'});await tick();assert.equal(f.reads().length,1);f.nav.onLine=false;f.win.emit('offline');rows=[{id:'r',status:'scheduled'}];f.nav.onLine=true;f.win.emit('online');await tick();assert.equal(f.store.getState().recordings[0].status,'scheduled');
  f.store.setState({view:'settings'});f.store.setState({view:'live'});await f.advance(4000);assert.equal(f.reads().length,3);
  f.doc.hidden=true;f.doc.emit('visibilitychange');await f.advance(20000);assert.equal(f.reads().length,3);f.doc.hidden=false;f.doc.emit('visibilitychange');await tick();assert.equal(f.reads().length,4);stop();assert.equal(f.doc.count(),0);
});
test('concurrent loads and wake events share a request; slow reads never overlap and have a deadline',async()=>{
  const f=fixture(),held=deferred();f.reply((_url,{signal})=>new Promise((resolve,reject)=>{held.promise.then(resolve);signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
  const stop=f.start();const a=f.store.getState().loadRecordings(),b=f.store.getState().loadRecordings();assert.equal(a,b);f.win.emit('focus');f.win.emit('online');await tick();assert.equal(f.reads().length,1);await f.advance(9999);assert.equal(f.reads().length,1);assert.equal(f.reads()[0].options.signal.aborted,false);await f.advance(1);assert.equal(f.reads()[0].options.signal.aborted,true);f.reply(()=>[{id:'r',status:'completed'}]);await f.advance(4000);assert.equal(f.reads().length,2);assert.equal(f.store.getState().recordings[0].status,'completed');stop();
});
test('hidden/offline/unmount cancel reads and ignore late snapshots',async()=>{
  for(const action of ['hide','offline','stop']){
    const f=fixture(),held=deferred();f.reply(()=>held.promise);const stop=f.start();await tick();if(action==='hide'){f.doc.hidden=true;f.doc.emit('visibilitychange');}else if(action==='offline'){f.nav.onLine=false;f.win.emit('offline');}else stop();assert.equal(f.reads()[0].options.signal.aborted,true);held.resolve([{id:'stale',status:'recording'}]);await tick();assert.equal(f.store.getState().recordings[0].id,'r');await f.advance(20000);assert.equal(f.reads().length,1);stop();assert.equal(f.timers.size,0);
  }
});
test('logout cancels pending reads and prevents old-account state returning',async()=>{
  const f=fixture(),held=deferred();f.reply(()=>held.promise);const stop=f.start();await tick();await f.store.getState()._lock('',false);assert.equal(f.reads()[0].options.signal.aborted,true);held.resolve([{id:'private',status:'recording'}]);await tick();assert.equal(f.store.getState().recordings.length,0);await f.advance(20000);assert.equal(f.reads().length,1);stop();
});
test('a successful schedule/delete invalidates a pre-mutation read',async()=>{
  for(const action of ['schedule','delete']){
    const f=fixture(),held=deferred();f.reply((url,opts)=>url==='/api/recordings'&&!opts.method?held.promise:{id:'new',status:'scheduled'});const reading=f.store.getState().loadRecordings();await tick();
    if(action==='schedule')await f.store.getState().scheduleRecording({title:'New'});else await f.store.getState().removeRecording('r');held.resolve([{id:'r',status:'scheduled'}]);await reading;assert.equal(f.reads()[0].options.signal.aborted,true);assert.equal(f.store.getState().recordings.some(r=>r.id===(action==='schedule'?'new':'r')),action==='schedule');f.store.getState().cancelRecordingsRefresh();
  }
});

test('server errors and invalid snapshots retain pending jobs and retry at the normal cadence',async()=>{
  const f=fixture();let value=new Response('{}',{status:503});f.reply(()=>value);const stop=f.start();await tick();assert.equal(f.store.getState().recordings[0].status,'scheduled');value={unexpected:true};await f.advance(4000);assert.equal(f.store.getState().recordings[0].status,'scheduled');value=[{id:'r',status:'completed'}];await f.advance(4000);assert.equal(f.store.getState().recordings[0].status,'completed');assert.deepEqual(f.reads().map(r=>r.at),[0,4000,8000]);stop();
});
