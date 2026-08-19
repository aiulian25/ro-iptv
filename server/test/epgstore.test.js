// Server-side EPG engine (server/lib/epgstore.js).
// DATA_DIR must be set before importing the store, which reads it at load time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-epg-'));
process.env.DATA_DIR = DATA_DIR;
delete process.env.EPG_URL;

const HOUR_MS = 3600_000;

// XMLTV stamps: 20240115203000 +0000
function xmltvStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  );
}

// A guide with one programme far in the past (Catchup territory) and one now.
function guideXml(channelId, channelName) {
  const now = Date.now();
  const programme = (offsetHours, title) =>
    `<programme channel="${channelId}" start="${xmltvStamp(new Date(now + offsetHours * HOUR_MS))}" ` +
    `stop="${xmltvStamp(new Date(now + (offsetHours + 1) * HOUR_MS))}"><title>${title}</title></programme>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><tv>` +
    `<channel id="${channelId}"><display-name>${channelName}</display-name>` +
    `<icon src="http://logo/${channelId}.png" /></channel>` +
    programme(-72, 'Three Days Ago') +
    programme(-24, 'Yesterday') +
    programme(0, 'On Now') +
    `</tv>`
  );
}

// Local upstream serving two guides (one gzipped) and counting hits per path.
const hits = {};
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/plain.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(guideXml('one.ro', 'Channel One'));
  }
  if (req.url === '/gzipped.xml.gz') {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    return res.end(zlib.gzipSync(Buffer.from(guideXml('two.ro', 'Channel Two'))));
  }
  res.writeHead(500);
  res.end('boom');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const PLAIN_URL = `${ORIGIN}/plain.xml`;
const GZIP_URL = `${ORIGIN}/gzipped.xml.gz`;
const DEAD_URL = `${ORIGIN}/dead.xml`;
const PERSIST_FAIL_PATH = '/persist-fail.xml';
const PERSIST_FAIL_URL = `${ORIGIN}${PERSIST_FAIL_PATH}`;

// Mirrors the on-disk naming in lib/epgstore.js.
function guideBasename(url) {
  return `guide-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.json.gz`;
}

async function writeSettings(epgUrls) {
  await fs.writeFile(
    path.join(DATA_DIR, 'state.json'),
    JSON.stringify([{ key: 'settings', value: { epgUrls }, updatedAt: new Date().toISOString() }]),
    'utf8'
  );
}

const { configuredEpgUrls, mergeGuides, refreshSource, loadSource, getMergedGuide, refreshAll, readSourceHealth } =
  await import('../lib/epgstore.js');

test('a rejected refresh still drains its queued follow-up', async () => {
  await writeSettings([PLAIN_URL]);
  // Force runRefreshAll to reject by making the health collection unwritable.
  const healthPath = path.join(DATA_DIR, 'epg-health.json');
  await fs.rm(healthPath, { force: true });
  await fs.mkdir(healthPath); // writeCollection's rename onto a directory fails

  const first = refreshAll();
  const queued = refreshAll(); // lands while the first is in flight
  await assert.rejects(() => first);
  await queued.catch(() => {});

  await fs.rm(healthPath, { recursive: true, force: true });
  // If refreshQueued were stuck true, this run would spuriously chain a second one.
  const health = await refreshAll();
  assert.equal(health[0].url, PLAIN_URL);
  assert.equal(health[0].ok, true);
});

test.after(() => server.close());

test('configuredEpgUrls reads the synced settings blob, the legacy field and the env', async () => {
  await fs.writeFile(
    path.join(DATA_DIR, 'state.json'),
    JSON.stringify([
      { key: 'settings', value: { epgUrls: ['  https://a.example/g.xml  ', 'https://a.example/g.xml'], epgUrl: 'https://legacy.example/g.xml' } },
    ]),
    'utf8'
  );
  process.env.EPG_URL = 'https://env.example/g.xml';

  const urls = await configuredEpgUrls();

  assert.deepEqual(urls, ['https://a.example/g.xml', 'https://legacy.example/g.xml', 'https://env.example/g.xml']);
  delete process.env.EPG_URL;
});

