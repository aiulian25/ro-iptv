// One parser worker at a time; bounded waiting and lifetime prevent concurrent
// untrusted guides from consuming the whole process budget.
import { Worker } from 'node:worker_threads';
const PARSE_WORKER = new URL('./epgparse.worker.js', import.meta.url);
export const EPG_MAX_DECOMPRESSED = 600 * 1024 * 1024;
export const PARSE_TIMEOUT_MS = 60_000;
const MAX_PENDING = 2;
const pending = [];
let active = false;

export function parseGuideOffThread(body, { workerUrl = PARSE_WORKER, timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  if (active && pending.length >= MAX_PENDING) return Promise.reject(new Error('EPG parser busy'));
  return new Promise((resolve, reject) => {
    const job = { body, workerUrl, resolve, reject, worker: null, done: false };
    job.finish = async (error, value) => {
      if (job.done) return;
      job.done = true;
      clearTimeout(job.timer);
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      if (job.worker) {
        await job.worker.terminate();
        active = false;
      }
      if (error) reject(error); else resolve(value);
      pump();
    };
    job.timer = setTimeout(() => job.finish(new Error('EPG parsing deadline exceeded')), timeoutMs);
    pending.push(job);
    pump();
  });
}

function pump() {
  if (active || !pending.length) return;
  const job = pending.shift();
  active = true;
  try {
    job.worker = new Worker(job.workerUrl, {
      workerData: { body: job.body, maxOutputLength: EPG_MAX_DECOMPRESSED },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    job.worker.once('message', (value) => job.finish(null, value));
    job.worker.once('error', (error) => job.finish(error));
    job.worker.once('exit', () => job.finish(new Error('EPG parser exited without a result')));
  } catch (error) {
    active = false;
    job.finish(error);
  }
}
