import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-aud019-scope-'));
process.env.DATA_DIR = root;
const moduleUrl = process.env.AUD019_CHANNELSXML_SOURCE ? pathToFileURL(process.env.AUD019_CHANNELSXML_SOURCE) : new URL('../lib/channelsxml.js', import.meta.url);
const { generateChannelsXml, readSidecarSummary, renderChannelsXml, CHANNELS_XML_PATH } = await import(moduleUrl);
const { buildWantedChannels } = await import('../lib/channels.js');
const channel = { id: 'p__c', name: 'Fixture & News', tvgId: 'Fixture.ro', country: 'ro', playlistId: 'p' };
const full = { countries: ['ro'], channels: [channel], incomplete: false, skippedPlaylists: [] };
const empty = { countries: [], channels: [], incomplete: false, skippedPlaylists: [] };
await fs.mkdir(path.join(root, 'iptv-org'), { recursive: true });
await fs.writeFile(path.join(root, 'iptv-org/channels.json.gz'), zlib.gzipSync(JSON.stringify([{ id: 'Fixture.ro', name: channel.name, country: 'RO', closed: null }])));
await fs.writeFile(path.join(root, 'iptv-org/guides.json.gz'), zlib.gzipSync(JSON.stringify([{ channel: 'Fixture.ro', site: 'fixture.example', site_id: 'one&two', lang: 'ro' }])));
test.after(() => fs.rm(root, { recursive: true, force: true }));
async function readXml() {
  const xml = await fs.readFile(CHANNELS_XML_PATH, 'utf8'); assert.equal(XMLValidator.validate(xml), true);
  assert.equal(Object.hasOwn(new XMLParser().parse(xml), 'channels'), true); return xml;
}
test('nonempty → empty → nonempty atomically replaces stale grabber input and keeps summary aligned', async () => {
  const first = await generateChannelsXml(full); assert.equal(first.mapped, 1);
  assert.match(await readXml(), /Fixture\.ro/); assert.match(await readXml(), /Fixture &amp; News/);
  const inode = (await fs.stat(CHANNELS_XML_PATH)).ino;
  const cleared = await generateChannelsXml(empty); assert.equal(cleared.written, true); assert.equal(cleared.total, 0); assert.equal(cleared.mapped, 0); assert.equal(cleared.matchedChannels, 0);
  assert.deepEqual(cleared.sites, []); assert.deepEqual(cleared.unmapped, []); assert.equal(await readXml(), renderChannelsXml([]));
  assert.notEqual((await fs.stat(CHANNELS_XML_PATH)).ino, inode, 'Replacement uses a new file'); assert.deepEqual(await readSidecarSummary(), cleared);
  assert.equal((await generateChannelsXml(full)).mapped, 1); assert.match(await readXml(), /Fixture\.ro/);
});
test('a confirmed countryless scope clears the previous file without a dataset lookup', async () => {
  const result = await generateChannelsXml({ ...empty, channels: [{ name: 'No country', country: '' }] });
  assert.equal(result.total, 0); assert.equal(result.written, true); assert.equal(await readXml(), renderChannelsXml([]));
});
test('incomplete, skipped or truncated indexes preserve the last good file and summary', async () => {
  await generateChannelsXml(full); const xml = await readXml(), summary = await readSidecarSummary();
  for (const patch of [{ incomplete: true }, { skippedPlaylists: ['missing'] }, { truncated: true }]) {
    for (const scope of [full, empty]) await assert.rejects(generateChannelsXml({ ...scope, ...patch }), /scope is incomplete/);
    assert.equal(await readXml(), xml); assert.deepEqual(await readSidecarSummary(), summary);
  }
});
test('failed playlist reads remain incomplete; disabling/deleting the final playlist is authoritative empty scope', async () => {
  await generateChannelsXml(full);
  const metadata = path.join(root, 'playlists.json');
  await fs.writeFile(metadata, JSON.stringify([{ id: 'p', hasFile: true, enabled: true }]));
  const incomplete = await buildWantedChannels(); assert.equal(incomplete.incomplete, true); assert.deepEqual(incomplete.skippedPlaylists, ['p']);
  await assert.rejects(generateChannelsXml(incomplete), /scope is incomplete/); assert.match(await readXml(), /Fixture\.ro/);
  await fs.writeFile(metadata, JSON.stringify([{ id: 'p', hasFile: true, enabled: false }]));
  const disabled = await buildWantedChannels(); assert.equal(disabled.incomplete, false); assert.equal((await generateChannelsXml(disabled)).total, 0); assert.equal(await readXml(), renderChannelsXml([]));
  await generateChannelsXml(full); await fs.writeFile(metadata, '[]');
  assert.equal((await generateChannelsXml(await buildWantedChannels())).total, 0); assert.equal(await readXml(), renderChannelsXml([]));
});
test('corrupt/wrong-shape metadata cannot masquerade as deliberate deletion', async () => {
  await generateChannelsXml(full); const xml = await readXml(), summary = await readSidecarSummary();
  for (const text of ['broken json', '{}']) {
    await fs.writeFile(path.join(root, 'playlists.json'), text);
    await assert.rejects(async () => generateChannelsXml(await buildWantedChannels()));
    assert.equal(await readXml(), xml); assert.deepEqual(await readSidecarSummary(), summary);
  }
  await fs.rm(path.join(root, 'playlists.json'));
  assert.equal((await buildWantedChannels()).incomplete, false, 'A fresh install with no metadata is a valid empty scope');
});
test('a failed XML replacement does not publish a zero summary or block subsequent generation', async () => {
  await generateChannelsXml(full); const summary = await readSidecarSummary();
  const backup = CHANNELS_XML_PATH + '.backup'; await fs.rename(CHANNELS_XML_PATH, backup); await fs.mkdir(CHANNELS_XML_PATH);
  try { await assert.rejects(generateChannelsXml(empty)); assert.deepEqual(await readSidecarSummary(), summary); }
  finally { await fs.rmdir(CHANNELS_XML_PATH); await fs.rename(backup, CHANNELS_XML_PATH); }
  assert.equal((await generateChannelsXml(empty)).written, true); assert.equal(await readXml(), renderChannelsXml([]));
  assert.equal((await fs.readdir(path.dirname(CHANNELS_XML_PATH))).some(name => name.endsWith('.tmp')), false);
});
test('overlapping generations finish in request order so a later clear cannot be undone', async () => {
  await Promise.all([generateChannelsXml(full), generateChannelsXml(empty)]);
  assert.equal(await readXml(), renderChannelsXml([])); assert.equal((await readSidecarSummary()).total, 0);
  await Promise.all([generateChannelsXml(empty), generateChannelsXml(full)]);
  assert.match(await readXml(), /Fixture\.ro/); assert.equal((await readSidecarSummary()).mapped, 1);
});
