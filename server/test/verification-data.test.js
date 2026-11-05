import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEPG } from '../lib/epg.js';
import { mergeGuides } from '../../shared/normalize.js';

test('XMLTV special keys are own data properties through parsing, merging and JSON', () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const xml = '<tv>' + ids.map(id => `<channel id="${id}"><display-name>${id}</display-name></channel><programme channel="${id}" start="20260101000000Z" stop="20260101010000Z"><title>Fixture</title></programme>`).join('') + '</tv>';
  const parsed = parseEPG(xml), merged = mergeGuides([parsed, parsed]);
  for (const id of ids) { assert.equal(Object.hasOwn(parsed.channels,id),true); assert.equal(parsed.programmes[id].length,1);assert.equal(merged.programmes[id].length,1);assert.equal(Object.hasOwn(merged.channels,id),true);assert.equal(JSON.parse(JSON.stringify(merged)).channels[id].name,id); }
  assert.equal(Object.getPrototypeOf(parsed.channels),Object.prototype);assert.equal(Object.getPrototypeOf(merged.channels),Object.prototype);assert.equal({}.polluted,undefined);
});
test('store I/O faults preserve original bytes and remove temporary files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-section5-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleUrl = new URL('../lib/store.js',import.meta.url).href;
  const code = `import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';const api=await import(${JSON.stringify(moduleUrl)});const file=process.env.DATA_DIR+'/fault.json';await api.writeCollection('fault',[{original:true}]);const bytes=await fs.readFile(file,'utf8');const write=fs.writeFile,rename=fs.rename;fs.writeFile=async function(path,...args){if(String(path).endsWith('.tmp'))throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});return write.call(this,path,...args)};await assert.rejects(api.writeCollection('fault',[{replacement:true}]),{code:'ENOSPC'});assert.equal(await fs.readFile(file,'utf8'),bytes);fs.writeFile=write;await fs.writeFile(file,'{broken');fs.rename=async function(...args){if(args[0]===file)throw Object.assign(new Error('synthetic denied quarantine'),{code:'EACCES'});return rename.apply(this,args)};await assert.rejects(api.updateCollection('fault',()=>[]),{code:'STORE_RECOVERY_FAILED'});assert.equal(await fs.readFile(file,'utf8'),'{broken');fs.rename=rename;await api.readCollection('fault');assert.ok((await fs.readdir(process.env.DATA_DIR)).some(n=>n.startsWith('fault.json.corrupt-')));assert.equal((await fs.readdir(process.env.DATA_DIR)).filter(n=>n.endsWith('.tmp')).length,0);`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DATA_DIR:root},encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
});
test('bounded parser stress rejects DTD/depth abuse and reports resource use', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-section5-parse-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleUrl=new URL('../lib/epg.js',import.meta.url).href;
  const code=`import assert from 'node:assert/strict';const {parseEPG}=await import(${JSON.stringify(moduleUrl)});const start=performance.now();const xml='<tv><channel id="x"><display-name>Fixture</display-name></channel>'+Array.from({length:10000},(_,i)=>'<programme channel="x" start="20260101000000Z" stop="20260101010000Z"><title>Show '+i+'</title></programme>').join('')+'</tv>';assert.equal(parseEPG(xml).programmes.x.length,10000);assert.throws(()=>parseEPG('<!DOCTYPE tv [<!ENTITY e "boom">]><tv/>'));assert.throws(()=>parseEPG('<tv>'+'<x>'.repeat(120)+'</x>'.repeat(120)+'</tv>'));console.log(JSON.stringify({inputBytes:Buffer.byteLength(xml),durationMs:performance.now()-start,...process.memoryUsage()}));`;
  const r=spawnSync(process.execPath,['--max-old-space-size=192','--input-type=module','-e',code],{encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);if(process.env.SECTION5_LOG_DIR){await fs.mkdir(process.env.SECTION5_LOG_DIR,{recursive:true});await fs.writeFile(path.join(process.env.SECTION5_LOG_DIR,'parser-resource.json'),r.stdout)}
});
