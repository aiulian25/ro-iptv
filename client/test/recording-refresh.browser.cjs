// Real app/store polling against controlled API states and a short real capture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-aud024-browser-'));let browser,server,real;
  const hits=[],errors=[];let rows=[{id:'r',title:'Waiting capture',status:'scheduled',channelId:'fixture',start:new Date().toISOString()}],hold=false,held=[],maxActive=0,active=0,mode='mock',origin;
  try{
    const client=path.resolve(__dirname,'..');
    const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App.jsx';import {useStore} from './src/store/useStore.js';const auth={checked:true,required:false,authed:true,mustChange:false};useStore.setState({auth,channels:[{id:'fixture',name:'Fixture',url:'/provider.ts',kind:'live',group:'Test'}],settings:{epgUrls:[],refreshIntervalMinutes:0},checkAuth:async()=>auth,init:async()=>{await useStore.getState().loadRecordings()},restoreLastChannel:()=>{},retryPlaylistChanges:async()=>{},view:'recordings'});window.store=useStore;createRoot(document.getElementById('app')).render(<App/>);`,resolveDir:client,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@shared':path.resolve(client,'../shared')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'before',setup(b){if(process.env.AUD024_BEFORE_DIR)b.onLoad({filter:/\.(jsx|js)$/},async args=>{const candidate=path.join(process.env.AUD024_BEFORE_DIR,path.basename(args.path));let contents;try{contents=await fs.readFile(candidate,'utf8')}catch{return null}return {contents,loader:args.path.endsWith('.jsx')?'jsx':'js',resolveDir:path.dirname(args.path)}})}}]});
    server=http.createServer(async(req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(bundle.outputFiles[0].text);return;}
      if(url.pathname==='/provider.ts'){
        let bytes;try{bytes=await fs.readFile(path.join(root,'provider.ts'))}catch{res.writeHead(404).end();return;}let offset=0;res.setHeader('content-type','video/mp2t');const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);res.end();return;}res.write(bytes.subarray(offset,offset+188*12));offset+=188*12;},100);res.on('close',()=>clearInterval(timer));return;
      }
      if(url.pathname==='/api/recordings'&&req.method==='GET'){
        hits.push({at:Date.now(),mode});active++;maxActive=Math.max(maxActive,active);let closed=false;res.on('close',()=>{if(!closed){closed=true;active--}});
        const send=async()=>{if(res.destroyed)return;let value=rows;if(mode==='real')value=(await(await fetch(real.base+'/api/recordings',{headers:{cookie:real.cookie}})).json()).filter(r=>r.title==='Real capture');res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
        if(hold)held.push(send);else await send();return;
      }
      if(url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname==='/api/storage'?{recordingsBytes:0}:{}));return;}
      res.setHeader('content-type','text/html');res.end('<!doctype html><div id="app"></div><script src="/bundle.js"></script>');
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN||undefined,headless:true,args:['--no-sandbox','--disable-background-networking']});const context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.getByText('Scheduled',{exact:true}).waitFor();await pause(150);const start=hits.length;rows=[{...rows[0],status:'recording',size:42}];
    await page.getByText('Recording',{exact:true}).waitFor();assert.ok(hits.length>start);await page.getByRole('button',{name:/Stop/}).waitFor();console.log('PASS scheduled → recording and Stop update without navigation');if(process.env.AUD024_BASELINE)return;
    // The same owner updates Live's recording controls across navigation.
    await page.evaluate(()=>{window.store.getState().setView('live');window.store.setState({selectedCountry:'',currentChannel:window.store.getState().channels[0]})});
    await page.getByRole('button',{name:/Stop Recording/i}).waitFor();rows=[{...rows[0],status:'completed',size:42,filename:'r.mp4'}];await page.waitForFunction(()=>window.store.getState().recordings[0]?.status==='completed');
    assert.equal(await page.getByRole('button',{name:/Stop Recording/i}).count(),0);await page.evaluate(()=>window.store.getState().setView('recordings'));await page.getByText('Saved',{exact:true}).waitFor();await pause(100);let count=hits.length;await pause(4300);assert.equal(hits.length,count);console.log('PASS shared Live state and terminal-only polling stops');
    for(const status of ['missed','failed']){rows=[{...rows[0],status:'scheduled'}];await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByText('Scheduled',{exact:true}).waitFor();rows=[{...rows[0],status}];await page.getByText(status==='missed'?'Missed':/^Failed(?: · partial)?$/,{exact:true}).waitFor();}
    console.log('PASS scheduled → missed/failed refreshes without navigation');
    // Stall a read; simultaneous wake events must share it and going hidden cancels it.
    hold=true;await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));window.store.getState().loadRecordings();});await pause(200);count=hits.length;await pause(200);assert.equal(hits.length,count);assert.ok(active<=1);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});for(let i=0;i<100&&active;i++)await pause(10);assert.equal(active,0);
    rows=[{...rows[0],status:'scheduled'}];hold=false;for(const send of held)await send();held=[];await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await page.getByText('Scheduled',{exact:true}).waitFor();console.log('PASS wake deduplication, hidden cancellation and visible catch-up');
    // Schedule an actual local ffmpeg job; accelerate only the fixture scheduler,
    // while the browser keeps the production four-second refresh interval.
    const {recordingHttpFixture}=await import('../../server/test/helpers/recording-http-fixture.js');real=await recordingHttpFixture({schedulerIntervalMs:40});
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-f','mpegts',path.join(root,'provider.ts')]);
    const now=Date.now();const created=await fetch(real.base+'/api/recordings',{method:'POST',headers:{cookie:real.cookie,'content-type':'application/json'},body:JSON.stringify({url:origin+'/provider.ts',channelId:'fixture',channelName:'Fixture',title:'Real capture',start:new Date(now+800).toISOString(),end:new Date(now+7500).toISOString()})});assert.equal(created.status,200);const job=await created.json();mode='real';await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByText('Scheduled',{exact:true}).waitFor();await page.getByText('Recording',{exact:true}).waitFor();await page.waitForFunction(()=>window.store.getState().recordings.some(r=>r.title==='Real capture'&&['completed','interrupted','failed'].includes(r.status)),{},{timeout:16000});
    const finished=await page.evaluate(()=>window.store.getState().recordings.find(r=>r.title==='Real capture'));assert.equal(finished.status,'completed',JSON.stringify(finished));assert.ok(finished.size>0);assert.equal(finished.stopReason,'deadline');
    const probe=execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',path.join(real.dir,job.id+'.mp4')],{encoding:'utf8'});assert.ok(Number(probe)>0);console.log('PASS actual scheduled local ffmpeg capture transitions to recording and completed with a nonempty probed MP4');
    assert.equal(errors.length,0,errors.join('\n'));assert.equal(maxActive,1);if(process.env.AUD024_LOG_DIR){await fs.mkdir(process.env.AUD024_LOG_DIR,{recursive:true});await fs.writeFile(path.join(process.env.AUD024_LOG_DIR,'requests.json'),JSON.stringify(hits,null,2));}
  }finally{await browser?.close();for(const send of held)await send();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await real?.cleanup();await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
