// Real media regression. Requires Playwright, ffmpeg and a built client CSS file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const client = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-iptv-aud021-browser-'));
  let server, browser, page; const requests = [], errors = [], evidence = process.env.AUD021_LOG_DIR;
  try {
    const assets = path.join(process.env.AUD021_BUILD_DIR || path.join(client, 'dist'), 'assets');
    const css = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(name => name.endsWith('.css'))));
    const video = path.join(root, 'video.mp4'), radio = path.join(root, 'radio.wav');
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','45','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',video]);
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','45','-c:a','pcm_s16le','-y',radio]);
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',video,'-c','copy','-hls_time','4','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_filename',path.join(root,'part-%03d.ts'),'-y',path.join(root,'stream.m3u8')]);
    fs.writeFileSync(path.join(root,'master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nstream.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\nstream.m3u8\n');
    let origin;
    const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App.jsx';import {useStore} from './src/store/useStore.js';const channels=[{id:'tv',name:'Synthetic TV',kind:'live',url:location.origin+'/media/video.mp4',group:'Test',country:'ro'},{id:'radio',name:'Synthetic Radio',kind:'radio',url:location.origin+'/media/radio.wav',group:'Radio',country:'ro'},{id:'hls',name:'Synthetic HLS',kind:'live',url:location.origin+'/media/master.m3u8',group:'Test',country:'ro'}];const auth={checked:true,required:false,authed:true,mustChange:false};useStore.setState({auth,channels,settings:{epgUrls:[],refreshIntervalMinutes:0},checkAuth:async()=>auth,init:async()=>{},restoreLastChannel:()=>{},retryPlaylistChanges:async()=>{},view:'radio',selectedCountry:''});window.store=useStore;window.fixtureChannels=channels;createRoot(document.getElementById('app')).render(<App/>);`, resolveDir: client, loader:'jsx' }, bundle:true, write:false, format:'iife', jsx:'automatic', alias:{'@shared':path.resolve(client,'../shared')}, define:{'process.env.NODE_ENV':'"production"'}, plugins:[{ name:'playback-evidence',setup(builder){
      builder.onLoad({filter:/\.(jsx|js)$/}, async args => {
        let file=args.path;
        if(process.env.AUD021_BEFORE_DIR){const candidate=path.join(process.env.AUD021_BEFORE_DIR,path.basename(file));if(fs.existsSync(candidate))file=candidate;}
        let contents=fs.readFileSync(file,'utf8');
        if(path.basename(args.path)==='playSource.js'){
          contents=contents.replace('export function attachStream(', 'function originalAttachStream(');
          contents+=`\nexport function attachStream(...args){window.playbackStats.attach++;const stop=originalAttachStream(...args);window.playbackStats.options=args[2];return()=>{window.playbackStats.detach++;stop()}}`;
        }
        return {contents,loader:args.path.endsWith('.jsx')?'jsx':'js',resolveDir:path.dirname(args.path)};
      });
    }}] });
    server=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(bundle.outputFiles[0].text);return;}
      if(url.pathname.startsWith('/fonts/')){const file=path.join(client,'public',url.pathname);if(fs.existsSync(file)){res.setHeader('content-type','font/woff2');res.end(fs.readFileSync(file));}else res.writeHead(404).end();return;}
      if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(url.pathname.startsWith('/media/')){
        requests.push({path:url.pathname,range:req.headers.range||null});const file=path.join(root,path.basename(url.pathname));
        if(!fs.existsSync(file)){res.writeHead(404).end();return;}
        const body=fs.readFileSync(file),ext=path.extname(file);res.setHeader('content-type',({'.mp4':'video/mp4','.wav':'audio/wav','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t'})[ext]);res.setHeader('accept-ranges','bytes');
        const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        if(range){const start=+range[1],end=range[2]?Math.min(+range[2],body.length-1):body.length-1;res.writeHead(206,{'content-range':`bytes ${start}-${end}/${body.length}`,'content-length':end-start+1});res.end(body.subarray(start,end+1));}
        else{res.setHeader('content-length',body.length);res.end(body);}return;
      }
      if(url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname.includes('suggest')||url.pathname.includes('recordings')||url.pathname.includes('playlists')||url.pathname==='/api/state'?[]:url.pathname.includes('coverage')?{byCountry:[],altNamesAvailable:true}:url.pathname.includes('sidecar')?{configured:false}:{}));return;}
      res.setHeader('content-type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/style.css"><div id="app"></div><script src="/bundle.js"></script>');
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN||undefined,headless:true,args:['--no-sandbox','--disable-background-networking','--autoplay-policy=no-user-gesture-required']});
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.addInitScript(()=>{window.playbackStats={attach:0,detach:0,pip:'not attempted'};const pip=HTMLVideoElement.prototype.requestPictureInPicture;if(pip)HTMLVideoElement.prototype.requestPictureInPicture=function(){return pip.call(this).then(result=>{window.playbackStats.pip='entered';return result},err=>{window.playbackStats.pip=err.name+': '+err.message;throw err})};});
    page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
    const navigate=async view=>{await page.evaluate(view=>window.store.getState().setView(view),view);await pause(80);if(view==='live'){await page.evaluate(()=>window.store.getState().setSelectedCountry(''));}await pause(120);};
    const play=async id=>{await page.evaluate(id=>window.store.getState().playChannel(window.fixtureChannels.find(c=>c.id===id)),id);await page.waitForFunction(()=>{const m=document.querySelector('video,audio');return m?.readyState>=2&&!m.paused;});};
    await pause(250);assert.equal(await page.locator('audio,video').count(),0,'Visiting Radio does not select/play a default');assert.equal(await page.evaluate(()=>window.playbackStats.attach),0);
    await navigate('live');await play('tv');
    await page.evaluate(()=>{const m=document.querySelector('video');window.originalMedia=m;m.pause();m.volume=.37;m.muted=true;m.currentTime=3;});await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-3)<.2);
    if(evidence)await page.screenshot({path:path.join(evidence,'tv-full-desktop.png')});
    const count=await page.evaluate(()=>window.playbackStats.attach),network=requests.length;
    for(const view of ['settings','home','live','radio','live']){
      await navigate(view);
      const state=await page.evaluate(()=>{const m=document.querySelector('video');return {same:m===window.originalMedia,time:m.currentTime,paused:m.paused,volume:m.volume,muted:m.muted,attach:window.playbackStats.attach,audio:document.querySelectorAll('audio').length}});
      if(evidence&&view==='settings')await page.screenshot({path:path.join(evidence,'tv-mini-settings.png')});
      assert.equal(state.same,true);assert.ok(Math.abs(state.time-3)<.2);assert.equal(state.paused,true);assert.equal(state.volume,.37);assert.equal(state.muted,true);assert.equal(state.attach,count);assert.equal(state.audio,0);assert.equal(await page.evaluate(()=>navigator.mediaSession.playbackState),'paused');
    }
    assert.equal(requests.length,network,'Paused navigation opens no new media requests');
    await page.evaluate(()=>{window.store.setState({currentChannel:{...window.store.getState().currentChannel,name:'Renamed TV'}})});await pause(100);assert.equal(await page.evaluate(()=>window.playbackStats.attach),count,'Metadata replacement does not reconnect');
    await navigate('settings');
    const floating=page.locator('[data-playback-owner]');const beforeBox=await floating.boundingBox();
    await page.mouse.move(beforeBox.x+80,beforeBox.y+15);await page.mouse.down();await page.mouse.move(beforeBox.x+35,beforeBox.y-15,{steps:6});await page.mouse.up();
    const moved=await floating.boundingBox();assert.ok(moved.x<beforeBox.x-30);assert.ok(moved.y<beforeBox.y-20);
    const grip=await floating.locator('[aria-label="Resize"]').last().boundingBox();await page.mouse.move(grip.x+10,grip.y+10);await page.mouse.down();await page.mouse.move(grip.x+40,grip.y+26,{steps:6});await page.mouse.up();
    assert.ok((await floating.boundingBox()).width>moved.width+20);assert.equal(await page.evaluate(()=>document.querySelector('video')===window.originalMedia),true);
    await navigate('live');
    console.log('PASS floating drag/resize keeps the same video');
    console.log('PASS TV element/paused position/volume/mute and connection survive Live→Settings→Home→Live and Radio browsing');
    // Try real browser PiP where available. Never emulate the PiP API.
    await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('video').paused);
    if(await page.evaluate(()=>document.pictureInPictureEnabled)){
      await page.getByTitle('Picture in Picture',{exact:true}).click();await pause(200);
      if(await page.evaluate(()=>!!document.pictureInPictureElement)){
        await navigate('settings');assert.equal(await page.evaluate(()=>document.pictureInPictureElement===window.originalMedia),true);await navigate('home');await navigate('live');assert.equal(await page.evaluate(()=>document.pictureInPictureElement===window.originalMedia),true);await page.evaluate(()=>document.exitPictureInPicture());console.log('PASS native Chrome PiP keeps the same video across navigation');
      }else console.log('LIMIT native PiP: '+await page.evaluate(()=>window.playbackStats.pip));
    }else console.log('LIMIT native PiP unavailable in this browser');
    await page.getByTitle('Fullscreen (f)',{exact:true}).click();assert.equal(await page.evaluate(()=>!!document.fullscreenElement),true);await navigate('settings');assert.equal(await page.evaluate(()=>document.fullscreenElement?.contains(window.originalMedia)),true);await page.evaluate(()=>document.exitFullscreen());await navigate('live');
    await page.getByRole('button',{name:'Next',exact:true}).click();await page.waitForFunction(()=>window.store.getState().currentChannel?.id==='hls'&&document.querySelector('video')?.readyState>=2);await page.getByRole('button',{name:'Quality',exact:true}).waitFor();await page.getByRole('button',{name:'Quality',exact:true}).click();await page.getByRole('button',{name:'180p',exact:true}).click();
    const hls=await page.evaluate(()=>{window.originalHls=window.playbackStats.options.hlsRef.current;return window.playbackStats.attach});
    for(const view of ['home','settings','live'])await navigate(view);
    assert.equal(await page.evaluate(()=>window.originalHls===window.playbackStats.options.hlsRef.current),true);assert.equal(await page.evaluate(()=>window.playbackStats.attach),hls);assert.match(await page.getByRole('button',{name:'Quality',exact:true}).innerText(),/180p/);
    console.log('PASS fullscreen and HLS instance/quality survive navigation');
    await navigate('radio');await page.getByRole('button',{name:'Play Synthetic Radio',exact:true}).click();await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=2&&!document.querySelector('audio').paused);
    await page.evaluate(()=>{const m=document.querySelector('audio');window.originalAudio=m;m.pause();m.currentTime=2;});await pause(100);
    const radioCount=await page.evaluate(()=>window.playbackStats.attach);
    for(const view of ['settings','home','live','radio']){await navigate(view);assert.equal(await page.evaluate(()=>document.querySelector('audio')===window.originalAudio),true);assert.equal(await page.evaluate(()=>document.querySelector('audio').paused),true);assert.equal(await page.evaluate(()=>document.querySelector('audio').volume),.37);assert.equal(await page.evaluate(()=>document.querySelector('audio').muted),true);assert.ok(Math.abs(await page.evaluate(()=>document.querySelector('audio').currentTime)-2)<.2);assert.equal(await page.evaluate(()=>window.playbackStats.attach),radioCount);assert.equal(await page.locator('video').count(),0);}
    await page.setViewportSize({width:390,height:844});await pause(200);
    await navigate('live');assert.equal(await page.locator('[data-playback-owner]').getAttribute('data-playback-mode'),'mini');assert.equal(await page.evaluate(()=>document.querySelector('audio')===window.originalAudio),true);await page.getByRole('button',{name:'Unmute',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('audio').muted),false);await page.getByRole('button',{name:'Mute',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('audio').muted),true);if(evidence)await page.screenshot({path:path.join(evidence,'radio-mini-live-mobile.png')});await navigate('radio');
    await page.locator('[data-playback-slot=radio]').scrollIntoViewIfNeeded();await pause(150);
    const playerBox=await page.locator('[data-playback-owner]').boundingBox(),slotBox=await page.locator('[data-playback-slot=radio]').boundingBox();assert.ok(Math.abs(playerBox.y-slotBox.y)<2);assert.ok(Math.abs(playerBox.width-slotBox.width)<2);
    if(evidence)await page.screenshot({path:path.join(evidence,'radio-full-mobile.png')});
    assert.equal(await page.evaluate(()=>document.querySelector('audio')===window.originalAudio),true);
    await page.getByRole('button',{name:'Stop',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio,video'));assert.equal(await page.evaluate(()=>window.originalAudio.paused&& !window.originalAudio.getAttribute('src')),true);assert.equal(await page.evaluate(()=>window.playbackStats.attach-window.playbackStats.detach),0);
    await navigate('radio');assert.equal(await page.locator('audio,video').count(),0,'Stopped Radio does not auto-restart');
    console.log('PASS explicit radio selection shares one session; paused radio survives navigation; Stop releases it and stays stopped');
    await navigate('live');await play('tv');if(evidence)await page.screenshot({path:path.join(evidence,'tv-full-mobile.png')});await page.evaluate(()=>window.store.getState().logout());await page.waitForFunction(()=>!document.querySelector('audio,video'));assert.equal(await page.evaluate(()=>navigator.mediaSession?.playbackState||'none'),'none');
    assert.deepEqual(errors,[]);console.log('PASS logout releases playback and Media Session; no browser page errors');
    await context.close();
  }finally{
    if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'playback-requests.json'),JSON.stringify(requests,null,2));fs.writeFileSync(path.join(evidence,'playback-errors.json'),JSON.stringify(errors));if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'playback-final.png')}).catch(()=>{});}
    await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
