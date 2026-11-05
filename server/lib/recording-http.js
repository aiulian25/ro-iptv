import { promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// One range is supported. Unknown units and multiple ranges deliberately use
// the complete 200 representation; malformed/unsatisfiable single byte ranges
// get 416. BigInt prevents rounded/overflowing provider-supplied offsets.
export function recordingRange(header, size) {
  const full = { status: 200, start: 0, end: size - 1 };
  if (!header || size === 0) return full;
  const unit = /^([^=]+)=/.exec(header);
  if (!unit || unit[1].toLowerCase() !== 'bytes') return full;
  if (header.includes(',')) return full;
  const match = /^bytes=\s*(\d*)-(\d*)\s*$/i.exec(header);
  const invalid = { status: 416 };
  if (!match || (!match[1] && !match[2])) return invalid;
  const length = BigInt(size);
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return invalid;
    start = suffix >= length ? 0n : length - suffix;
    end = length - 1n;
  } else {
    start = BigInt(match[1]); end = match[2] ? BigInt(match[2]) : length - 1n;
    if (start >= length || end < start) return invalid;
    if (end >= length) end = length - 1n;
  }
  return { status: 206, start: Number(start), end: Number(end) };
}

// The caller supplies a filename already checked by resolveFile. Open once,
// stat and stream that descriptor so deletion between stat/open cannot crash
// the process or switch the file being served. Pipeline handles backpressure
// and destroys the read stream on client disconnect; finally closes the handle.
export async function sendRecordingFile(req, res, filePath, title) {
  let handle, stream;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (res.destroyed) return;
    if (!stat.isFile()) { res.status(404).json({ error: 'File not found' }); return; }
    if (!Number.isSafeInteger(stat.size)) throw new Error('Unsupported recording size');
    // No validators are advertised here: If-Range conservatively uses the full
    // representation. HEAD also ignores Range, as range semantics apply to GET.
    const selected = recordingRange(req.method === 'GET' && !req.headers['if-range'] ? req.headers.range : null, stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    if (selected.status === 416) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
      res.setHeader('Content-Length', '0'); res.end(); return;
    }
    if (req.query.dl) {
      const safe = (title || 'recording').replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 80) || 'recording';
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.mp4"`);
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.status(selected.status);
    if (selected.status === 206) res.setHeader('Content-Range', `bytes ${selected.start}-${selected.end}/${stat.size}`);
    res.setHeader('Content-Length', stat.size === 0 ? 0 : selected.end - selected.start + 1);
    if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
    stream = handle.createReadStream({ start: selected.start, end: selected.end, autoClose: false });
    await pipeline(stream, res);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    for (const name of ['Content-Length', 'Content-Range', 'Content-Disposition', 'Content-Type']) res.removeHeader(name);
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    res.status(missing ? 404 : 500).json({ error: missing ? 'File not found' : 'Could not read recording' });
  } finally {
    stream?.destroy();
    await handle?.close().catch(() => {});
  }
}
