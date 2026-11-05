import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sourceId } from '../lib/redact.js';
const secret = 'synthetic-provider-private-marker';
function containsSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [secret,encodeURIComponent(secret),Buffer.from('fixture-user:'+secret).toString('base64')].some((v)=>text.includes(v));
}
test('source/startup/API diagnostics omit raw, encoded and path credentials', { timeout:15000 }, async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-diagnostics-'));
  const provider=http.createServer((req,res)=>{
    res.writeHead(500,{'content-type':'text/plain'});res.end('provider body '+secret);
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(()=>{provider.closeAllConnections();provider.close()});
  const url=`http://fixture-user:${secret}@127.0.0.1:${provider.address().port}/live/${secret}?token=${secret}&nested=${encodeURIComponent('http://fixture.invalid/'+secret)}`;
  const blocked=`http://10.2.3.4/${secret}?token=${secret}`;
  const hook=path.join(root,'port.mjs');
  await fs.writeFile(hook,`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`);
  const entry=process.env.AUD009_SERVER_ENTRY || new URL('../index.js',import.meta.url).pathname;
  const storeUrl=pathToFileURL(path.join(path.dirname(entry),'lib/epgstore.js')).href;
  const child=spawn(process.execPath,['--import',pathToFileURL(hook).href,'--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(entry).href)});const m=await import(${JSON.stringify(storeUrl)});await m.refreshAll();`],{
    env:{...process.env,DATA_DIR:root,PORT:'0',AUTH_PASSWORD:'',AUTH_SESSION_SECRET:'',EPG_URL:blocked,EPG_SIDECAR_URL:url,EPG_SIDECAR_ENABLED:'1',M3U_URL:'',REFRESH_INTERVAL_MINUTES:'0',RATE_LIMIT_DISABLED:'1',PROXY_BLOCK_PRIVATE:'1',PROXY_ALLOWED_CIDRS:'127.0.0.1/32'},stdio:['ignore','pipe','pipe'],
  });
  let logs='';child.stdout.on('data',d=>{logs+=d});child.stderr.on('data',d=>{logs+=d});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}await fs.rm(root,{recursive:true,force:true})});
  for(let i=0;i<300&&!logs.includes('TEST_PORT=');i++)await new Promise(r=>setTimeout(r,10));
  const port=logs.match(/TEST_PORT=(\d+)/)?.[1];assert.ok(port,'API did not listen');
  const base='http://127.0.0.1:'+port;
  let health;
  for(let i=0;i<100;i++){
    health=await (await fetch(base+'/api/epg/health')).json();if(health.length===2)break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(containsSecret(logs),false,'Startup/guide logs contain credentials');
  assert.equal(health.length,2);assert.equal(containsSecret(health),false,'Health contains credentials');
  assert.ok(health.some(h=>h.sourceId===sourceId(url)));assert.ok(health.some(h=>h.error==='upstream 500'));
  const diagnosticReplies=[];
  for(const route of ['/api/playlist','/api/epg','/api/nowplaying','/api/proxy']){
    const reply=await fetch(base+route+'?url='+encodeURIComponent(url));
    diagnosticReplies.push(await reply.text());
  }
  diagnosticReplies.push(await (await fetch(base+'/api/epg/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})})).text());
  diagnosticReplies.push(await (await fetch(base+'/api/epg/merged')).text());
  diagnosticReplies.push(await (await fetch(base+'/api/epg/sidecar')).text());
  const malformed=await fetch(base+'/api/state/settings?url='+encodeURIComponent(encodeURIComponent(url)),{method:'PUT',headers:{'content-type':'application/json',cookie:'session='+secret},body:'{"value":"'+secret+'",'});
  assert.equal(malformed.status,500);diagnosticReplies.push(await malformed.text());
  assert.equal(containsSecret(diagnosticReplies),false,'Diagnostic response contains credentials');
  const stored=JSON.parse(await fs.readFile(path.join(root,'epg-health.json'),'utf8'));
  assert.equal(containsSecret(stored),false,'New health persistence contains credentials');
  assert.equal(containsSecret(logs),false,'Diagnostic logs contain credentials');
  assert.ok(logs.includes(sourceId(url))&&logs.includes(sourceId(blocked)),'Missing useful correlation');
  assert.match(logs,/private-network|upstream 500/);
  // Provider URLs remain available only through the protected configuration contract.
  const config=await (await fetch(base+'/api/config')).json();assert.equal(config.epgUrl,blocked);
});
