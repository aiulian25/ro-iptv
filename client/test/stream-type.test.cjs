const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
const source = process.env.AUD022_PLAY_SOURCE || path.join(client, 'src/lib/playSource.js');
const code = fs.readFileSync(source, 'utf8').replace(/^import .*;\n/gm, '').replace(/export (async )?function /g, '$1function ');
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture({ supported = true, native = false, fetcher = async () => new Response('#EXTM3U\n', { headers: { 'content-type': 'application/octet-stream' } }) } = {}) {
  const instances = [], urls = [], probes = [], errors = [], events = new Map();
  class Hls {
    static Events = { MANIFEST_PARSED:'manifest',LEVEL_SWITCHED:'level',FRAG_LOADED:'fragment',ERROR:'error' };
    static ErrorTypes = { NETWORK_ERROR:'networkError', MEDIA_ERROR:'mediaError' };
    static isSupported(){return supported;}
    constructor(){this.events={};this.network=0;this.media=0;instances.push(this);}
    loadSource(url){urls.push(url);}attachMedia(){}on(name,callback){this.events[name]=callback;}destroy(){this.destroyed=true;}startLoad(){this.network++;}recoverMediaError(){this.media++;}
  }
  const context = { Hls, URL, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout, sessionGeneration: () => 1, sourceCandidates: channel => [channel.url, '/proxy'], memoDirect(){}, proxied: (url,ua,ref) => 'guarded-proxy?'+new URLSearchParams({url,ua:ua||'',ref:ref||''}), sessionFetch: async (...args) => { probes.push(args); return fetcher(...args); } };
  vm.runInNewContext(code,context);
  const media = { canPlayType: () => native ? 'probably' : '', set src(url){urls.push(url);}, play:async()=>{}, pause(){}, addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name),error:{code:4} };
  const attach = channel => context.attachStream(media,channel,{hlsRef:{current:null},onError:value=>errors.push(value),probeTimeoutMs:30});
  return { context, instances, urls, probes, errors, media, attach };
}
test('unknown extensionless input sniffs HLS through authenticated proxy and starts HLS.js',async()=>{
  const f=fixture();const stop=f.attach({url:'https://fixture.example/tokenized?token=synthetic-private',httpUserAgent:'Agent',httpReferrer:'https://fixture.example/'});await tick();
  assert.equal(f.instances.length,1);assert.equal(f.probes.length,1);assert.match(f.probes[0][0],/^guarded-proxy/);assert.match(f.probes[0][0],/ua=Agent/);assert.equal(f.probes[0][1].method,'GET');assert.equal(f.probes[0][1].credentials,'same-origin');stop();
});
test('metadata, pathname including fragment/query and MIME hints centralize HLS/native selection',()=>{
  const f=fixture();assert.equal(f.context.streamTypeHint({url:'https://fixture/live.M3U8?token=x#fragment'}),'hls');assert.equal(f.context.streamTypeHint({url:'/opaque',mimeType:'audio/x-mpegurl; charset=utf-8'}),'hls');assert.equal(f.context.streamTypeHint({url:'/file.mp4'}),'native');assert.equal(f.context.streamTypeHint({url:'/opaque',contentType:'audio/mpeg'}),'native');
});
test('HLS uses native support when MSE is unavailable, otherwise unsupported is terminal',()=>{
  const native=fixture({supported:false,native:true});native.attach({url:'/opaque',mimeType:'application/vnd.apple.mpegurl'});assert.equal(native.instances.length,0);assert.deepEqual(native.urls,['/opaque']);
  const unsupported=fixture({supported:false});unsupported.attach({url:'/file.m3u8'});assert.equal(unsupported.errors[0].unsupported,true);assert.equal(unsupported.probes.length,0);
});
test('a native startup failure can upgrade a misleading filename to sniffed HLS once',async()=>{
  const f=fixture();const stop=f.attach({url:'https://fixture/not-really.mp4'});await f.media.onerror();assert.equal(f.instances.length,1);assert.equal(f.probes.length,1);stop();
});
test('prefix retention/read count is bounded and body cancellation always happens',async()=>{
  let reads=0,cancelled=false;
  const f=fixture({fetcher:async()=>({ok:true,headers:new Headers({'content-type':'application/octet-stream'}),body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(65536).fill(65)};},cancel:async()=>{cancelled=true;}})}})});
  assert.equal(await f.context.probeStreamType({url:'/large'}),'unknown');assert.equal(reads,1);assert.equal(cancelled,true);
});
test('generic HLS prefix accepts a BOM split across network chunks',async()=>{
  const chunks=[new Uint8Array([0xef]),new Uint8Array([0xbb]),new Uint8Array([0xbf]),new TextEncoder().encode('#EX'),new TextEncoder().encode('TM3U\n')];
  const f=fixture({fetcher:async()=>({ok:true,headers:new Headers({'content-type':'application/octet-stream'}),body:{getReader:()=>({read:async()=>({done:!chunks.length,value:chunks.shift()}),cancel:async()=>{}})}})});
  assert.equal(await f.context.probeStreamType({url:'/bom'}),'hls');
});
test('probe deadline and stopping an attachment cancel stalled requests without a late source load',async()=>{
  let aborted=0;
  const f=fixture({fetcher:(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true});})});
  await assert.rejects(f.context.probeStreamType({url:'/stall'},{timeoutMs:10}),/Aborted/);
  const stop=f.attach({url:'https://fixture/unknown'});stop();await tick();assert.equal(aborted,2);assert.equal(f.urls.length,0);assert.equal(f.errors.length,0);
});
test('policy/auth/throttle probe failures do not bypass the proxy with a native attempt',async()=>{
  for(const status of [401,403,429]){const f=fixture({fetcher:async()=>new Response('{}',{status})});f.attach({url:'https://fixture/unknown'});await tick();assert.equal(f.urls.length,0);assert.equal(f.errors[0].probeFailed,true);}
});
test('unsupported codec terminates once; fatal recovery is finite and contains no raw provider data',async()=>{
  const f=fixture();f.attach({url:'/stream.m3u8'});await f.instances[0].events.error(null,{fatal:true,details:'manifestIncompatibleCodecsError',url:'synthetic-private'});assert.equal(f.errors.length,1);assert.equal(f.errors[0].unsupportedCodec,true);assert.ok(!JSON.stringify(f.errors).includes('synthetic-private'));
  const recover=fixture();recover.attach({url:'/stream.m3u8'});const instance=recover.instances[0];instance.events.fragment();await instance.events.error(null,{fatal:true,type:'mediaError'});await instance.events.error(null,{fatal:true,type:'mediaError'});await instance.events.error(null,{fatal:true,type:'mediaError'});assert.equal(instance.media,1);assert.equal(recover.errors.length,1);assert.equal(instance.destroyed,true);
});
test('sessionFetch combines caller cancellation with the logout generation boundary',async()=>{
  const bundle=buildSync({entryPoints:[path.join(client,'src/lib/privacy.js')],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text;
  for(const native of [true,false]){
    const signals=[];const context={module:{exports:{}},exports:{},AbortController,...(native?{AbortSignal}:{}),fetch:async(_url,{signal})=>{signals.push(signal);return new Response('{}');}};vm.runInNewContext(bundle,context);const api=context.module.exports;
    const caller=new AbortController();await api.sessionFetch('/probe',{signal:caller.signal});caller.abort();assert.equal(signals[0].aborted,true);
    await api.sessionFetch('/second',{signal:new AbortController().signal});api.invalidateSession();assert.equal(signals[1].aborted,true);
  }
});
