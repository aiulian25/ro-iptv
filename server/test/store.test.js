// The JSON collection store (server/lib/store.js).
//
// Two mechanisms here exist because of real crashes, and neither had a test:
// the per-collection write queue (concurrent read-modify-writes used to clobber
// each other) and the unique temp filename in writeFileAtomic (a shared
// "<file>.tmp" raced on rename and threw ENOENT).
//
// DATA_DIR must be set before the import — store.js reads it at load time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const TEMP_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-store-'));
process.env.DATA_DIR = TEMP_DATA_DIR;

const { readCollection, writeCollection, updateCollection, collectionChangedAt, writeFileAtomic, DATA_DIR, TMP_SUFFIX } =
  await import('../lib/store.js');

const CONCURRENT_WRITES = 50;
const fileFor = (name) => path.join(TEMP_DATA_DIR, `${name}.json`);
const listDataDir = () => fs.readdir(TEMP_DATA_DIR);

test.after(() => fs.rm(TEMP_DATA_DIR, { recursive: true, force: true }));

test('the store writes to the DATA_DIR that was set before import', () => {
  assert.equal(DATA_DIR, TEMP_DATA_DIR);
});

// Without the per-collection queue every one of these reads the same empty list
// and the last writer wins, leaving a single entry instead of fifty.
test('concurrent updates to one collection are serialized, losing none', async () => {
  const name = 'concurrent';

  await Promise.all(
    Array.from({ length: CONCURRENT_WRITES }, (_, index) =>
      updateCollection(name, (list) => {
        list.push({ index });
        return list;
      })
    )
  );

  const stored = await readCollection(name);
  assert.equal(stored.length, CONCURRENT_WRITES);
  assert.deepEqual(
    stored.map((entry) => entry.index).sort((a, b) => a - b),
    Array.from({ length: CONCURRENT_WRITES }, (_, index) => index)
  );

  const leftovers = (await listDataDir()).filter((entry) => entry.endsWith(TMP_SUFFIX));
  assert.deepEqual(leftovers, [], 'every temp file must have been renamed away');
});

// The ENOENT crash this replaced: two writers sharing one "<file>.tmp", the second
// rename firing after the first had already moved the file away.
test('concurrent atomic writes to one path never collide', async () => {
  const filePath = path.join(TEMP_DATA_DIR, 'atomic.json');

  await Promise.all(
    Array.from({ length: CONCURRENT_WRITES }, (_, index) => writeFileAtomic(filePath, JSON.stringify({ index })))
  );

  const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(typeof written.index, 'number', 'the survivor must be one complete write, not a mixture');

  const leftovers = (await listDataDir()).filter((entry) => entry.endsWith(TMP_SUFFIX));
  assert.deepEqual(leftovers, []);
});

test('a corrupt collection is quarantined and read back as empty', async () => {
  const name = 'corrupt';
  await writeCollection(name, [{ keep: 'me' }]);
  await fs.writeFile(fileFor(name), '{not json');

  assert.deepEqual(await readCollection(name), [], 'a broken file must not take the store down');

  const quarantined = (await listDataDir()).filter((entry) => entry.startsWith(`${name}.json.corrupt-`));
  assert.equal(quarantined.length, 1, 'the broken bytes are kept for inspection, not deleted');
  assert.equal(await fs.readFile(path.join(TEMP_DATA_DIR, quarantined[0]), 'utf8'), '{not json');

  // Self-healing: the collection is writable again straight after.
  await writeCollection(name, [{ fresh: true }]);
  assert.deepEqual(await readCollection(name), [{ fresh: true }]);
});

// Every caller treats a collection as an array, so a JSON document that parses but
// is not one has to come back as empty rather than as an object.
test('a collection whose JSON is not an array reads as empty', async () => {
  const name = 'not-an-array';
  await fs.writeFile(fileFor(name), JSON.stringify({ shape: 'wrong' }));

  assert.deepEqual(await readCollection(name), []);
});

test('a collection that has never been written reads as empty', async () => {
  assert.deepEqual(await readCollection('never-written'), []);
});

test('collectionChangedAt is 0 until the collection exists, then a real timestamp', async () => {
  const name = 'stamped';
  assert.equal(await collectionChangedAt(name), 0);

  await writeCollection(name, [{ first: true }]);
  const afterFirstWrite = await collectionChangedAt(name);
  assert.ok(afterFirstWrite > 0, 'a written collection must report when it changed');

  await writeCollection(name, [{ second: true }]);
  assert.ok(
    (await collectionChangedAt(name)) >= afterFirstWrite,
    'a later write must not report an earlier time'
  );
});
