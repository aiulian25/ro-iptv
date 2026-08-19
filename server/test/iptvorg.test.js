// The incremental JSON array scanner (server/lib/iptvorg.js).
//
// The datasets are single-line arrays of ~180k objects, so they are walked rather
// than parsed whole. The scanner carries state across chunks, which makes chunk
// boundaries the whole risk: an earlier version rescanned an already-seen prefix
// and double-counted its braces, so depth never returned to zero and all but a
// handful of records were silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';

const { streamArrayObjects } = await import('../lib/iptvorg.js');

// Emit the text in fixed-size pieces so objects and strings straddle boundaries.
function chunked(text, size) {
  const pieces = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return Readable.from(pieces);
}

const RECORDS = [
  { id: 'Plain.ro', name: 'Plain Channel' },
  { id: 'Braces.ro', name: 'Has { and } inside a string' },
  { id: 'Quotes.ro', name: 'Escaped \\" quote and a trailing backslash \\\\' },
  { id: 'Nested.ro', name: 'Nested', extra: { deep: { deeper: 1 } }, list: [1, 2, 3] },
  { id: 'Unicode.ro', name: 'Diacritice: Știri și Țară' },
];
const JSON_TEXT = JSON.stringify(RECORDS);

test('every object is recovered regardless of chunk size', async () => {
  for (const size of [1, 2, 7, 13, 64, 1024, JSON_TEXT.length]) {
    const seen = [];
    for await (const record of streamArrayObjects(chunked(JSON_TEXT, size))) seen.push(record);
    assert.deepEqual(seen, RECORDS, `chunk size ${size} lost or corrupted records`);
  }
});

test('braces and escapes inside strings do not confuse the depth count', async () => {
  const seen = [];
  for await (const record of streamArrayObjects(chunked(JSON_TEXT, 3))) seen.push(record);

  assert.equal(seen[1].name, 'Has { and } inside a string');
  assert.equal(seen[2].name, 'Escaped \\" quote and a trailing backslash \\\\');
  assert.deepEqual(seen[3].extra, { deep: { deeper: 1 } });
});

test('an empty array yields nothing rather than throwing', async () => {
  const seen = [];
  for await (const record of streamArrayObjects(chunked('[]', 1))) seen.push(record);
  assert.deepEqual(seen, []);
});

// Every record of a large document must survive, in order. (That the scanner does
// not retain the document is measured against the real 36 MB dataset rather than
// asserted here — reading V8 heap mid-run without forcing GC is not reliable.)
test('a large array is walked completely and in order', async () => {
  const many = Array.from({ length: 20_000 }, (_, i) => ({ id: `Ch${i}.ro`, name: `Channel ${i}` }));
  const seen = [];
  for await (const record of streamArrayObjects(chunked(JSON.stringify(many), 8192))) seen.push(record);

  assert.equal(seen.length, many.length);
  assert.deepEqual(seen[0], many[0]);
  assert.deepEqual(seen.at(-1), many.at(-1));
});
