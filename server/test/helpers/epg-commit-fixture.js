import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
export async function epgFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix || 'ro-iptv-aud015-fixture-'));
  let child, logs = '', released = [], hold = false;
  const hits = {};
  const provider = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const id = req.url.includes('b.xml') ? 'B' : 'A';
    const send = () => res.end(options.xml ? options.xml(req.url) : `<tv><channel id="${id}"><display-name>Guide ${id}</display-name></channel></tv>`);
    if (hold) { hold = false; released.push(send); } else send();
  });
  const cleanup = async () => {
    for (const send of released) send(); released = [];
    if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    const logDir = options.logDir || process.env.AUD015_LOG_DIR;
    if (logDir) { await fs.mkdir(logDir, { recursive: true }); await fs.writeFile(path.join(logDir, 'server.log'), logs); }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${provider.address().port}`;
    const hook = path.join(root, 'port.mjs');
    await fs.writeFile(hook, `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};${options.control ? `const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;process.on('message',async message=>{try{if(message.command==='clock')offset=message.value;else if(message.command==='refresh'){const {refreshSource}=await import(${JSON.stringify(new URL('../../lib/epgstore.js', import.meta.url).href)});await refreshSource(message.value)};process.send({id:message.id})}catch(err){process.send({id:message.id,error:err.message})}});` : ''}`);
    child = spawn(process.execPath, ['--import', hook, new URL('../../index.js', import.meta.url).pathname], { env: { ...process.env, DATA_DIR: root, PORT: '0', AUTH_PASSWORD: '', AUTH_SESSION_SECRET: '', M3U_URL: '', EPG_URL: '', EPG_SIDECAR_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1', PROXY_BLOCK_PRIVATE: '', PROXY_ALLOWED_CIDRS: '' }, stdio: options.control ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
    for (let n = 0; n < 400 && !logs.includes('TEST_PORT='); n++) await new Promise(r => setTimeout(r, 10));
    const port = logs.match(/TEST_PORT=(\d+)/)?.[1]; if (!port) throw new Error('Fixture server failed to start: ' + logs);
    const base = `http://127.0.0.1:${port}`;
    const save = async value => {
      const current = (await (await fetch(base + '/api/state')).json()).find(item => item.key === 'settings');
      const response = await fetch(base + '/api/state/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, baseUpdatedAt: current?.updatedAt || 0 }) });
      if (!response.ok) throw new Error('Fixture settings save failed'); return response.json();
    };
    let serial = 0;
    const control = (command, value) => new Promise((resolve, reject) => {
      const id = ++serial;
      const handler = message => { if (message.id !== id) return; child.off('message', handler); message.error ? reject(new Error(message.error)) : resolve(); };
      child.on('message', handler); child.send({ id, command, value });
    });
    return { root, base, origin, save, hits, cleanup, control, holdNext: () => { hold = true; }, release: () => { for (const send of released) send(); released = []; } };
  } catch (err) { await cleanup(); throw err; }
}
