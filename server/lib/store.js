// Tiny JSON file persistence for playlists & recordings metadata.
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

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

async function readRaw(name) {
  let raw;
  try {
    raw = await fs.readFile(fileFor(name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    // Corrupt file (e.g. from an interrupted/raced write): quarantine it and
    // recover as empty so the store keeps working and self-heals on next write.
    try {
      await fs.rename(fileFor(name), `${fileFor(name)}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    console.error(`store: ${name}.json was corrupt — quarantined and reset.`);
    return [];
  }
}

async function writeRaw(name, data) {
  await ensureDir();
  const tmp = `${fileFor(name)}.${randomUUID()}.tmp`; // unique → no cross-write race
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, fileFor(name));
  return data;
}

export async function readCollection(name) {
  await ensureDir();
  return readRaw(name);
}

export function writeCollection(name, data) {
  return enqueue(name, () => writeRaw(name, data));
}

// Atomic read-modify-write under the per-collection lock. `mutator(list)` may
// mutate in place or return a new array; the result is persisted.
export function updateCollection(name, mutator) {
  return enqueue(name, async () => {
    await ensureDir();
    const list = await readRaw(name);
    const result = mutator(list) || list;
    await writeRaw(name, result);
    return result;
  });
}

export { DATA_DIR };
