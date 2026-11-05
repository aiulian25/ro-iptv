const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/lib/guideClock.js'),'utf8').replace('export function','function'),context);
function fixture(start=5000){
  let now=start,id=0,visibility;const timers=new Map();const doc={hidden:false,addEventListener:(_n,fn)=>visibility=fn,removeEventListener:()=>visibility=null};
  const clock=context.createGuideClock({now:()=>now,document:doc,schedule:(fn,ms)=>{const n=++id;timers.set(n,{fn,at:now+ms});return n},cancel:id=>timers.delete(id)});
  const advance=ms=>{const end=now+ms;for(;;){const due=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!due||due[1].at>end)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=end};
  return {clock,timers,advance,now:()=>now,jump:value=>now=value,visible:value=>{doc.hidden=!value;visibility?.()},hasListener:()=>!!visibility};
}
test('one aligned 30-second timer serves all subscribers without per-second work',()=>{
  const f=fixture();let a=0,b=0;const stopA=f.clock.subscribe(()=>a++),stopB=f.clock.subscribe(()=>b++);assert.equal(f.timers.size,1);f.advance(24999);assert.equal(a,0);f.advance(1);assert.equal(a,1);assert.equal(b,1);assert.equal(f.clock.getSnapshot(),30000);f.advance(60000);assert.equal(a,3);assert.equal(b,3);stopA();assert.equal(f.timers.size,1);stopB();assert.equal(f.timers.size,0);assert.equal(f.hasListener(),false);
});
test('hidden time pauses work; visible return immediately catches up across midnight',()=>{
  const midnight=Date.parse('2026-11-06T00:00:00Z');const f=fixture(midnight-10000);let updates=0;const stop=f.clock.subscribe(()=>updates++);f.visible(false);assert.equal(f.timers.size,0);f.advance(90*60000);assert.equal(updates,0);f.visible(true);assert.equal(updates,1);assert.equal(f.clock.getSnapshot(),f.now());assert.equal(f.timers.size,1);stop();
});
test('wall-clock changes and remount publish actual time and release unused timers',()=>{
  const f=fixture();const stop=f.clock.subscribe(()=>{});stop();f.jump(900000);assert.notEqual(f.clock.getSnapshot(),f.now());let updates=0;const stop2=f.clock.subscribe(()=>updates++);assert.equal(f.clock.getSnapshot(),900000);assert.equal(updates,1);f.jump(1000);f.visible(true);assert.equal(f.clock.getSnapshot(),1000);assert.equal(f.timers.size,1);stop2();assert.equal(f.timers.size,0);
});
