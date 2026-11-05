import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function verificationFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-section5-api-'));
  let child, base, logs = '';
  const hook = path.join(root, 'hook.mjs');
  const expressPath = new URL('../../node_modules/express/index.js', import.meta.url).href;
  await fs.writeFile(hook, `import net from 'node:net';import express from ${JSON.stringify(expressPath)};
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};
const appListen=express.application.listen;express.application.listen=function(...args){this.get('/api/__verification/request',(req,res)=>res.json({ip:req.ip,ips:req.ips,secure:req.secure,protocol:req.protocol}));return appListen.apply(this,args)};
${options.hook || ''}`);
  const stop = async () => {
    if (child?.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await exited; } finally { clearTimeout(force); }
    }
  };
  const start = async () => {
    const startAt = logs.length;
    child = spawn(process.execPath, ['--import', hook, options.entry || new URL('../../index.js', import.meta.url).pathname], { env: {
      ...process.env, DATA_DIR: root, PORT: '0', AUTH_USERNAME: 'fixture', AUTH_PASSWORD: 'fixture-bootstrap', AUTH_SESSION_SECRET: '',
      EPG_URL: '', EPG_SIDECAR_URL: '', EPG_SIDECAR_ENABLED: '0', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', RATE_LIMIT_DISABLED: '1',
      PROXY_BLOCK_PRIVATE: '1', PROXY_ALLOWED_CIDRS: '127.0.0.1/32', CORS_ALLOWED_ORIGINS: '', TRUST_PROXY: '', ...options.env,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
    for (let i = 0; i < 500 && !logs.slice(startAt).includes('TEST_PORT=') && child.exitCode === null; i++) await sleep(10);
    const port = logs.slice(startAt).match(/TEST_PORT=(\d+)/)?.[1]; if (!port) throw new Error('Verification API startup failed: ' + logs);
    base = 'http://127.0.0.1:' + port;
  };
  const request = (route, options = {}) => fetch(base + route, options);
  const post = (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cleanup = async () => {
    await stop();
    if (process.env.SECTION5_LOG_DIR) { await fs.mkdir(process.env.SECTION5_LOG_DIR, { recursive: true }); await fs.writeFile(path.join(process.env.SECTION5_LOG_DIR, path.basename(root) + '.log'), logs); }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    if (options.seed) for (const [name, value] of Object.entries(options.seed)) await fs.writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
    await start();
    let cookie;
    if (options.authenticate !== false) {
      const login = await post('/api/auth/login', { username: 'fixture', password: 'fixture-bootstrap' });
      if (!login.ok) throw new Error('Verification bootstrap login failed');
      const response = await post('/api/auth/password', { newPassword: 'fixture-established' }, { cookie: login.headers.get('set-cookie').split(';')[0] });
      if (!response.ok) throw new Error('Verification password rotation failed');
      cookie = response.headers.get('set-cookie').split(';')[0];
    }
    return { root, get base() { return base; }, get child() { return child; }, cookie, request, post, cleanup, restart: async () => { await stop(); await start(); } };
  } catch (error) { await cleanup(); throw error; }
}
