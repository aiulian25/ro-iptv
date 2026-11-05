import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

test('compressed request rejection and aborted compressed responses leave API healthy', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-body-security-'));
  const hook = path.join(root, 'port.mjs');
  await fs.writeFile(hook, `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: root, PORT: '0', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '', EPG_URL: '', EPG_SIDECAR_URL: '', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let i=0; i<300 && !logs.includes('TEST_PORT='); i++) await new Promise((r)=>setTimeout(r,10));
  const port = logs.match(/TEST_PORT=(\d+)/)?.[1];
  assert.ok(port, logs);
  const base = `http://127.0.0.1:${port}`;
  const playlist = '#EXTM3U\n#EXTINF:-1,Știri & Café\nhttp://fixture.invalid/channel\n';
  for (const [route, type, body] of [['/api/parse','text/plain',playlist], ['/api/auth/login','application/json','{}']]) {
    const compressed = gzipSync(body);
    for (const payload of [compressed, Buffer.concat([compressed, Buffer.from('trailing fixture')])]) {
      const r = await fetch(base+route,{method:'POST',headers:{'content-type':type,'content-encoding':'gzip'},body:payload});
      assert.equal(r.status,415);
    }
  }
  const parsed = await fetch(base+'/api/parse',{method:'POST',headers:{'content-type':'text/plain'},body:playlist});
  assert.equal(parsed.status,200);
  assert.match(await parsed.text(), /Știri & Café/);
  const saved = await fetch(base+'/api/state/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:{diagnosticFixture:'x'.repeat(100000)}})});
  assert.equal(saved.status,200);
  for(let i=0;i<8;i++) await new Promise((resolve,reject)=>{
    const req=http.get(base+'/api/state',{headers:{'accept-encoding':'gzip'}},(res)=>{
      assert.equal(res.headers['content-encoding'],'gzip');
      res.once('data',()=>{res.destroy();resolve()});
      res.once('error',reject);
    });req.once('error',reject);
  });
  assert.equal((await fetch(base+'/api/health')).status,200);
  assert.equal(child.exitCode,null);
});
