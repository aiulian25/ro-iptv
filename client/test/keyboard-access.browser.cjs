// Keyboard and accessibility-tree checks for the affected real components.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-aud025-browser-'));let server,browser;
  const errors=[],evidence=process.env.AUD025_LOG_DIR;const client=path.resolve(__dirname,'..');
  try{
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=10','-t','60','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',path.join(root,'media.mp4')]);
    const assets=path.join(process.env.AUD025_BUILD_DIR||path.join(client,'dist'),'assets');const css=await fs.readFile(path.join(assets,(await fs.readdir(assets)).find(f=>f.endsWith('.css'))));
    const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import List from './src/components/ChannelList.jsx';import Guide from './src/components/EpgGuide.jsx';import Timeline from './src/components/EpgTimeline.jsx';import Recordings from './src/views/RecordingsView.jsx';import VideoPlayer from './src/components/VideoPlayer.jsx';import RadioView from './src/views/RadioView.jsx';import {useStore} from './src/store/useStore.js';const channel={id:'fixture',tvgId:'c',name:'Fixture TV',kind:'live',url:'/media.mp4',group:'Test'};const radio={id:'radio',name:'Fixture Radio',kind:'radio',url:'/media.mp4',group:'Test'};const now=Date.now();const programmes=[{title:'Keyboard show',start:new Date(now-60000).toISOString(),stop:new Date(now+3600000).toISOString(),desc:'Programme details for keyboard testing.'},{title:'Next show',start:new Date(now+3600000).toISOString(),stop:new Date(now+7200000).toISOString()}];window.selected=0;window.scheduled=[];window.store=useStore;useStore.setState({auth:{checked:true,required:false,authed:true},channels:[channel,radio],currentChannel:channel,settings:{epgUrls:['https://fixture.invalid/guide'],refreshIntervalMinutes:0},epg:{channels:{c:{name:'Fixture TV'}},programmes:{c:programmes}},recordings:[{id:'saved',title:'Saved fixture',status:'completed',filename:'saved.mp4',size:123}],scheduleRecording:r=>window.scheduled.push(r),loadRecordings:async()=>{}});function App(){const [screen,setScreen]=useState('Channels');const select=()=>{window.selected++};window.screen=setScreen;return <><nav className="flex gap-2 flex-wrap p-3">{['Channels','Guide','Timeline','Recordings','Radio'].map(s=><button key={s} onClick={()=>setScreen(s)}>{s}</button>)}</nav><div className="mx-auto max-w-4xl p-4"><div className="aspect-video max-h-72 mb-4"><VideoPlayer channel={channel} onPrev={()=>{}} onNext={()=>{}} onStop={()=>{}}/></div>{screen==='Channels'?<List channels={[channel]} onSelect={select}/>:screen==='Guide'?<Guide channels={[channel]} onSelect={select}/>:screen==='Timeline'?<Timeline channels={[channel]} onSelect={select}/>:screen==='Radio'?<RadioView/>:<Recordings/>}<label>Shortcut select <select><option>One</option><option>Two</option></select></label><a href="#end">Unrelated link</a><button id="outside">Unrelated action</button><p id="end">End</p></div></>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:client,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@shared':path.resolve(client,'../shared')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'before',setup(b){if(process.env.AUD025_BEFORE_DIR)b.onLoad({filter:/\.(jsx|js)$/},async args=>{try{const contents=await fs.readFile(path.join(process.env.AUD025_BEFORE_DIR,path.basename(args.path)),'utf8');return {contents,loader:args.path.endsWith('.jsx')?'jsx':'js',resolveDir:path.dirname(args.path)}}catch{return null}})}}]});
    const media=await fs.readFile(path.join(root,'media.mp4'));
    const fontDir=path.join(client,'public/fonts');const fonts=Object.fromEntries(await Promise.all((await fs.readdir(fontDir)).filter(f=>f.endsWith('.woff2')).map(async f=>['/fonts/'+f,await fs.readFile(path.join(fontDir,f))])));
    server=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(bundle.outputFiles[0].text);return;}
      if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(url.pathname==='/media.mp4'||url.pathname==='/api/recordings/saved/file'){
        res.setHeader('content-type','video/mp4');const m=/bytes=(\d+)-/.exec(req.headers.range||'');const start=m?+m[1]:0;res.writeHead(m?206:200,{'content-length':media.length-start,'accept-ranges':'bytes',...(m?{'content-range':`bytes ${start}-${media.length-1}/${media.length}`}:{})});res.end(media.subarray(start));return;
      }
      if(url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname==='/api/storage'?{recordingsBytes:123}:{}));return;}
      if(url.pathname.startsWith('/fonts/')){if(fonts[url.pathname]){res.setHeader('content-type','font/woff2');res.end(fonts[url.pathname])}else res.writeHead(404).end();return;}
      res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN||undefined,headless:true,args:['--no-sandbox','--disable-background-networking','--autoplay-policy=no-user-gesture-required','--force-renderer-accessibility']});
    for(const width of [1280,390,640]){
      const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:width===640?2:1,serviceWorkers:'block'});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin);await page.waitForFunction(()=>{const v=document.querySelector('video');return v?.readyState>=2&&!v.paused});
      const play=page.getByRole('button',{name:'Play Fixture TV',exact:true});assert.equal(await play.count(),1);await play.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selected),1);await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.selected),2);
      const star=page.getByRole('button',{name:'Add to favourites: Fixture TV',exact:true});await star.focus();assert.equal(await star.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');const paused=await page.locator('video').evaluate(v=>v.paused);await page.keyboard.press('Space');await page.getByRole('button',{name:'Remove from favourites: Fixture TV',exact:true}).waitFor();assert.equal(await page.locator('video').evaluate(v=>v.paused),paused);assert.equal(await page.evaluate(()=>window.selected),2);
      // Tab reaches siblings independently, and Space on unrelated controls cannot
      // trigger a persistent player's page-wide handler.
      await play.focus();await page.keyboard.press('Tab');assert.match(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),/Remove from favourites/);await page.getByRole('link',{name:'Unrelated link'}).focus();await page.keyboard.press('Space');assert.equal(await page.locator('video').evaluate(v=>v.paused),paused);
      await page.getByLabel('Shortcut select').focus();await page.keyboard.press('Space');await page.keyboard.press('Escape');assert.equal(await page.locator('video').evaluate(v=>v.paused),paused);
      const player=page.getByRole('region',{name:/Video player/});await player.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('video').paused);await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused);
      console.log('PASS '+width+'px: Tab/Enter/Space play/star and scoped player shortcuts');if(process.env.AUD025_BASELINE)return;
      await page.getByRole('button',{name:'Guide',exact:true}).focus();await page.keyboard.press('Enter');const details=page.getByRole('button',{name:'Details: Keyboard show on Fixture TV',exact:true});await details.focus();await page.keyboard.press('Space');const dialog=page.getByRole('dialog',{name:'Keyboard show',exact:true});await dialog.waitFor();assert.equal(await dialog.getAttribute('aria-modal'),'true');assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
      for(const key of ['Tab','Tab','Shift+Tab','Shift+Tab']){await page.keyboard.press(key);assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);}
      await page.locator('#outside').evaluate(e=>e.focus());assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
      const cdp=await context.newCDPSession(page),ax=await cdp.send('Accessibility.getFullAXTree');assert.ok(ax.nodes.some(n=>!n.ignored&&n.role?.value==='dialog'&&n.name?.value==='Keyboard show'));if(evidence){await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'ax-dialog-'+width+'.json'),JSON.stringify(ax,null,2));await page.screenshot({path:path.join(evidence,'dialog-'+width+'.png')});}
      await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await details.evaluate(e=>e===document.activeElement),true);
      const schedule=page.getByRole('button',{name:'Schedule Keyboard show',exact:true});await schedule.focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.scheduled.length),1);assert.equal(await page.getByRole('dialog').count(),0);
      await page.getByRole('button',{name:'Timeline',exact:true}).focus();await page.keyboard.press('Space');const grid=page.getByRole('button',{name:'Details: Keyboard show on Fixture TV',exact:true});await grid.focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Keyboard show'}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Space');assert.equal(await grid.evaluate(e=>e===document.activeElement),true);assert.equal(await page.locator('button button').count(),0);
      await page.getByRole('button',{name:'Schedule Keyboard show',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.scheduled.length),2);
      await page.getByRole('button',{name:'Recordings',exact:true}).focus();await page.keyboard.press('Enter');const watch=page.getByRole('button',{name:'Watch',exact:true});await watch.focus();await page.keyboard.press('Space');const recording=page.getByRole('dialog',{name:'Saved fixture'});await recording.waitFor();await page.waitForFunction(()=>{const v=document.querySelector('dialog video');return v?.readyState>=2&&!v.paused});
      for(let i=0;i<12;i++){await page.keyboard.press(i%3===0?'Shift+Tab':'Tab');assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);}
      await page.keyboard.press('Escape');assert.equal(await watch.evaluate(e=>e===document.activeElement),true);
      await watch.press('Enter');await recording.waitFor();await page.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await watch.evaluate(e=>e===document.activeElement),true);
      await watch.press('Enter');await recording.waitFor();await page.mouse.click(5,5);await recording.waitFor({state:'detached'});assert.equal(await watch.evaluate(e=>e===document.activeElement),true);
      await page.getByRole('button',{name:'Radio',exact:true}).focus();await page.keyboard.press('Enter');const radioStar=page.getByRole('button',{name:'Add to favourites: Fixture Radio',exact:true});await radioStar.focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.store.getState().currentChannel?.id),'fixture');const radio=page.getByRole('button',{name:'Play Fixture Radio',exact:true});await radio.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.store.getState().currentChannel?.id),'radio');
      assert.equal(await page.locator('button button').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      console.log('PASS '+width+'px: guide/grid schedule, labelled modal trap/inertness/Escape/restore, Watch, radio and layout');
      if(width===1280){
        await page.evaluate(()=>document.documentElement.style.zoom='2');
        await page.getByRole('button',{name:'Guide',exact:true}).focus();await page.keyboard.press('Enter');
        await page.getByRole('button',{name:'Details: Keyboard show on Fixture TV',exact:true}).focus();await page.keyboard.press('Enter');
        await page.getByRole('dialog',{name:'Keyboard show'}).waitFor();
        assert.equal(await page.locator('dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1}),true);
        for(let i=0;i<4;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);}
        if(evidence)await page.screenshot({path:path.join(evidence,'zoom-200.png')});await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('button',{name:'Details: Keyboard show on Fixture TV',exact:true}).evaluate(e=>e===document.activeElement),true);
        console.log('PASS 200% CSS zoom: modal bounds, Tab/Escape and focus restoration');
      }
      await context.close();
    }
    assert.equal(errors.length,0,errors.join('\n'));
  }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
