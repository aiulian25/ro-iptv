import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function recordingHttpFixture({ schedulerIntervalMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-aud023-http-'));
  let child, logs = '', serial = 0;
  const cleanup = async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    if (process.env.AUD023_LOG_DIR) {
      await fs.mkdir(process.env.AUD023_LOG_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.AUD023_LOG_DIR, 'server-' + path.basename(root) + '.log'), logs);
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    const dir = path.join(root, 'recordings'); await fs.mkdir(dir);
    const ids = ['fixed', 'empty', 'missing', 'vanish', 'unlinked', 'large', 'readerror', 'movie', 'bad', 'directory'];
    await fs.writeFile(path.join(root, 'recordings.json'), JSON.stringify(ids.map(id => ({ id, title: 'Fixture / title', filename: id === 'bad' ? '../escape.mp4' : id + '.mp4', status: 'completed' }))));
    for (const id of ['fixed', 'vanish', 'unlinked']) await fs.writeFile(path.join(dir, id + '.mp4'), '0123456789abcdef');
    await fs.writeFile(path.join(dir, 'empty.mp4'), '');
    await fs.mkdir(path.join(dir, 'directory.mp4'));
    for (const id of ['large', 'readerror']) { const large = await fs.open(path.join(dir, id + '.mp4'), 'w'); await large.truncate(64 * 1024 * 1024); await large.close(); }
    const hook = path.join(root, 'hook.mjs');
    await fs.writeFile(hook, `import net from 'node:net';import {promises as fs} from 'node:fs';
${schedulerIntervalMs ? `const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?${Number(schedulerIntervalMs)}:ms,...args);` : ''}
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};
const open=fs.open.bind(fs),stat=fs.stat.bind(fs);let opened=0,closed=0;
fs.stat=async function(file,...args){const result=await stat(file,...args);if(String(file).endsWith('/vanish.mp4'))await fs.unlink(file);return result};
fs.open=async function(file,...args){if(String(file).endsWith('/vanish.mp4'))await fs.unlink(file).catch(()=>{});const handle=await open(file,...args);if(String(file).endsWith('.mp4')){opened++;const close=handle.close.bind(handle);let counted=false;handle.close=async()=>{const result=await close();if(!counted){counted=true;closed++}return result};if(String(file).endsWith('/readerror.mp4')){const create=handle.createReadStream.bind(handle);handle.createReadStream=(...args)=>{const stream=create(...args);stream.once('data',()=>queueMicrotask(()=>stream.destroy(Object.assign(new Error('synthetic read failure'),{code:'EIO'}))));return stream}};if(String(file).endsWith('/unlinked.mp4')){const stat=handle.stat.bind(handle);handle.stat=async(...args)=>{const result=await stat(...args);await fs.unlink(file);return result}}}return handle};
process.on('message',message=>{if(message.command==='metrics')process.send({id:message.id,opened,closed})});`);
    child = spawn(process.execPath, ['--import', hook, process.env.AUD023_SERVER_ENTRY || new URL('../../index.js', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: root, PORT: '0', AUTH_USERNAME: 'fixture', AUTH_PASSWORD: 'fixture-bootstrap', AUTH_SESSION_SECRET: '', EPG_URL: '', EPG_SIDECAR_URL: '', EPG_SIDECAR_ENABLED: '0', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1', PROXY_BLOCK_PRIVATE: '', PROXY_ALLOWED_CIDRS: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
    for (let i = 0; i < 400 && !logs.includes('TEST_PORT=') && child.exitCode === null; i++) await sleep(10);
    const port = logs.match(/TEST_PORT=(\d+)/)?.[1]; if (!port) throw new Error('Fixture failed: ' + logs);
    const base = 'http://127.0.0.1:' + port;
    const post = (route, body, cookie) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const login = await post('/api/auth/login', { username: 'fixture', password: 'fixture-bootstrap' });
    if (!login.ok) throw new Error('Fixture login failed');
    const changed = await post('/api/auth/password', { newPassword: 'fixture-password-changed' }, login.headers.get('set-cookie').split(';')[0]);
    if (!changed.ok) throw new Error('Fixture password change failed');
    const cookie = changed.headers.get('set-cookie').split(';')[0];
    const metrics = () => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { child.off('message', handler); reject(new Error('Fixture metrics deadline')); }, 2000);
      const handler = data => { if (data.id !== id) return; clearTimeout(timer); child.off('message', handler); resolve(data); };
      child.on('message', handler); child.send({ id, command: 'metrics' });
    });
    return { root, dir, base, cookie, metrics, cleanup, child };
  } catch (error) { await cleanup(); throw error; }
}
