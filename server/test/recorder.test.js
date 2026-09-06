// Recording filename → filesystem path resolution (server/lib/recorder.js).
//
// `resolveFile` is the only thing standing between a stored `filename` and an
// arbitrary path: the download, delete and stream routes all take the filename from
// a recording record and hand it straight to this function. Its guard is a strict
// allow-list (`^[a-zA-Z0-9-]+\.mp4$`) plus a containment check, and both halves are
// asserted here — a future relaxation of either would reopen path traversal.
//
// Pure path arithmetic: nothing here touches the disk, so no DATA_DIR fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { randomUUID } from 'crypto';

import { resolveFile, fileNameFor, recordingsDir } from '../lib/recorder.js';

const DATA_DIR = '/data';
const RECORDINGS_DIR = recordingsDir(DATA_DIR);

// Names the allow-list is meant to accept.
const ACCEPTED = ['abc.mp4', 'a-b-c.mp4', 'ABC.mp4', '0.mp4'];

// Every shape that must not produce a path, and why it is here.
const REJECTED = [
  ['../x.mp4', 'parent traversal'],
  ['../../etc/passwd.mp4', 'repeated traversal'],
  ['a/b.mp4', 'a subdirectory'],
  ['/etc/passwd', 'an absolute path'],
  [`${RECORDINGS_DIR}/abc.mp4`, 'an absolute path that is already inside the directory'],
  ['..\\x.mp4', 'a backslash separator'],
  ['abc.mkv', 'a different extension'],
  ['abc.MP4', 'the extension in the wrong case'],
  ['a.mp4.mp4', 'a double extension'],
  ['.mp4', 'no name at all'],
  ['ab c.mp4', 'a space'],
  ['çab.mp4', 'a non-ASCII letter'],
  ['abc.mp4 ', 'a trailing space'],
  ['abc.mp4\n', 'a trailing newline (JS `$` does not match before it, unlike some regex flavours)'],
  ['abc.mp4\u0000.txt', 'a null byte truncating the name'],
  ['', 'an empty string'],
  ['..', 'no extension'],
  [undefined, 'undefined'],
  [null, 'null'],
  [42, 'a non-string'],
];

test('an allowed filename resolves inside the recordings directory', () => {
  for (const name of ACCEPTED) {
    assert.equal(resolveFile(DATA_DIR, name), path.join(RECORDINGS_DIR, name), name);
  }
});

test('every traversal, separator and extension trick resolves to null', () => {
  for (const [name, reason] of REJECTED) {
    assert.equal(resolveFile(DATA_DIR, name), null, `${JSON.stringify(name)} — ${reason}`);
  }
});

// The property that actually matters, stated independently of the allow-list: no
// input may ever yield a path outside the recordings directory. If the regex is
// ever loosened, this is the assertion that should catch what slips through.
test('no input can produce a path outside the recordings directory', () => {
  for (const [name] of REJECTED.concat(ACCEPTED.map((n) => [n]))) {
    const resolved = resolveFile(DATA_DIR, name);
    if (resolved === null) continue;
    assert.equal(path.dirname(resolved), RECORDINGS_DIR, `${JSON.stringify(name)} escaped the directory`);
  }
});

// Recording ids come from randomUUID, so the name the recorder writes must be a
// name the download route can resolve back. Both ends of that contract in one test.
test('fileNameFor round-trips through resolveFile', () => {
  const id = randomUUID();
  const filename = fileNameFor(id);

  assert.equal(filename, `${id}.mp4`);
  assert.equal(resolveFile(DATA_DIR, filename), path.join(RECORDINGS_DIR, filename));
});

test('recordingsDir stays a subdirectory of the data volume', () => {
  assert.equal(RECORDINGS_DIR, path.join(DATA_DIR, 'recordings'));
});
