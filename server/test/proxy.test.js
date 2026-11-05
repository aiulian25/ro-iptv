import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { once } from 'node:events';
process.env.PROXY_BLOCK_PRIVATE = '1';
process.env.PROXY_ALLOWED_CIDRS = '127.0.0.1/32';
const { createStreamProxy } = await import('../lib/proxy.js');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await pause(10); assert.ok(fn()); }
async function fixture(t, options = {}) {
  const closed = new Set();
  let maxQueued = 0;
  const origin = http.createServer((req, res) => {
    req.on('close', () => closed.add(req.url));
    if (req.url === '/header-stall') return;
    if (req.url.startsWith('/error-range')) {
      res.writeHead(416, { 'content-range': req.url.endsWith('-invalid') ? 'synthetic-provider-secret' : 'bytes */8', 'content-type': 'text/plain' });
      res.end('synthetic-provider-secret'); return;
    }
    if (req.url === '/untyped') { res.setHeader('content-type', 'application/octet-stream'); res.write(Buffer.from([0xef])); setTimeout(() => { res.write(Buffer.from([0xbb,0xbf])); res.write('#EX'); setTimeout(() => res.end('TM3U\nseg.ts\n'), 5); }, 5); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/guide.m3u8' }); res.end(); return; }
    if (req.url === '/guide.m3u8') { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nseg.ts\n'); return; }
    if (['/large.m3u8', '/chunked.m3u8', '/expand.m3u8', '/expand-tags.m3u8'].includes(req.url)) {
      const body = req.url === '/expand-tags.m3u8' ? '#EXTM3U\n#X:' + 'URI="x",'.repeat(100) : req.url === '/expand.m3u8' ? '#EXTM3U\n' + 'x\n'.repeat(400) : '#EXTM3U\n' + 'x'.repeat(2048);
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      if (req.url === '/large.m3u8') res.setHeader('content-length', Buffer.byteLength(body));
      res.write(body); res.end(); return;
    }
    if (req.url === '/manifest-stall.m3u8' || req.url === '/trickle.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.write('#EXTM3U\n');
      if (req.url === '/trickle.m3u8') { const id = setInterval(() => res.write('\n'), 20); res.on('close', () => clearInterval(id)); }
      return;
    }
    if (req.url === '/raw-stall') { res.setHeader('content-type', 'video/mp2t'); res.flushHeaders(); return; }
    if (req.url === '/raw-partial') { res.setHeader('content-type', 'video/mp2t'); res.write('first'); return; }
    if (req.url === '/range') {
      assert.equal(req.headers.range, 'bytes=2-5');
      res.writeHead(206, { 'content-range': 'bytes 2-5/8', 'content-length': '4', 'accept-ranges': 'bytes', 'content-type': 'video/mp4' }); res.end('2345'); return;
    }
    if (req.url === '/fast') {
      res.setHeader('content-type', 'video/mp2t');
      let sent = 0;
      function send() {
        while (sent < 16 * 1024 * 1024 && !res.destroyed) {
          sent += 16384;
          if (!res.write(Buffer.alloc(16384, 1))) { res.once('drain', send); return; }
        }
        if (!res.destroyed) res.end();
      }
      send(); return;
    }
    res.setHeader('content-type', 'audio/mpeg');
    const id = setInterval(() => res.write('radio'), 20);
    res.on('close', () => clearInterval(id));
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${origin.address().port}`;
  const handler = createStreamProxy({ headerTimeoutMs: 80, idleTimeoutMs: 100, manifestTimeoutMs: 130, manifestMaxBytes: 1024, maxConcurrent: 2, ...options });
  const proxy = http.createServer((req, res) => {
    const write = res.write.bind(res);
    res.write = (...args) => { const result = write(...args); maxQueued = Math.max(maxQueued, res.writableLength); return result; };
    handler(req, res, { target: req.url === '/dns-stall' ? `http://slow.fixture.test:${origin.address().port}/unexpected` : upstream + req.url, headers: req.headers.range ? { Range: req.headers.range } : {}, extra: '&ua=fixture' });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); origin.closeAllConnections(); origin.close(); });
  return { upstream, base: `http://127.0.0.1:${proxy.address().port}`, closed, queued: () => maxQueued };
}

test('normal HLS redirect rewriting, HEAD and byte Range survive', async (t) => {
  const f = await fixture(t, { headerTimeoutMs: 1500, idleTimeoutMs: 1500, manifestTimeoutMs: 1500 });
  const response = await fetch(f.base + '/redirect');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /api\/proxy\?url=/); assert.match(text, /seg.ts/); assert.match(text, /&ua=fixture/);
  const head = await fetch(f.base + '/guide.m3u8', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const range = await fetch(f.base + '/range', { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/8'); assert.equal(await range.text(), '2345');
});
test('upstream errors hide body and unsafe headers while retaining status, HEAD and valid range metadata', async (t) => {
  const f = await fixture(t, { headerTimeoutMs: 1500 });
  const response = await fetch(f.base + '/error-range');
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */8');
  assert.deepEqual(await response.json(), { error: 'upstream 416' });
  const head = await fetch(f.base + '/error-range', { method: 'HEAD' });
  assert.equal(head.status, 416); assert.equal(await head.text(), '');
  const invalid = await fetch(f.base + '/error-range-invalid');
  assert.equal(invalid.headers.get('content-range'), null);
  assert.deepEqual(await invalid.json(), { error: 'upstream 416' });
});
for (const route of ['/large.m3u8', '/chunked.m3u8', '/expand.m3u8', '/expand-tags.m3u8', '/header-stall', '/raw-stall', '/manifest-stall.m3u8', '/trickle.m3u8']) {
  test('bounded proxy rejects ' + route, async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.base + route);
    assert.equal(response.status, 502); await response.text();
    await until(() => f.closed.has(route));
  });
}
for (const route of ['/header-stall', '/manifest-stall.m3u8', '/radio']) {
  test('downstream disconnect cancels ' + route, async (t) => {
    const f = await fixture(t, { headerTimeoutMs: 3000, idleTimeoutMs: 3000, manifestTimeoutMs: 3000 });
    const req = http.get(f.base + route);
    req.on('error', () => {});
    await pause(60); req.destroy();
    await until(() => f.closed.has(route));
  });
}
test('healthy radio lasts beyond header/manifest deadlines and partial raw stall closes', async (t) => {
  const f = await fixture(t);
  const req = http.get(f.base + '/radio');
  req.on('error', () => {});
  const [res] = await once(req, 'response');
  let bytes = 0; res.on('data', (v) => { bytes += v.length; });
  await pause(320); assert.ok(bytes > 30); assert.equal(res.destroyed, false);
  req.destroy(); await until(() => f.closed.has('/radio'));
  const partial = await fetch(f.base + '/raw-partial');
  await assert.rejects(partial.text()); await until(() => f.closed.has('/raw-partial'));
});
test('capacity rejects excess work and recovers after disconnect', async (t) => {
  const f = await fixture(t, { maxConcurrent: 1, headerTimeoutMs: 3000, idleTimeoutMs: 3000 });
  const req = http.get(f.base + '/header-stall'); req.on('error', () => {});
  await pause(40);
  const busy = await fetch(f.base + '/range'); assert.equal(busy.status, 503); assert.equal(busy.headers.get('retry-after'), '2'); await busy.text();
  req.destroy(); await until(() => f.closed.has('/header-stall'));
  const healthy = await fetch(f.base + '/guide.m3u8'); assert.equal(healthy.status, 200); await healthy.text();
});
test('paused reader keeps writable queue and RSS bounded', async (t) => {
  const f = await fixture(t, { idleTimeoutMs: 3000 });
  const start = process.memoryUsage().rss;
  let peak = start;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  t.after(() => clearInterval(sample));
  const req = http.get(f.base + '/fast'); req.on('error', () => {});
  const [res] = await once(req, 'response'); res.pause();
  await pause(300);
  assert.ok(f.queued() <= 256 * 1024, 'writable queue: ' + f.queued());
  assert.ok(peak - start < 64 * 1024 * 1024, 'RSS delta: ' + (peak - start));
  console.log('proxy pressure fixture', JSON.stringify({ maxWritableBytes: f.queued(), rssDeltaBytes: peak - start, pauseMs: 300, offeredBytes: 16 * 1024 * 1024 }));
  req.destroy(); await until(() => f.closed.has('/fast'));
});


test('header deadline covers DNS wait and holds capacity until lookup settles',async(t)=>{
  const f=await fixture(t,{headerTimeoutMs:30,idleTimeoutMs:200,maxConcurrent:1});
  const lookup=dns.lookup;
  let settled=false;
  dns.lookup=async(name,options)=>{
    if(name!=='slow.fixture.test') return lookup(name,options);
    await pause(800);settled=true;return [{address:'127.0.0.1',family:4}];
  };
  t.after(()=>{dns.lookup=lookup});
  const started=Date.now();
  const failed=await fetch(f.base+'/dns-stall');assert.equal(failed.status,502);await failed.text();
  assert.ok(Date.now()-started<500,'DNS wait must not hold the client until lookup ends');
  const busy=await fetch(f.base+'/guide.m3u8');assert.equal(busy.status,503);await busy.text();
  await until(()=>settled);await pause(10);
  const healthy=await fetch(f.base+'/guide.m3u8');assert.equal(healthy.status,200);await healthy.text();
  assert.equal(f.closed.has('/unexpected'),false,'aborted resolution must not open a socket');
});


test('extensionless generic-MIME manifests are sniffed and rewritten without losing prefix chunks', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/untyped');
  assert.match(response.headers.get('content-type'), /mpegurl/);
  const text = await response.text();
  assert.ok(text.startsWith('#EXTM3U'));
  assert.match(text, /api\/proxy/);
  assert.ok(text.includes(encodeURIComponent(f.upstream + '/seg.ts')));
});
