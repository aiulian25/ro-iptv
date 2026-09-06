// Runs parseEPG off the main thread: a country pack is ~63 MB of XML and takes
// seconds to parse, during which the event loop cannot serve /api/proxy — so every
// scheduled refresh froze playback for everyone watching.
//
// The gzipped bytes are sent in rather than the XML, so decompressing and decoding
// them (another ~170 ms of main-thread work) happens here too, and the 63 MB string
// only ever exists inside this thread.
import zlib from 'zlib';
import { promisify } from 'util';
import { parentPort, workerData } from 'worker_threads';

import { parseEPG } from './epg.js';

const gunzip = promisify(zlib.gunzip);

// gzip magic bytes (1f 8b) — a .xml.gz guide; anything else is already plain XML.
function isGzip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function run() {
  const { body, maxOutputLength } = workerData;
  const buffer = Buffer.from(body);
  const xml = isGzip(buffer) ? (await gunzip(buffer, { maxOutputLength })).toString('utf8') : buffer.toString('utf8');
  parentPort.postMessage(parseEPG(xml));
}

run().catch((error) => {
  // Surfaces as the worker's 'error' event, so the caller sees the real reason
  // (an oversized decompression, malformed XML) rather than a bare exit code.
  throw error;
});