test('mergeGuides unions channels and sorts each channel programmes by start', () => {
  const merged = mergeGuides([
    { channels: { a: { name: 'A' } }, programmes: { a: [{ start: '2026-01-01T10:00:00.000Z', title: 'Later' }] } },
    { channels: { b: { name: 'B' } }, programmes: { a: [{ start: '2026-01-01T08:00:00.000Z', title: 'Earlier' }] } },
  ]);

  assert.deepEqual(Object.keys(merged.channels).sort(), ['a', 'b']);
  assert.deepEqual(
    merged.programmes.a.map((p) => p.title),
    ['Earlier', 'Later']
  );
});

test('a source is fetched, parsed, persisted and then served without refetching', async () => {
  const before = hits['/plain.xml'] || 0;

  const refreshed = await refreshSource(PLAIN_URL);
  assert.equal(Object.keys(refreshed.guide.channels).length, 1);
  assert.equal(hits['/plain.xml'], before + 1);

  const files = (await fs.readdir(path.join(DATA_DIR, 'epg'))).filter((n) => n.endsWith('.json.gz'));
  assert.ok(files.length >= 1, 'the guide is persisted gzipped');

  const loaded = await loadSource(PLAIN_URL);
  assert.equal(loaded.guide.channels['one.ro'].name, 'Channel One');
  assert.equal(hits['/plain.xml'], before + 1, 'a load never touches the network');
});

test('a persisted guide survives a cold cache (new module instance reads it from disk)', async () => {
  const before = hits['/plain.xml'];
  const fresh = await import(`../lib/epgstore.js?cold=${Date.now()}`);

  const loaded = await fresh.loadSource(PLAIN_URL);

  assert.ok(loaded, 'read back from the data volume with an empty memory cache');
  assert.equal(loaded.guide.channels['one.ro'].name, 'Channel One');
  assert.equal(hits['/plain.xml'], before, 'still no upstream fetch');
});

test('gzipped guides are decompressed and merged with plain ones', async () => {
  await writeSettings([PLAIN_URL, GZIP_URL]);

  const merged = await getMergedGuide();

  assert.deepEqual(Object.keys(merged.channels).sort(), ['one.ro', 'two.ro']);
  assert.equal(merged.programmes['two.ro'].length, 3);
});

test('the merged guide keeps programmes far older than the legacy 3h lookback', async () => {
  await writeSettings([PLAIN_URL]);

  const merged = await getMergedGuide();
  const oldest = merged.programmes['one.ro'][0];

  assert.equal(oldest.title, 'Three Days Ago');
  assert.ok(Date.now() - Date.parse(oldest.stop) > 48 * HOUR_MS, 'Catchup-era programmes are retained');
});

test('refreshAll records per-source health and keeps serving the good source', async () => {
  await writeSettings([PLAIN_URL, DEAD_URL]);

  const health = await refreshAll();

  const good = health.find((source) => source.url === PLAIN_URL);
  const bad = health.find((source) => source.url === DEAD_URL);
  assert.equal(good.ok, true);
  assert.equal(good.channelCount, 1);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /upstream 500/);
  assert.deepEqual(await readSourceHealth(), health);

  const merged = await getMergedGuide();
  assert.ok(merged.channels['one.ro'], 'the healthy source still serves');
});

test('refreshAll skips sources younger than maxAgeMs and prunes unconfigured guides', async () => {
  await writeSettings([PLAIN_URL]);
  await refreshAll();
  const before = hits['/plain.xml'];

  await refreshAll({ maxAgeMs: HOUR_MS });
  assert.equal(hits['/plain.xml'], before, 'a fresh guide is not re-downloaded at boot');

  await refreshAll();
  assert.equal(hits['/plain.xml'], before + 1, 'a scheduled refresh always refetches');

  const remaining = await fs.readdir(path.join(DATA_DIR, 'epg'));
  assert.equal(
    remaining.filter((n) => n.endsWith('.json.gz')).length,
    1,
    'the de-configured gzip source file was pruned'
  );
});

