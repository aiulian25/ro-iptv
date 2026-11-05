// Optional real-store, real-API browser regression; see README for prerequisites.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const client = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const { epgFixture } = await import(pathToFileURL(path.join(client, '../server/test/helpers/epg-commit-fixture.js')));
  const f = await epgFixture(); let server, browser;
  try {
    await f.save({ epgUrls: [f.origin + '/a.xml'] });
    const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Settings from './src/views/SettingsPage.jsx';import {useStore} from './src/store/useStore.js';useStore.setState({auth:{checked:true,required:false,authed:true}});window.store=useStore;await useStore.getState()._syncState();await useStore.getState().loadEpg();window.renderSettings=()=>createRoot(document.getElementById('app')).render(<Settings/>);window.renderSettings();`, resolveDir: client, loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', alias: { '@shared': path.resolve(client, '../shared') }, define: { 'process.env.NODE_ENV': '"production"' } });
    server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/api/')) {
        try {
          let body = ''; for await (const chunk of req) body += chunk;
          const response = await fetch(f.base + req.url, { method: req.method, headers: body ? { 'content-type': 'application/json' } : {}, body: body || undefined });
          res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
        } catch { res.writeHead(502).end('{}'); } return;
      }
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return; }
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><div id="app"></div><script type="module" src="/bundle.js"></script>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [], events = []; page.setDefaultTimeout(10000);
    page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
    page.on('request', r => { if (r.url().includes('/api/state/settings') && r.method() === 'PUT') events.push('save'); if (r.url().includes('/api/epg/merged')) events.push('guide'); if (r.url().includes('/api/epg/coverage')) events.push('coverage'); });
    await page.goto(origin); await page.getByRole('heading', { name: /Settings$/ }).waitFor();
    await page.waitForFunction(() => window.store.getState().epg?.channels.A);
    await pause(150); events.length = 0;
    let release;
    await page.route('**/api/state/settings', async route => { await new Promise(r => release = r); events.push('ack-release'); await route.continue(); });
    await page.getByRole('button', { name: 'Remove ' + f.origin + '/a.xml', exact: true }).click();
    await page.getByLabel('EPG guide URL').fill(f.origin + '/b.xml');
    await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saving settings and refreshing guide…', { exact: true }).waitFor();
    await page.waitForFunction(() => window.store.getState().settingsSaving);
    assert.equal(await page.evaluate(() => window.store.getState().toast?.message === 'Settings saved'), false);
    assert.deepEqual(events, ['save']);
    release(); await page.waitForFunction(() => !window.store.getState().settingsSaving && window.store.getState().epg?.channels.B);
    assert.deepEqual(events.slice(0, 2), ['save', 'ack-release']); assert.equal(events.filter(e => e === 'guide').length, 1);
    await page.unroute('**/api/state/settings');
    console.log('PASS real Settings Save: delayed acknowledgement precedes one B guide read and source coverage refresh');
    // A failed save keeps the source draft and the old confirmed guide.
    await page.route('**/api/state/settings', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic disk failure"}' }));
    await page.getByRole('button', { name: 'Remove ' + f.origin + '/b.xml', exact: true }).click();
    await page.getByLabel('EPG guide URL').fill(f.origin + '/a.xml'); await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Retry Save' }).waitFor();
    assert.ok(await page.evaluate(() => window.store.getState().epg.channels.B));
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor(); await page.unroute('**/api/state/settings');
    console.log('PASS failed real-store save retains draft/confirmed B and displays actionable retry');
    // Exercise real link/unlink controls with the same real store and API.
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.evaluate(() => window.store.setState({ channels: [{ id: 'p__fixture', name: 'Fixture', kind: 'live', country: 'ro' }] }));
    // EpgLinkButton is also available in the coverage misses; seed one server playlist.
    await fetch(f.base + '/api/playlists/p/file?revision=0&operationId=fixture', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '#EXTM3U\n#EXTINF:-1 tvg-id="missing" tvg-country="RO",Fixture\nhttps://stream.example/live\n' });
    const rows = await (await fetch(f.base + '/api/playlists/p/channels')).json();
    const raw = rows.channels?.[0] || rows[0]; assert.ok(raw);
    const channel = { ...raw, id: raw.id.startsWith('p__') ? raw.id : 'p__' + raw.id, playlistId: 'p' };
    await page.evaluate(channel => window.store.setState({ channels: [channel] }), channel);
    await page.reload(); await page.getByRole('heading', { name: /Settings$/ }).waitFor();
    await page.evaluate(channel => window.store.setState({ channels: [channel] }), channel);
    if (!await page.getByRole('button', { name: /Link EPG$/ }).count()) await page.getByRole('button', { name: /matched 0 of 1/ }).click();
    await page.getByRole('button', { name: /Link EPG$/ }).click();
    events.length = 0;
    await page.getByRole('button', { name: /Guide B/ }).click();
    await page.getByRole('button', { name: /Guide B/ }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Unlink', exact: true }).waitFor(); await pause(150);
    assert.equal(events.filter(e => e === 'coverage').length, 1); assert.equal(events[0], 'save');
    const persisted = await (await fetch(f.base + '/api/state')).json(); assert.equal(persisted.find(r => r.key === 'settings').value.epgOverrides[channel.id], 'B');
    events.length = 0; await page.getByRole('button', { name: 'Unlink', exact: true }).click(); await page.getByRole('button', { name: /matched 0 of 1/ }).waitFor(); await pause(150);
    assert.equal(events.filter(e => e === 'coverage').length, 1); assert.equal(events[0], 'save');
    assert.deepEqual(errors, []); console.log('PASS real link/unlink: persisted map then exactly one coverage read, idle, no page errors');
    events.length = 0; await f.save({ epgUrls: [f.origin + '/a.xml'] });
    await page.evaluate(() => window.store.getState()._syncState());
    await page.waitForFunction(() => window.store.getState().epg?.channels.A); await pause(150);
    assert.equal(events.filter(e => e === 'guide').length, 1);
    console.log('PASS another device commits A: state sync loads its guide without a page reload');
    await context.close();
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await f.cleanup();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
