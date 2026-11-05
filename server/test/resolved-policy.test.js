import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import { PassThrough } from 'node:stream';
import { createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
process.env.PROXY_BLOCK_PRIVATE = '1';
process.env.PROXY_ALLOWED_CIDRS = '127.0.0.1/32';
const { guardedFetch } = await import(process.env.AUD005_HTTP_MODULE || '../lib/http.js');
const { relayRecording } = await import('../lib/recording-input.js');
const lookup = dns.lookup;
dns.lookup = async (name) => {
  if (name === 'private.fixture.test') return [{address:'10.2.3.4',family:4}];
  if (name === 'mixed.fixture.test') return [{address:'8.8.8.8',family:4},{address:'10.2.3.4',family:4}];
  if (['tls.fixture.test','wrong.fixture.test'].includes(name)) return [{address:'127.0.0.1',family:4}];
  if (name === 'lan.fixture.test') return [{address:'127.0.0.1',family:4}];
  if (name.startsWith('fc') || name.startsWith('fd')) return [{address:'8.8.8.8',family:4}];
  throw new Error('Unexpected DNS lookup: '+name);
};
test.after(()=>{dns.lookup=lookup});
const key = Buffer.alloc(16, 7);
const iv = Buffer.alloc(16); iv.writeBigUInt64BE(1n,8);
const cipher=createCipheriv('aes-128-cbc',key,iv);
const encrypted=Buffer.concat([cipher.update(Buffer.from('segment')),cipher.final()]);
const hits=[];
const origin=http.createServer((req,res)=>{
  hits.push(req.url);
  if(req.url==='/gzip'){res.setHeader('content-encoding','gzip');res.end(gzipSync('compressed fixture'));return;}
  if(req.url==='/redirect'){res.writeHead(302,{location:'http://private.fixture.test/secret'});res.end();return;}
  if(req.url==='/master'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia\n');return;}
  if(req.url==='/media'){res.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\nsegment\n#EXT-X-ENDLIST\n');return;}
  if(req.url==='/key'){res.end(key);return;}
  if(req.url==='/segment'){res.end(encrypted);return;}
  if(req.url.startsWith('/bad-')){
    const part=req.url.slice(5);
    res.setHeader('content-type','application/vnd.apple.mpegurl');
    const bad='http://private.fixture.test/secret';
    res.end('#EXTM3U\n'+(part==='key'?`#EXT-X-KEY:METHOD=AES-128,URI="${bad}"\n`:'')+(part==='map'?`#EXT-X-MAP:URI="${bad}"\n`:'')+'#EXTINF:1,\n'+(part==='segment'?bad:'segment')+'\n#EXT-X-ENDLIST\n');return;
  }
  assert.equal(req.headers['user-agent'],'Fixture-UA');
  assert.equal(req.headers.referer,'http://fixture.invalid/');
  res.end('direct-media');
});
await new Promise(r=>origin.listen(0,'127.0.0.1',r));
const base=`http://lan.fixture.test:${origin.address().port}`;
test.after(()=>{origin.closeAllConnections();origin.close()});
const headers={'User-Agent':'Fixture-UA',Referer:'http://fixture.invalid/'};
test('DNS private/mixed results reject before connecting and allowed LAN works',async()=>{
  await assert.rejects(guardedFetch('http://private.fixture.test/x'),/private-network/);
  await assert.rejects(guardedFetch('http://mixed.fixture.test/x'),/private-network/);
  assert.equal(await (await guardedFetch(base+'/direct',{headers})).text(),'direct-media');
  await assert.rejects(guardedFetch(base+'/redirect',{headers}),/private-network/);
});
test('public fc/fd names keep hostname and use only the checked address at connect time',async()=>{
  const request=http.request;
  let resolutions=0;
  const previous=dns.lookup;
  dns.lookup=async(...args)=>{resolutions++;return previous(...args)};
  http.request=(url,options)=>{
    assert.match(url.hostname,/^(fc|fd)/);
    assert.equal(options.agent,false);
    options.lookup(url.hostname,{all:false},(error,address,family)=>{
      assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);
    });
    throw new Error('pinned transport observed');
  };
  try {
    for(const name of ['fchannel.example','fdomain.example']) await assert.rejects(guardedFetch('http://'+name),/pinned transport/);
    assert.equal(resolutions,2);
  } finally {http.request=request;dns.lookup=previous;}
});
async function relay(target){
  const output=new PassThrough();const chunks=[];output.on('data',c=>chunks.push(c));
  await relayRecording(target,output,{headers,signal:new AbortController().signal});
  return Buffer.concat(chunks).toString();
}
test('strict relay handles direct input, master playlist, relative key and encrypted segment',async()=>{
  assert.equal(await relay(base+'/direct'),'direct-media');
  assert.equal(await relay(base+'/master'),'segment');
});
for(const type of ['key','map','segment']) test('strict relay refuses private '+type+' before connecting',async()=>{
  await assert.rejects(relay(base+'/bad-'+type),/private-network/);
  assert.equal(hits.includes('/secret'),false);
});


test('a DNS change after validation cannot trigger another resolver call',async()=>{
  const previous=dns.lookup;
  let calls=0;
  dns.lookup=async(name,options)=>{
    if(name==='lan.fixture.test') { calls++; return [{address:calls===1?'127.0.0.1':'10.2.3.4',family:4}]; }
    return previous(name,options);
  };
  try {assert.equal(await (await guardedFetch(base+'/direct',{headers})).text(),'direct-media');assert.equal(calls,1);}
  finally {dns.lookup=previous;}
});


test('resolved private target never reaches a transport',async()=>{
  const original=globalThis.fetch;
  let attempted=0;
  globalThis.fetch=async()=>{attempted++;return new Response('synthetic private fixture')};
  try {
    await assert.rejects(guardedFetch('http://private.fixture.test/secret'),/private-network/);
    assert.equal(attempted,0);
  } finally {globalThis.fetch=original;}
});


test('pinned HTTPS preserves SNI and certificate hostname verification',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ro-iptv-policy-tls-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const certFile=path.join(root,'cert.pem'), keyFile=path.join(root,'key.pem');
  const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=tls.fixture.test','-addext','subjectAltName=DNS:tls.fixture.test','-keyout',keyFile,'-out',certFile,'-days','1'],{encoding:'utf8',timeout:10000});
  assert.ifError(generated.error);assert.equal(generated.status,0,generated.stderr);
  const cert=await fs.readFile(certFile);
  const server=https.createServer({key:await fs.readFile(keyFile),cert},(req,res)=>{
    assert.equal(req.socket.servername,'tls.fixture.test');
    assert.match(req.headers.host,/^tls.fixture.test:/);res.end('TLS fixture');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close()});
  const request=https.request;
  https.request=(url,options,...args)=>request(url,{...options,ca:cert},...args);
  try {
    const port=server.address().port;
    assert.equal(await (await guardedFetch(`https://tls.fixture.test:${port}/`)).text(),'TLS fixture');
    await assert.rejects(guardedFetch(`https://wrong.fixture.test:${port}/`),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  } finally {https.request=request;}
});


test('pinned transport decodes HTTP gzip while preserving Fetch response behavior',async()=>{
  const response=await guardedFetch(base+'/gzip',{headers});
  assert.equal(response.headers.get('content-encoding'),null);
  assert.equal(await response.text(),'compressed fixture');
});


test('HEAD with gzip headers has no decompressor/body and keeps transport healthy',async()=>{
  const response=await guardedFetch(base+'/gzip',{headers,method:'HEAD'});
  assert.equal(response.status,200);assert.equal(response.body,null);
  assert.equal(await response.text(),'');
  assert.equal(await (await guardedFetch(base+'/direct',{headers})).text(),'direct-media');
});