test('a dead source is not refetched on every merged read', async () => {
  await writeSettings([PLAIN_URL, DEAD_URL]);
  await refreshAll(); // one attempt, which fails and marks the source
  const before = hits['/dead.xml'] || 0;

  await getMergedGuide();
  await getMergedGuide();
  await getMergedGuide();

  assert.equal(hits['/dead.xml'] || 0, before, 'request-path reads stop hammering a failing source');
});

// Regression: the fetch/parse step was wrapped in the failure handler but the
// persist step was not, so an unwritable volume left the source unthrottled and
// every merged read re-downloaded the whole guide.
test('a persist failure throttles the source like a fetch failure', async () => {
  const guideDir = path.join(DATA_DIR, 'epg');
  await fs.rm(guideDir, { recursive: true, force: true });
  await fs.writeFile(guideDir, 'a file where the directory should be', 'utf8'); // makes persist fail
  const before = hits[PERSIST_FAIL_PATH] || 0;

  await assert.rejects(() => refreshSource(PERSIST_FAIL_URL));
  assert.equal(hits[PERSIST_FAIL_PATH], before + 1);

  await writeSettings([PERSIST_FAIL_URL]);
  await getMergedGuide();
  await getMergedGuide();

  assert.equal(hits[PERSIST_FAIL_PATH], before + 1, 'a source that cannot be persisted is not refetched per read');
  await fs.rm(guideDir, { force: true });
});

// Regression: a temp file left by a process killed mid-persist matched the guide
// prefix but not the .json.gz suffix, so the prune pass walked past it forever.
// Only STALE temps are swept — a fresh one may belong to a write still running.
test('prune sweeps stale temp files but leaves an in-flight one alone', async () => {
  await writeSettings([PLAIN_URL]);
  await refreshAll();
  const guideDir = path.join(DATA_DIR, 'epg');
  const stale = path.join(guideDir, `${guideBasename(PLAIN_URL)}.11111111-2222-3333-4444-555555555555.tmp`);
  const inFlight = path.join(guideDir, 'channels.xml.99999999-8888-7777-6666-555555555555.tmp');
  await fs.writeFile(stale, 'half written from a crash', 'utf8');
  await fs.writeFile(inFlight, 'being written right now', 'utf8');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

  await refreshAll();

  const remaining = await fs.readdir(guideDir);
  assert.ok(!remaining.includes(path.basename(stale)), 'stale orphan swept');
  assert.ok(remaining.includes(path.basename(inFlight)), 'a recent temp is left for its writer');
  assert.ok(remaining.includes(guideBasename(PLAIN_URL)), 'the configured guide is kept');
  await fs.rm(inFlight, { force: true });
});

// PROXY_BLOCK_PRIVATE is read once at module load, and a ?query cache-bust would
// not reload the already-imported lib/http.js — so this runs in a child process
// to prove the engine really consults the guard, not just that the guard works.
test('a private-network EPG url is refused when PROXY_BLOCK_PRIVATE=1', { timeout: 30_000 }, async () => {
  const childDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-epg-blocked-'));
  await fs.writeFile(
    path.join(childDataDir, 'state.json'),
    JSON.stringify([{ key: 'settings', value: { epgUrls: ['http://192.168.0.10/guide.xml'] } }]),
    'utf8'
  );
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'epgstore.js')).href;

  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.refreshAll()));`],
    { env: { ...process.env, DATA_DIR: childDataDir, PROXY_BLOCK_PRIVATE: '1' }, encoding: 'utf8' }
  );

  const health = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(health[0].ok, false);
  assert.match(health[0].error, /private-network/);
});
