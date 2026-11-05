import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
// Exercise the production policy with bounded filesystem faults, never a full disk.
const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function enforceRetention()'), source.indexOf('// Start/finish scheduled', source.indexOf('async function enforceRetention()')));
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
test('retention retains inaccessible files for retry and protects active/future captures', async () => {
  let rows = ['denied','missing','old','active','future'].map((id,i)=>({id,status:id==='future'?'scheduled':id==='active'?'recording':'failed',filename:id,start:new Date(i).toISOString()}));
  let bytes=2000; const removed=[];
  const execute = new AsyncFunction('RECORDINGS_MAX_BYTES','recordingsDirBytes','readCollection','PRUNABLE_STATUSES','isRecording','resolveFile','DATA_DIR','fs','updateCollection','sourceId','console',body+';await enforceRetention();');
  const faults={stat:async file=>({size:500}),unlink:async file=>{if(file==='denied')throw Object.assign(new Error(),{code:'EACCES'});if(file==='missing')throw Object.assign(new Error(),{code:'ENOENT'});removed.push(file);bytes-=500;}};
  const args=[1000,async()=>bytes,async()=>rows,new Set(['completed','interrupted','failed','missed']),id=>id==='active',(_,f)=>f,'',faults,async(_,fn)=>{rows=fn(rows)},x=>x,{warn(){}}];
  await execute(...args);
  assert.deepEqual(removed,['old']);assert.deepEqual(rows.map(r=>r.id),['denied','active','future']);
  faults.unlink=async file=>{removed.push(file);bytes-=500};
  await execute(...args);
  assert.deepEqual(removed,['old','denied']);assert.deepEqual(rows.map(r=>r.id),['active','future']);
});
