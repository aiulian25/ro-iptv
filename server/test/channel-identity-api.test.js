import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseM3U, legacyChannelId } from '../../shared/m3u.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('real API migrates references across profiles/restart and starts pending captures with fresh inputs only', {
  timeout: 20000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-identity-api-'));
  let child,
    logs = '',
    version = 'a';
  const provider = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(source());
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + provider.address().port;
  const source = () => `#EXTM3U\n#EXTINF:-1 tvg-id="news" http-user-agent="Agent-${version}",${version === 'a' ? 'Old' : 'Renamed'} News\n${origin}/${version === 'a' ? 'old' : 'moved'}?token=${version}\n`;
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.DATA_DIR+'/inputs.jsonl',JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');fs.writeFileSync(process.argv.at(-1),'synthetic capture');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);\n`, {
    mode: 0o755
  });
  const hook = path.join(root, 'port.mjs');
  await fs.writeFile(hook, `import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?30:ms,...args);`);
  async function stop() {
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
  t.after(async () => {
    await stop();
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    await fs.rm(root, {
      recursive: true,
      force: true
    });
  });
  async function start() {
    logs = '';
    child = spawn(process.execPath, ['--import', hook, new URL('../index.js', import.meta.url).pathname], {
      env: {
        ...process.env,
        DATA_DIR: root,
        PATH: bin + path.delimiter + process.env.PATH,
        PORT: '0',
        AUTH_PASSWORD: '',
        AUTH_SESSION_SECRET: '',
        M3U_URL: '',
        EPG_URL: '',
        EPG_SIDECAR_URL: '',
        REFRESH_INTERVAL_MINUTES: '0',
        RATE_LIMIT_DISABLED: '1',
        PROXY_BLOCK_PRIVATE: '',
        PROXY_ALLOWED_CIDRS: '',
        RECORDING_MAX_MINUTES: '0.1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => logs += d);
    child.stderr.on('data', d => logs += d);
    for (let i = 0; i < 400 && !logs.includes('TEST_PORT='); i++) await pause(10);
    const port = logs.match(/TEST_PORT=(\d+)/)?.[1];
    assert.ok(port);
    return 'http://127.0.0.1:' + port;
  }
  let base = await start();
  const post = (route, body, method = 'POST') => fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  assert.equal((await post('/api/playlists', {
    id: 'p',
    revision: 0,
    url: origin + '/playlist',
    name: 'Fixture'
  })).status, 200);
  const old = parseM3U(source())[0],
    legacy = 'p__' + legacyChannelId(old, new Map());
  await post('/api/state/favourites', {
    value: [legacy]
  }, 'PUT');
  await post('/api/state/settings', {
    value: {
      epgOverrides: {
        [legacy]: 'manual-guide'
      }
    }
  }, 'PUT');
  await post('/api/state/history', {
    value: [{
      ...old,
      id: legacy,
      playlistId: 'p',
      at: 123
    }]
  }, 'PUT');
  const future = await post('/api/recordings', {
    channelId: legacy,
    channelName: old.name,
    url: old.url,
    start: new Date(Date.now() + 1200).toISOString(),
    end: new Date(Date.now() + 5000).toISOString()
  });
  assert.equal(future.status, 200);
  const scheduled = await future.json();
  const activeResponse = await post('/api/recordings/start', {
    channelId: legacy,
    url: old.url,
    channelName: old.name
  });
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fs.readFile(path.join(root, 'inputs.jsonl'), 'utf8')).includes(old.url)) break;
    } catch {}
    await pause(10);
  }
  version = 'b';
  const current = await (await fetch(base + '/api/playlists/p/channels')).json();
  assert.equal(current.version, 3);
  const stable = 'p__' + current.channels[0].id;
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.find(row => row.key === 'favourites').value, [stable]);
  assert.equal(state.find(row => row.key === 'settings').value.epgOverrides[stable], 'manual-guide');
  assert.equal(state.find(row => row.key === 'history').value[0].url, origin + '/moved?token=b');
  let rows = await (await fetch(base + '/api/recordings')).json();
  assert.equal(rows.find(row => row.id === active.id).url, old.url);
  assert.equal(rows.find(row => row.id === scheduled.id).url, origin + '/moved?token=b');
  let inputs = [];
  for (let i = 0; i < 200; i++) {
    inputs = (await fs.readFile(path.join(root, 'inputs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (inputs.some(input => input.args[input.args.indexOf('-i') + 1] === origin + '/moved?token=b')) break;
    await pause(10);
  }
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].args.includes('Agent-b'));
  assert.equal(inputs[0].args[inputs[0].args.indexOf('-i') + 1], old.url);
  assert.equal((await post('/api/recordings', {
    channelId: 'p__unknown',
    channelName: 'Unknown',
    url: old.url,
    start: new Date(Date.now() + 5000).toISOString(),
    end: new Date(Date.now() + 10000).toISOString()
  })).status, 409);
  await stop();
  for (const input of inputs) assert.throws(() => process.kill(input.pid, 0), {
    code: 'ESRCH'
  });
  base = await start();
  const restarted = await (await fetch(base + '/api/playlists/p/channels')).json();
  assert.equal(restarted.channels[0].id, current.channels[0].id);
  assert.equal(restarted.aliases[legacy.slice(3)], current.channels[0].id);
});
