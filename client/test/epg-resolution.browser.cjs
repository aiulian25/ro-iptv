// Optional Chrome regression for real coverage, matching and manual repair.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const client = path.resolve(__dirname, '..');
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
(async () => {
  const { epgFixture } = await import(pathToFileURL(path.join(client, '../server/test/helpers/epg-commit-fixture.js')));
  let mode = 'old';
  const f = await epgFixture({ prefix: 'ro-iptv-aud016-browser-', control: true, logDir: process.env.AUD016_LOG_DIR, xml: () => `<tv><channel id="${mode === 'old' ? 'old' : 'new'}"><display-name>Guide ${mode === 'old' ? 'old' : 'new'}</display-name></channel>${mode === 'metadata' ? '' : `<programme channel="${mode}" start="${stamp(Date.now() - 3600000)}" stop="${stamp(Date.now() + 3600000)}"><title>Fixture show</title></programme>`}</tv>` });
  let server, browser;
  try {
    const source = f.origin + '/same.xml';
    const uploaded = await fetch(f.base + '/api/playlists/p/file?revision=0&operationId=resolution', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '#EXTM3U\n#EXTINF:-1 tvg-id="old",Fixture\nhttps://stream.example/live\n' }); assert.equal(uploaded.status, 200);
    const rows = await (await fetch(f.base + '/api/playlists/p/channels')).json();
    const channel = { ...rows.channels[0], id: 'p__' + rows.channels[0].id, playlistId: 'p' };
    await f.save({ epgUrls: [source], epgOverrides: { [channel.id]: 'old' } });
    const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Coverage from './src/components/EpgCoverage.jsx';import {useStore} from './src/store/useStore.js';useStore.setState({auth:{checked:true,required:false,authed:true},channels:[${JSON.stringify(channel)}]});window.store=useStore;await useStore.getState()._syncState();await useStore.getState().loadEpg();createRoot(document.getElementById('app')).render(<Coverage/>);`, resolveDir: client, loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', alias: { '@shared': path.resolve(client, '../shared') }, define: { 'process.env.NODE_ENV': '"production"' } });
    server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/api/')) {
        try { let text = ''; for await (const chunk of req) text += chunk;
          const r = await fetch(f.base + req.url, { method: req.method, headers: text ? { 'content-type': 'application/json' } : {}, body: text || undefined });
          res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
        } catch { res.writeHead(502).end('{}'); } return;
      }
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return; }
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body><main id="app"></main><script type="module" src="/bundle.js"></script></body></html>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.getByText(/Guide links matched 1 of 1/).waitFor(); await page.getByText('1 with programmes in loaded window', { exact: true }).waitFor();
    mode = 'new'; await f.control('refresh', source); await page.evaluate(() => window.store.getState().loadEpg());
    await page.getByText(/Guide links matched 0 of 1/).waitFor(); await page.getByText('Manual target missing — repair or unlink', { exact: true }).waitFor();
    assert.equal(await page.evaluate(id => window.store.getState().settings.epgOverrides[id], channel.id), 'old');
    await page.getByRole('button', { name: /Repair link$/ }).last().click(); await page.getByRole('button', { name: /Guide new/ }).click();
    await page.getByText(/Guide links matched 1 of 1/).waitFor(); await page.getByText('Linked · schedule available', { exact: true }).waitFor();
    const saved = (await (await fetch(f.base + '/api/state')).json()).find(r => r.key === 'settings'); assert.equal(saved.value.epgOverrides[channel.id], 'new');
    console.log('PASS same-count refresh marks missing target without reassignment; real Repair link persists the chosen replacement');
    mode = 'metadata'; await f.control('refresh', source); await page.evaluate(() => window.store.getState().loadEpg());
    await page.getByText(/Guide links matched 1 of 1/).waitFor(); await page.getByText('0 with programmes in loaded window', { exact: true }).waitFor();
    await page.getByText('Linked · no programmes in loaded window', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Unlink', exact: true }).click(); await page.getByText(/Guide links matched 0 of 1/).waitFor();
    assert.deepEqual(errors, []); console.log('PASS metadata-only link is distinguished from schedule coverage; unlink remains available; no browser errors');
    await context.close();
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await f.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
