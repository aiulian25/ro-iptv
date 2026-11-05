// Optional real-browser regression runner. Supply PLAYWRIGHT_MODULE and, when
// needed, CHROME_BIN; no browser package or application dependency is installed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const client = path.resolve(__dirname, '..');
const component = path.join(client, 'src/components/EpgCoverage.jsx');
const channel = { id: 'p__fixture', name: 'Fixture channel', tvgId: 'other' };
function body(overrides = {}) {
  const matched = !!overrides[channel.id];
  return { altNamesAvailable: true, byCountry: [{ key: 'ro', total: 1, matched: +matched, pct: matched ? 100 : 0, unmatched: matched ? [] : [channel] }] };
}
const storeSource = `import {create} from 'zustand';
const mode = new URLSearchParams(location.search).get('mode');
const settings = mode === 'missing' ? {} : {epgOverrides: mode === 'populated' ? {'p__fixture':'guide-1'} : {}};
export const useStore = create((set,get)=>({settings, channels:[${JSON.stringify(channel)}],epg:{channels:{'guide-1':{name:'Fixture guide one'},'guide-2':{name:'Fixture guide two'}}},
 async applySettings(partial){const response=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(partial)});if(!response.ok)throw new Error('Save failed');await response.json();set({settings:{...get().settings,...partial}})}
}));
window.coverageFixture={store:useStore};`;
(async () => {
  const bundle = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Coverage from './src/components/EpgCoverage.jsx';const root=createRoot(document.getElementById('app'));window.mountCoverage=()=>root.render(<Coverage/>);window.unmountCoverage=()=>root.render(null);window.mountCoverage();`, resolveDir: client, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@shared': path.resolve(client, '../shared') },
    plugins: [{ name: 'coverage-fixture', setup(builder) {
      builder.onResolve({ filter: /\/store\/useStore$/ }, () => ({ path: 'store', namespace: 'fixture' }));
      builder.onResolve({ filter: /\/lib\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'store' ? storeSource : `export const api={epgCoverage:async()=>{const response=await fetch('/coverage');if(!response.ok)throw new Error('Coverage failed');return response.json()}};`, resolveDir: client }));
      builder.onLoad({ filter: /EpgCoverage\.jsx$/ }, async () => ({ contents: await fs.readFile(process.env.AUD014_COVERAGE_SOURCE || component, 'utf8'), loader: 'jsx', resolveDir: path.dirname(component) }));
    } }],
  });
  let browser;
  let calls = [], saved = {}, holds = [], holdNext = false, failNext = false, events = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/coverage') {
      calls.push({ id: calls.length + 1 }); events.push('coverage');
      res.setHeader('content-type', 'application/json');
      if (holdNext) { holdNext = false; holds.push(res); return; }
      // Bound the intentionally broken baseline run, while still detecting it.
      if (failNext || calls.length > 25) { failNext = false; res.writeHead(503).end('{}'); return; }
      res.end(JSON.stringify(body(saved))); return;
    }
    if (pathname === '/save') {
      events.push('save-start'); let text = ''; for await (const chunk of req) text += chunk;
      saved = JSON.parse(text).epgOverrides || {}; events.push('save-ack');
      res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return;
    }
    if (pathname === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check) { for (let i = 0; i < 200 && !check(); i++) await pause(10); assert.ok(check(), 'Expected request did not arrive'); }
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    let page;
    async function fresh(mode, options = {}) {
      if (page) await page.close();
      for (const res of holds) if (!res.destroyed) res.destroy();
      calls = []; events = []; holds = []; holdNext = !!options.hold; failNext = !!options.fail;
      saved = mode === 'populated' ? { 'p__fixture': 'guide-1' } : {};
      page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/?mode=' + mode); await until(() => calls.length > 0);
      return page;
    }
    for (const mode of ['missing', 'empty', 'populated']) {
      await fresh(mode); await page.getByText(mode === 'populated' ? /matched 1 of 1/ : /matched 0 of 1/).waitFor();
      await pause(250); assert.equal(calls.length, 1, mode + ': exactly one initial request and idle afterward');
      await page.evaluate(() => { const s = window.coverageFixture.store; s.setState({ settings: { ...s.getState().settings, volume: 0.5 }, channels: [...s.getState().channels] }); });
      await pause(100); assert.equal(calls.length, 1, 'Unrelated renders do not request coverage');
      if (mode !== 'populated') {
        await page.evaluate(() => { const s = window.coverageFixture.store; s.setState({ settings: { epgOverrides: {} } }); });
        await pause(75);
        await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: null } }));
        await pause(75); assert.equal(calls.length, 1, 'Absent, empty and null maps are semantically equivalent');
      }
      console.log('PASS ' + mode + ' overrides: one initial request, idle across coverage/unrelated renders');
    }
    saved = { 'p__fixture': 'guide-1', extra: 'guide-2' };
    await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: { 'p__fixture': 'guide-1', extra: 'guide-2' } } }));
    await until(() => calls.length === 2); await pause(100);
    await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: { extra: 'guide-2', 'p__fixture': 'guide-1' } } }));
    await pause(150); assert.equal(calls.length, 2, 'Equivalent replacement/key order is not a change');
    console.log('PASS semantic map changes reload once; equivalent objects/key order do not reload');

    await fresh('empty', { hold: true });
    saved = { 'p__fixture': 'guide-1' };
    await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: { 'p__fixture': 'guide-1' } } }));
    await until(() => calls.length === 2); await page.getByText(/matched 1 of 1/).waitFor();
    holds.shift().end(JSON.stringify(body({}))); await pause(150);
    assert.equal(calls.length, 2); assert.match(await page.locator('#app').innerText(), /matched 1 of 1/);
    console.log('PASS changed links during initial loading fetch immediately; late old success is ignored');

    await fresh('empty', { hold: true }); saved = { 'p__fixture': 'guide-1' };
    await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: { 'p__fixture': 'guide-1' } } }));
    await until(() => calls.length === 2); await page.getByText(/matched 1 of 1/).waitFor();
    holds.shift().writeHead(503).end('{}'); await pause(100); assert.match(await page.locator('#app').innerText(), /matched 1 of 1/);
    console.log('PASS late old failure cannot clear newer coverage');

    await fresh('empty', { fail: true }); await pause(200); assert.equal(calls.length, 1);
    saved = { 'p__fixture': 'guide-1' };
    await page.evaluate(() => window.coverageFixture.store.setState({ settings: { epgOverrides: { 'p__fixture': 'guide-1' } } }));
    await page.getByText(/matched 1 of 1/).waitFor(); assert.equal(calls.length, 2);
    console.log('PASS errors have no automatic retry loop; a meaningful change can retry');

    await fresh('empty', { hold: true }); await page.evaluate(() => window.unmountCoverage());
    holds.shift().end(JSON.stringify(body({}))); await pause(100); assert.equal(await page.locator('#app').innerText(), '');
    await page.evaluate(() => window.mountCoverage()); await page.getByText(/matched 0 of 1/).waitFor();
    assert.equal(calls.length, 2); console.log('PASS unmounted response is ignored; remount gets one fresh request');

    await fresh('missing'); await page.getByRole('button', { name: /matched 0 of 1/ }).click();
    await page.getByRole('button', { name: /Link EPG$/ }).click();
    await page.getByRole('button', { name: /Fixture guide one/ }).click();
    await page.getByText(/matched 1 of 1/).waitFor(); await pause(150); assert.equal(calls.length, 2);
    assert.deepEqual(events.slice(-3), ['save-start', 'save-ack', 'coverage']);
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await page.getByText(/matched 0 of 1/).waitFor(); await pause(150); assert.equal(calls.length, 3);
    assert.deepEqual(events.slice(-3), ['save-start', 'save-ack', 'coverage']);
    console.log('PASS real link/unlink controls: one coverage refresh per acknowledged fixture-store change, then idle');
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS no browser page errors');
  } finally {
    await browser?.close();
    for (const res of holds) if (!res.destroyed) res.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
