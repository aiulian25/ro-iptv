// Real Recordings Watch/seek/Download against an isolated authenticated API.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const { recordingHttpFixture } = await import('../../server/test/helpers/recording-http-fixture.js');
  const f = await recordingHttpFixture(); let browser;
  const errors = [], responses = [];
  try {
    const file = path.join(f.dir, 'movie.mp4');
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x180:rate=10','-t','30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',file]);
    const bytes = await fs.readFile(file);
    const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import RecordingsView from './src/views/RecordingsView.jsx';import {useStore} from './src/store/useStore.js';useStore.setState({recordings:[{id:'movie',title:'Fixture movie',status:'completed',filename:'movie.mp4',size:${bytes.length}}],loadRecordings:async()=>{}});createRoot(document.getElementById('app')).render(<RecordingsView/>);`, resolveDir: path.resolve(__dirname,'..'), loader:'jsx' }, bundle:true, write:false, format:'iife', jsx:'automatic', alias:{'@shared':path.resolve(__dirname,'../../shared')}, define:{'process.env.NODE_ENV':'"production"'} });
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless:true, args:['--no-sandbox','--disable-background-networking','--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({ acceptDownloads:true, serviceWorkers:'block' });
    const separator = f.cookie.indexOf('='); await context.addCookies([{ name:f.cookie.slice(0,separator), value:f.cookie.slice(separator+1), url:f.base }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/recordings/movie/file')) responses.push({ status:response.status(), range:response.request().headers().range || '', contentRange:response.headers()['content-range'] || '', download:response.url().includes('dl=1') }); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()); if (url.origin !== f.base) return route.abort();
      if (url.pathname === '/aud023-test') return route.fulfill({ contentType:'text/html', body:'<!doctype html><html><body><div id="app"></div><script src="/aud023-bundle.js"></script></body></html>' });
      if (url.pathname === '/aud023-bundle.js') return route.fulfill({ contentType:'application/javascript', body:bundle.outputFiles[0].text });
      return route.continue();
    });
    await page.goto(f.base + '/aud023-test'); await page.getByRole('button', { name:/Watch/ }).click();
    await page.waitForFunction(() => { const v=document.querySelector('video'); return v && v.readyState >= 2 && v.videoWidth === 320 && !v.paused && !v.error; });
    await page.evaluate(() => { const v=document.querySelector('video'); v.pause(); v.currentTime=23; });
    await page.waitForFunction(() => { const v=document.querySelector('video'); return !v.seeking && v.readyState>=2 && Math.abs(v.currentTime-23)<0.5 && !v.error; });
    console.log('PASS actual Recordings Watch plays and seeks a generated MP4');
    const tail = await page.evaluate(async () => { const r=await fetch('/api/recordings/movie/file',{headers:{Range:'bytes=-64'}});return {status:r.status,range:r.headers.get('content-range'),bytes:[...new Uint8Array(await r.arrayBuffer())]}; });
    assert.equal(tail.status,206);assert.equal(tail.range,`bytes ${bytes.length-64}-${bytes.length-1}/${bytes.length}`);assert.deepEqual(Buffer.from(tail.bytes),bytes.subarray(-64));
    await page.getByRole('button', { name:'Close', exact:true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('link',{name:/Download/}).click();const download=await pending;
    assert.equal(download.suggestedFilename(),'Fixture _ title.mp4'); assert.equal(await download.failure(),null);assert.deepEqual(await fs.readFile(await download.path()),bytes);
    assert.ok(responses.some(r=>r.status===206 && r.range));assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS suffix fetch, exact-byte Download and authenticated Range playback; no page errors');
    if (process.env.AUD023_LOG_DIR) await fs.writeFile(path.join(process.env.AUD023_LOG_DIR,'browser-responses.json'), JSON.stringify(responses,null,2));
  } finally { await browser?.close(); await f.cleanup(); }
})().catch(error => { console.error(error); process.exitCode=1; });
