import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseGuideOffThread } from '../lib/epgparse.js';
const { parseEPG } = await import(process.env.AUD004_EPG_MODULE || '../lib/epg.js');

for (const declaration of [
  '<!DOCTYPE tv [<!ENTITY x "fixture">]>',
  '<!DOCTYPE tv><!DOCTYPE tv>',
  '<!ENTITY x SYSTEM "file:///synthetic-do-not-read">',
]) test('reject unsupported XML declaration: ' + declaration.slice(0, 28), () => {
  assert.throws(() => parseEPG(declaration + '<tv/>'), /Unsupported XMLTV/);
});
test('normal XMLTV DTD, accents and standard entities remain supported', () => {
  const parsed = parseEPG('<!DOCTYPE tv SYSTEM "xmltv.dtd"><tv><channel id="a"><display-name>Știri &amp; Café &#233;</display-name></channel></tv>');
  assert.equal(parsed.channels.a.name, 'Știri & Café é');
});
test('parser queue bounds concurrency, refuses overflow and recovers after timeout/exit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-parse-bound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker.mjs');
  await fs.writeFile(worker, `import {parentPort,workerData} from 'node:worker_threads';
    const a=new Int32Array(workerData.body); const count=Atomics.add(a,0,1)+1;
    Atomics.store(a,1,Math.max(count,Atomics.load(a,1)));
    setTimeout(()=>{Atomics.sub(a,0,1);parentPort.postMessage('parsed')},30);`);
  const shared = new SharedArrayBuffer(8);
  const options = { workerUrl: pathToFileURL(worker), timeoutMs: 3000 };
  const jobs = Array.from({ length: 3 }, () => parseGuideOffThread(shared, options));
  await assert.rejects(parseGuideOffThread(shared, options), /busy/);
  assert.deepEqual(await Promise.all(jobs), ['parsed', 'parsed', 'parsed']);
  assert.equal(new Int32Array(shared)[1], 1);
  await fs.writeFile(worker, 'setInterval(()=>{},1000)');
  await assert.rejects(parseGuideOffThread('', { ...options, timeoutMs: 60 }), /deadline/);
  await fs.writeFile(worker, 'process.exit(0)');
  await assert.rejects(parseGuideOffThread('', options), /without a result/);
  const good = await parseGuideOffThread(Buffer.from('<tv/>'));
  assert.deepEqual(good, { channels: {}, programmes: {} });
});
