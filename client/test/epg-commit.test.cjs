const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
const source = process.env.AUD015_STORE_SOURCE || path.join(client, 'src/store/useStore.js');
const bundle = buildSync({ stdin: { contents: fs.readFileSync(source, 'utf8'), resolveDir: path.join(client, 'src/store') }, bundle: true, write: false, format: 'cjs', platform: 'node', alias: { '@shared': path.resolve(client, '../shared') } }).outputFiles[0].text;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const A = 'https://guide.example/a.xml', B = 'https://guide.example/b.xml';
const guide = (id, revision) => ({ channels: { [id]: { name: id } }, programmes: {}, sourceCount: 1, sourceRevision: revision });
function fixture() {
  const data = {}; const calls = [], timers = new Map(); let id = 0;
  const storage = { getItem: k => data[k] || null, setItem: (k, v) => data[k] = v, removeItem: k => delete data[k] };
  let reply = url => url.includes('/merged') ? guide('A', 'rev-a') : {};
  const context = { module: { exports: {} }, exports: {}, require, process: { env: { NODE_ENV: 'production' } }, console, Response, AbortController, URL, URLSearchParams,
    localStorage: storage, sessionStorage: storage, window: { addEventListener() {} },
    setTimeout: (fn, ms) => { const n = ++id; timers.set(n, { fn, ms }); return n; }, clearTimeout: n => timers.delete(n),
    fetch: async (url, options) => { calls.push({ url, options }); const value = await reply(url, options); return value instanceof Response ? value : new Response(JSON.stringify(value)); } };
  vm.runInNewContext(bundle, context);
  const store = context.module.exports.useStore;
  store.setState({ auth: { checked: true, required: false, authed: true }, settings: { epgUrls: [A] }, epgSourceRevision: 'rev-a' });
  return { store, calls, timers, reply: fn => reply = fn };
}
test('source save is immediate and acknowledged before guide reads or settings publication', async () => {
  const f = fixture(), ack = deferred();
  f.reply(url => url === '/api/state/settings' ? ack.promise : url.includes('/merged') ? guide('B', 'rev-b') : {});
  const saving = f.store.getState().applySettings({ epgUrls: [B] }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/state/settings');
  assert.deepEqual([...f.store.getState().settings.epgUrls], [A]);
  assert.equal(f.store.getState().settingsSaving, true);
  const concurrent = f.store.getState().loadEpg(); await tick(); assert.equal(f.calls.length, 1);
  ack.resolve({ value: { epgUrls: [B] }, updatedAt: '2026-11-05T00:00:00Z', epgSourceRevision: 'rev-b' });
  await Promise.all([saving, concurrent]);
  assert.equal(f.calls.filter(c => c.url.includes('/merged')).length, 1);
  assert.match(f.calls.find(c => c.url.includes('/merged')).url, /sourceRevision=rev-b/);
  assert.ok(f.store.getState().epg.channels.B); assert.equal(f.store.getState().settingsSaving, false);
});
test('failed save retains confirmed settings and exposes retryable error without dependent reads', async () => {
  const f = fixture(); f.reply(() => new Response('{"error":"disk unavailable"}', { status: 503 }));
  await assert.rejects(f.store.getState().applySettings({ epgUrls: [B] }), /disk unavailable/);
  assert.deepEqual([...f.store.getState().settings.epgUrls], [A]);
  assert.equal(f.calls.length, 1); assert.match(f.store.getState().settingsError, /Retry Save/);
  assert.equal(f.store.getState().settingsSaving, false);
});
test('late A response cannot publish during or after a save of B', async () => {
  const f = fixture(), old = deferred(), ack = deferred();
  f.reply(url => url === '/api/state/settings' ? ack.promise : url.includes('sourceRevision=rev-a') ? old.promise : url.includes('/merged') ? guide('B', 'rev-b') : {});
  const loading = f.store.getState().loadEpg(); await tick();
  const saving = f.store.getState().applySettings({ epgUrls: [B] }); await tick();
  old.resolve(guide('A', 'rev-a')); await loading; assert.equal(f.store.getState().epg, null);
  ack.resolve({ value: { epgUrls: [B] }, epgSourceRevision: 'rev-b' }); await saving;
  assert.ok(f.store.getState().epg.channels.B);
});
test('concurrent guide loads share one request and revision mismatch is rejected', async () => {
  const f = fixture(), result = deferred(); f.reply(url => url.includes('/merged') ? result.promise : {});
  const a = f.store.getState().loadEpg(), b = f.store.getState().loadEpg(); await tick();
  assert.equal(f.calls.length, 1); result.resolve(guide('wrong', 'rev-b')); await Promise.all([a, b]);
  assert.equal(f.store.getState().epg, null); assert.match(f.store.getState().epgError, /sources changed/);
});
test('ordinary server/network failures do not fan out; a missing legacy endpoint does', async () => {
  for (const status of [401, 429, 502, 0, 404]) {
    const f = fixture(); f.reply(url => {
      if (url.includes('/merged')) { if (!status) throw new Error('offline'); return new Response('{}', { status }); }
      return url.startsWith('/api/epg?') ? guide('legacy') : {};
    });
    await f.store.getState().loadEpg();
    assert.equal(f.calls.filter(c => c.url.startsWith('/api/epg?')).length, status === 404 ? 1 : 0);
    if (status === 404) assert.ok(f.store.getState().epg.channels.legacy);
    else assert.match(f.store.getState().epgError, /EPG load failed/);
  }
});
test('cross-device committed source revision loads B once and ignores its echo', async () => {
  const f = fixture(); f.reply(url => url === '/api/state' ? [{ key: 'settings', value: { epgUrls: [B] }, updatedAt: '2026-11-05T00:01:00Z', epgSourceRevision: 'rev-b' }] : url.includes('/merged') ? guide('B', 'rev-b') : {});
  await f.store.getState()._syncState(); await f.store.getState().loadEpg();
  assert.ok(f.store.getState().epg.channels.B);
  const count = f.calls.filter(c => c.url.includes('/merged')).length;
  await f.store.getState()._syncState(); await tick();
  assert.equal(f.calls.filter(c => c.url.includes('/merged')).length, count);
});
test('rapid settings patches serialize and retain prior acknowledged fields', async () => {
  const f = fixture(), first = deferred(); let saves = 0;
  f.reply((url, options) => url === '/api/state/settings' ? (++saves === 1 ? first.promise : { value: JSON.parse(options.body).value, epgSourceRevision: 'rev-a' }) : {});
  const one = f.store.getState().applySettings({ defaultCountry: 'ro' });
  const two = f.store.getState().applySettings({ epgView: 'grid' }); await tick(); assert.equal(saves, 1);
  first.resolve({ value: { epgUrls: [A], defaultCountry: 'ro' }, epgSourceRevision: 'rev-a' });
  await Promise.all([one, two]); assert.equal(saves, 2);
  assert.equal(f.store.getState().settings.defaultCountry, 'ro'); assert.equal(f.store.getState().settings.epgView, 'grid');
});
test('manual links remain unmodified until durable acknowledgement', async () => {
  const f = fixture(), ack = deferred(); f.reply(() => ack.promise);
  const saving = f.store.getState().applySettings({ epgOverrides: { channel: 'guide' } }); await tick();
  assert.equal(f.store.getState().settings.epgOverrides, undefined);
  ack.resolve({ value: { epgUrls: [A], epgOverrides: { channel: 'guide' } }, epgSourceRevision: 'rev-a' }); await saving;
  assert.equal(f.store.getState().settings.epgOverrides.channel, 'guide'); assert.equal(f.calls.length, 1);
});
test('saving unchanged sources/preferences does not invalidate a pending guide load', async () => {
  const f = fixture(), response = deferred();
  f.reply((url, options) => url.includes('/merged') ? response.promise : url === '/api/state/settings' ? { value: JSON.parse(options.body).value, epgSourceRevision: 'rev-a' } : {});
  const loading = f.store.getState().loadEpg(); await tick();
  await f.store.getState().applySettings({ epgUrls: [A], defaultCountry: 'ro' });
  response.resolve(guide('A', 'rev-a')); await loading;
  assert.ok(f.store.getState().epg.channels.A); assert.equal(f.calls.filter(c => c.url.includes('/merged')).length, 1);
});
test('pre-sync local guide sources are committed before their first guide load', async () => {
  const f = fixture(); f.store.setState({ epgSourceRevision: null });
  f.reply((url, options) => url === '/api/state' ? [] : url === '/api/state/settings' ? { value: JSON.parse(options.body).value, epgSourceRevision: 'rev-a' } : url.includes('/merged') ? guide('A', 'rev-a') : {});
  await f.store.getState()._syncState();
  assert.equal(f.calls[0].url, '/api/state'); assert.equal(f.calls[1].url, '/api/state/settings'); assert.match(f.calls[2].url, /\/merged/);
  assert.ok(f.store.getState().epg.channels.A);
});
