const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = process.env.AUD021_PLAY_SOURCE || path.resolve(__dirname, '../src/lib/playSource.js');
const code = fs.readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '').replace(/export (async )?function /g, '$1function ');
function fixture(hls) {
  const instances = [], loaded = [], listeners = new Map(); let plays = 0, manifests = 0;
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level', FRAG_LOADED: 'fragment', ERROR: 'error' };
    static isSupported() { return hls; }
    constructor() { this.events = {}; instances.push(this); }
    loadSource(src) { loaded.push(src); } attachMedia() {} on(name, cb) { this.events[name] = cb; } destroy() { this.destroyed = true; }
  }
  const context = { Hls, sourceCandidates: () => ['direct', 'proxy'], memoDirect() {}, sessionGeneration: () => 1, URL, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout, proxied: () => 'probe', sessionFetch: async () => new Response('native body', {headers:{'content-type':'video/mp4'}}) };
  vm.runInNewContext(code, context);
  const media = { set src(src) { loaded.push(src); }, play() { plays++; return Promise.resolve(); }, canPlayType: () => '', addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) };
  const hlsRef = { current: null };
  const stop = context.attachStream(media, { url: 'direct', mimeType: hls ? 'application/vnd.apple.mpegurl' : 'video/mp4' }, { isHls: hls, hlsRef, onManifest: () => manifests++ });
  return { media, stop, instances, loaded, listeners, hlsRef, manifests: () => manifests, plays: () => plays };
}
test('native stop removes callbacks and late startup errors cannot reattach a source', () => {
  const f = fixture(false), late = f.media.onerror; assert.deepEqual(f.loaded, ['direct']);
  f.stop(); late(); assert.deepEqual(f.loaded, ['direct']); assert.equal(f.media.onerror, null); assert.equal(f.listeners.size, 0);
});
test('active native fallback still advances; callbacks captured before stopping stay inert', async () => {
  const f = fixture(false); await f.media.onerror(); assert.deepEqual(f.loaded, ['direct', 'proxy']);
  const late = f.media.onerror; f.stop(); late(); assert.deepEqual(f.loaded, ['direct', 'proxy']);
});
test('HLS stop destroys the instance; late manifest/error callbacks cannot play or attach again', () => {
  const f = fixture(true), instance = f.instances[0]; f.stop();
  instance.events.manifest(null, { levels: [] }); instance.events.error(null, { fatal: true });
  assert.equal(instance.destroyed, true); assert.equal(f.hlsRef.current, null); assert.equal(f.manifests(), 0); assert.equal(f.plays(), 0); assert.deepEqual(f.loaded, ['direct']);
});
