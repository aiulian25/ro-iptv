// Tiny JSON file persistence for playlists & recordings metadata, plus the
// on-disk layout of the data volume (where raw uploaded playlists live).
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PLAYLIST_DIR = path.join(DATA_DIR, 'playlists');
// A playlist id may only name a file inside PLAYLIST_DIR — ids arrive from the
// client (POST /api/playlists accepts body.id), so this is a trust boundary.
const PLAYLIST_ID_RE = /^[a-zA-Z0-9-]+$/;

// Absolute path of a playlist's stored raw .m3u, or null when the id could
// escape PLAYLIST_DIR. Every reader and writer of those files goes through here.
export function playlistFilePath(id) {
  if (!PLAYLIST_ID_RE.test(id)) return null;
  return path.join(PLAYLIST_DIR, `${id}.m3u`);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

// Per-collection write queue: concurrent writers are serialized so they never
// race on the temp file (the old shared "<file>.tmp" caused ENOENT on rename
// and crashed the process) or clobber each other's updates.
const queues = new Map();
function enqueue(name, task) {
  const prev = queues.get(name) || Promise.resolve();
  const next = prev.then(task, task); // run regardless of the previous outcome
  queues.set(
    name,
    next.catch(() => {})
  );
  return next;
}

async function readRaw(name, { strict = false } = {}) {
  let raw;
  try {
    raw = await fs.readFile(fileFor(name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return strict ? null : [];
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('Invalid collection shape');
    return data;
  } catch (err) {
    if (strict) throw err;
    // Corrupt file (e.g. from an interrupted/raced write): quarantine it and
    // recover as empty so the store keeps working and self-heals on next write.
    try {
      await fs.rename(fileFor(name), `${fileFor(name)}.corrupt-${Date.now()}-${randomUUID()}`);
    } catch (cause) {
      throw Object.assign(new Error('Collection recovery failed; original bytes preserved'), { code: 'STORE_RECOVERY_FAILED', cause });
    }
    console.error(`store: ${name}.json was corrupt — quarantined and reset.`);
    return [];
  }
}

// Suffix of a not-yet-renamed write. Shared so a janitor can recognise one that a
// process died before finishing.
export const TMP_SUFFIX = '.tmp';

/**
 * Write a file so readers only ever see the complete version: a uniquely-named
 * temp alongside it, then a rename. Unique because concurrent writers to the same
 * path must not share a temp (a previous shared "<file>.tmp" raced on rename).
 */
export async function writeFileAtomic(filePath, data, options) {
  const tmp = `${filePath}.${randomUUID()}${TMP_SUFFIX}`;
  try {
    await fs.writeFile(tmp, data, options);
    await fs.rename(tmp, filePath);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function writeRaw(name, data) {
  await ensureDir();
  await writeFileAtomic(fileFor(name), JSON.stringify(data, null, 2));
  return data;
}

export async function readCollection(name, options) {
  await ensureDir();
  return readRaw(name, options);
}

// When a collection last changed on disk (ms), or 0 if it has never been written.
// Lets a derived cache decide whether it was built before or after its source.
export async function collectionChangedAt(name) {
  try {
    return (await fs.stat(fileFor(name))).mtimeMs;
  } catch {
    return 0;
  }
}

export function writeCollection(name, data) {
  return enqueue(name, () => writeRaw(name, data));
}

// Atomic read-modify-write under the per-collection lock. `mutator(list)` may
// mutate in place or return a new array; the result is persisted.
export function updateCollection(name, mutator, options) {
  return enqueue(name, async () => {
    await ensureDir();
    const list = (await readRaw(name, options)) || [];
    const result = mutator(list) || list;
    await writeRaw(name, result);
    return result;
  });
}

export { DATA_DIR, PLAYLIST_DIR };

// Configuration restore changes one collection only. Its snapshot never leaves
// the server; preserve exact old bytes (or absence) if committing fails.
export function restoreStateCollection(build) {
  return enqueue('state', async () => {
    await ensureDir();
    const file = fileFor('state');
    let original = null;
    try { original = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const records = original === null ? [] : JSON.parse(original.toString('utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid state collection');
    const next = await build(records);
    const snapshot = path.join(DATA_DIR, 'config-restore.previous.json');
    await writeFileAtomic(snapshot, original ?? 'null', { mode: 0o600 });
    try { await writeFileAtomic(file, JSON.stringify(next, null, 2)); }
    catch (error) {
      let current = null;
      try { current = await fs.readFile(file); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      if (!(current === null && original === null) && !(current && original && current.equals(original))) {
        if (original === null) await fs.unlink(file);
        else await fs.rename(snapshot, file);
      }
      throw error;
    }
    return next;
  });
}
