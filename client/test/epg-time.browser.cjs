// Optional real-guide browser check for unknown ends and recording guards.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const client = path.resolve(__dirname, '..');
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
(async () => {
  const { epgFixture } = await import(pathToFileURL(path.join(client, '../server/test/helpers/epg-commit-fixture.js')));
  const now = Date.now();
  const f = await epgFixture({ prefix: 'ro-iptv-aud017-browser-', logDir: process.env.AUD017_LOG_DIR, xml: () => `<tv><channel id="c"><display-name>Fixture</display-name></channel><programme channel="c" start="${stamp(now - 600000)}"><title>Inferred show</title></programme><programme channel="c" start="${stamp(now + 600000)}"><title>Terminal unknown</title></programme></tv>` });
  let browser, server;
  try {
    await f.save({ epgUrls: [f.origin + '/times.xml'] });
    const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Guide from './src/components/EpgGuide.jsx';import Timeline from './src/components/EpgTimeline.jsx';import {useStore} from './src/store/useStore.js';const channels=[{id:'fixture',tvgId:'c',name:'Fixture',url:'https://stream.example/live',kind:'live'}];window.scheduled=[];window.store=useStore;useStore.setState({auth:{checked:true,required:false,authed:true},channels,scheduleRecording:input=>window.scheduled.push(input)});await useStore.getState()._syncState();await useStore.getState().loadEpg();function App(){const [grid,setGrid]=useState(false);return <><button onClick={()=>setGrid(!grid)}>Switch guide view</button>{grid?<Timeline channels={channels} onSelect={()=>{}}/>:<Guide channels={channels} onSelect={()=>{}}/>}</>}createRoot(document.getElementById('app')).render(<App/>);`, resolveDir: client, loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', alias: { '@shared': path.resolve(client, '../shared') }, define: { 'process.env.NODE_ENV': '"production"' } });
    server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/api/')) {
        try { let text = ''; for await (const chunk of req) text += chunk; const r = await fetch(f.base + req.url, { method: req.method, headers: text ? { 'content-type': 'application/json' } : {}, body: text || undefined }); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
        catch { res.writeHead(502).end('{}'); } return;
      }
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return; }
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><div id="app"></div><script type="module" src="/bundle.js"></script>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByText('Terminal unknown', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Schedule Terminal unknown', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Schedule Inferred show', exact: true }).click();
    const recorded = await page.evaluate(() => ({ payload: window.scheduled[0], entry: window.store.getState().epg.programmes.c[0] }));
    assert.equal(Date.parse(recorded.payload.end), Date.parse(recorded.entry.stop) + 5 * 60000);
    await page.getByText('Terminal unknown', { exact: true }).click();
    await page.getByRole('heading', { name: 'Terminal unknown' }).waitFor();
    await page.getByText('Recording unavailable until precise start and end times are known.', { exact: true }).waitFor();
    assert.match(await page.locator('#app').innerText(), /End unknown/); await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Switch guide view', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule Terminal unknown', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Schedule Terminal unknown', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Schedule Inferred show', exact: true }).isDisabled(), false);
    await page.getByRole('button', { name: 'Schedule Inferred show', exact: true }).click();
    assert.equal(await page.evaluate(() => window.scheduled.length), 2);
    assert.deepEqual(errors, []); console.log('PASS real parser/API guide: inferred end schedules with padding; terminal unknown is visible, labelled and disabled in list/grid/modal; no page errors');
    await context.close();
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await f.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
