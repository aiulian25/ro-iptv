// Real HLS filename/MIME/redirect regression through the guarded proxy.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-iptv-aud022-browser-'));
  let server, browser, page; const requests = [], errors = [], evidence = process.env.AUD022_LOG_DIR;
  try {
    const assets = path.join(process.env.AUD022_BUILD_DIR || path.join(client, 'dist'), 'assets');
    const css = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(name => name.endsWith('.css'))));
    process.env.PROXY_BLOCK_PRIVATE='1';process.env.PROXY_ALLOWED_CIDRS='127.0.0.1/32';process.env.EPG_SIDECAR_ENABLED='0';
    const {createStreamProxy}=await import(require('node:url').pathToFileURL(path.join(client,'../server/lib/proxy.js')));const proxy=createStreamProxy({headerTimeoutMs:1500,idleTimeoutMs:1500,manifestTimeoutMs:1500});
    const video = path.join(root, 'video.mp4'), radio = path.join(root, 'radio.wav');
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','45','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',video]);
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','45','-c:a','pcm_s16le','-y',radio]);
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',video,'-c','copy','-hls_time','4','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_filename',path.join(root,'part-%03d.ts'),'-y',path.join(root,'stream.m3u8')]);
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',radio,'-c:a','libmp3lame','-y',path.join(root,'audio.mp3')]);
    fs.writeFileSync(path.join(root,'master.m3u8'),'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nstream.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\nstream.m3u8\n');
    let origin,abortedStalls=0;const logs=[];
    const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App.jsx';import {useStore} from './src/store/useStore.js';const channels=[{id:'known',name:'Known HLS',kind:'live',path:'master.m3u8'},{id:'opaque',name:'Opaque HLS',kind:'live',path:'opaque?token=synthetic-private'},{id:'redirect',name:'Redirect HLS',kind:'live',path:'jump?token=synthetic-private'},{id:'generic',name:'Generic MIME HLS',kind:'live',path:'untyped'},{id:'fragment',name:'Fragment HLS',kind:'live',path:'master.m3u8?token=synthetic-private#fragment'},{id:'metadata',name:'Metadata HLS',kind:'live',path:'specified',mimeType:'application/vnd.apple.mpegurl'},{id:'misleading',name:'Misleading MP4',kind:'live',path:'fake.mp4'},{id:'native',name:'Progressive MP4',kind:'live',path:'video.mp4'},{id:'wrong-hls',name:'Wrong suffix MP4',kind:'live',path:'fake.m3u8'},{id:'mp3',name:'Progressive MP3',kind:'radio',path:'audio.mp3'},{id:'radiohls',name:'HLS Radio',kind:'radio',path:'opaque?token=synthetic-private'},{id:'stall',name:'Cancelled probe',kind:'live',path:'stall'},{id:'codec',name:'Unsupported codec',kind:'live',path:'unsupported'}].map(c=>({...c,url:location.origin+'/media/'+c.path,group:'Test',httpUserAgent:'FixtureAgent',httpReferrer:location.origin+'/' }));const auth={checked:true,required:false,authed:true,mustChange:false};useStore.setState({auth,channels,settings:{epgUrls:[],refreshIntervalMinutes:0},checkAuth:async()=>auth,init:async()=>{},restoreLastChannel:()=>{},retryPlaylistChanges:async()=>{},view:'radio',selectedCountry:''});window.store=useStore;window.fixtureChannels=channels;createRoot(document.getElementById('app')).render(<App/>);`, resolveDir: client, loader:'jsx' }, bundle:true, write:false, format:'iife', jsx:'automatic', alias:{'@shared':path.resolve(client,'../shared')}, define:{'process.env.NODE_ENV':'"production"'}, plugins:[{ name:'playback-evidence',setup(builder){
      builder.onLoad({filter:/\.(jsx|js)$/}, async args => {
        let file=args.path;
        if(process.env.AUD022_BEFORE_DIR){const candidate=path.join(process.env.AUD022_BEFORE_DIR,path.basename(file));if(fs.existsSync(candidate))file=candidate;}
        let contents=fs.readFileSync(file,'utf8');
        if(path.basename(args.path)==='playSource.js'){
          if(contents.includes('export async function probeStreamType(')){contents=contents.replace('export async function probeStreamType(', 'async function originalProbeStreamType(');contents+='\nexport async function probeStreamType(...args){window.playbackStats.probes++;return originalProbeStreamType(...args)}';}
          contents=contents.replace('export function attachStream(', 'function originalAttachStream(');
          contents+=`\nexport function attachStream(...args){window.playbackStats.attach++;const stop=originalAttachStream(...args);window.playbackStats.options=args[2];return()=>{window.playbackStats.detach++;stop()}}`;
        }
        return {contents,loader:args.path.endsWith('.jsx')?'jsx':'js',resolveDir:path.dirname(args.path)};
      });
    }}] });
    server=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/proxy'){const target=url.searchParams.get('url');if(!target||!target.startsWith(origin+'/media/')){res.writeHead(403).end('{}');return;}const ua=url.searchParams.get('ua')||'',ref=url.searchParams.get('ref')||'';proxy(req,res,{target,headers:{'User-Agent':ua,'Referer':ref,...(req.headers.range?{Range:req.headers.range}:{})},extra:'&ua='+encodeURIComponent(ua)+'&ref='+encodeURIComponent(ref)});return;}
      if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(bundle.outputFiles[0].text);return;}
      if(url.pathname.startsWith('/fonts/')){const file=path.join(client,'public',url.pathname);if(fs.existsSync(file)){res.setHeader('content-type','font/woff2');res.end(fs.readFileSync(file));}else res.writeHead(404).end();return;}
      if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(css);return;}
      if(url.pathname.startsWith('/media/')){
        requests.push({path:url.pathname,range:req.headers.range||null,userAgent:req.headers['user-agent']});
        if(url.pathname==='/media/jump'){res.writeHead(302,{location:'/media/master.m3u8?token=synthetic-private'}).end();return;}
        if(url.pathname==='/media/stall'){const timer=setTimeout(()=>res.end('#EXTM3U\n'),10000);res.on('close',()=>{clearTimeout(timer);abortedStalls++;});return;}
        if(url.pathname==='/media/unsupported'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="bogus"\nstream.m3u8\n');return;}
        const alias=({'/media/opaque':'master.m3u8','/media/untyped':'master.m3u8','/media/specified':'master.m3u8','/media/fake.mp4':'master.m3u8','/media/fake.m3u8':'video.mp4'})[url.pathname];const file=path.join(root,alias||path.basename(url.pathname));
        if(!fs.existsSync(file)){res.writeHead(404).end();return;}
        const body=fs.readFileSync(file),ext=path.extname(file);res.setHeader('content-type',({'.mp4':'video/mp4','.wav':'audio/wav','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.mp3':'audio/mpeg'})[ext]);if(['/media/untyped','/media/fake.mp4'].includes(url.pathname))res.setHeader('content-type','application/octet-stream');res.setHeader('accept-ranges','bytes');
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
    await context.addInitScript(()=>{window.playbackStats={attach:0,detach:0,probes:0,pip:'not attempted'};const pip=HTMLVideoElement.prototype.requestPictureInPicture;if(pip)HTMLVideoElement.prototype.requestPictureInPicture=function(){return pip.call(this).then(result=>{window.playbackStats.pip='entered';return result},err=>{window.playbackStats.pip=err.name+': '+err.message;throw err})};});
    page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('console',entry=>logs.push(entry.text()));await page.goto(origin);
    const navigate=async view=>{await page.evaluate(view=>window.store.getState().setView(view),view);await pause(80);if(view==='live'){await page.evaluate(()=>window.store.getState().setSelectedCountry(''));}await pause(120);};
    const play=async id=>{await page.evaluate(id=>window.store.getState().playChannel(window.fixtureChannels.find(c=>c.id===id)),id);await page.waitForFunction(()=>{const m=document.querySelector('video,audio');return m?.readyState>=2&&!m.paused;});};
    await navigate('live');
    for(const id of ['known','opaque','redirect','generic','fragment','metadata','misleading','native','wrong-hls','mp3','radiohls']){
      const before=await page.evaluate(()=>window.playbackStats.probes);
      await play(id);const result=await page.evaluate(()=>({hls:!!window.playbackStats.options.hlsRef.current,probes:window.playbackStats.probes,tag:document.querySelector('video,audio').tagName}));
      assert.equal(result.hls,!['native','wrong-hls','mp3'].includes(id),id);
      assert.equal(result.tag,['mp3','radiohls'].includes(id)?'AUDIO':'VIDEO',id);
      if(['metadata','native','mp3'].includes(id))assert.equal(result.probes,before,'Known metadata/native suffix avoids unnecessary probing');
      console.log('PASS '+id+': correct decoder plays real local media');
    }
    await page.evaluate(()=>window.store.getState().playChannel(window.fixtureChannels.find(c=>c.id==='stall')));
    for(let n=0;n<200&&!requests.some(r=>r.path==='/media/stall');n++)await pause(10);
    assert.ok(requests.some(r=>r.path==='/media/stall'));await page.evaluate(()=>window.store.getState().stopPlayback());
    for(let n=0;n<200&&!abortedStalls;n++)await pause(10);
    assert.ok(abortedStalls);assert.equal(await page.locator('audio,video').count(),0);console.log('PASS Stop cancels pending type probe and its upstream request');
    await page.evaluate(()=>window.store.getState().playChannel(window.fixtureChannels.find(c=>c.id==='codec')));
    await page.getByText('This stream uses an unsupported format or codec. Try another source.',{exact:true}).waitFor();
    const failures=requests.filter(r=>r.path==='/media/unsupported').length;await pause(500);assert.equal(requests.filter(r=>r.path==='/media/unsupported').length,failures);assert.ok(failures<=3);
    assert.ok(requests.every(request=>request.userAgent==='FixtureAgent'),'Proxy preserves provider header requirements on manifests/segments/media');assert.ok(!logs.join('\n').includes('synthetic-private'));assert.deepEqual(errors,[]);console.log('PASS unsupported codec is actionable and terminal; no token leaks or browser page errors');
    await page.evaluate(()=>window.store.getState().stopPlayback());
    await context.close();
  }finally{
    if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'playback-requests.json'),JSON.stringify(requests,null,2));fs.writeFileSync(path.join(evidence,'playback-errors.json'),JSON.stringify(errors));if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'playback-final.png')}).catch(()=>{});}
    await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
