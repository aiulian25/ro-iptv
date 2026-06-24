// ffmpeg-based stream capture manager.
// Records a live stream (HLS/MP4/TS) to an .mp4 file in DATA_DIR/recordings.
// Stream-copies (no re-encode) for speed, and stops ffmpeg gracefully so the
// MP4 moov atom is finalised (seekable + downloadable). Per-recording duration
// is capped via ffmpeg's `-t`, so a capture can never run unbounded.
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';

const active = new Map(); // id -> { child, filePath }

const FILENAME_RE = /^[a-zA-Z0-9-]+\.mp4$/;

export function recordingsDir(dataDir) {
  return path.join(dataDir, 'recordings');
}

export function fileNameFor(id) {
  return `${id}.mp4`;
}

// Resolve a recording filename to an absolute path, guarding against traversal.
export function resolveFile(dataDir, filename) {
  if (!filename || !FILENAME_RE.test(filename)) return null;
  const dir = recordingsDir(dataDir);
  const full = path.resolve(dir, filename);
  if (path.dirname(full) !== path.resolve(dir)) return null;
  return full;
}

export function isRecording(id) {
  return active.has(id);
}

export async function currentSize(id) {
  const a = active.get(id);
  if (!a) return null;
  try {
    return (await fs.stat(a.filePath)).size;
  } catch {
    return null;
  }
}

/**
 * Spawn an ffmpeg capture. Calls onFinish(patch) when the process exits
 * (cleanly via -t / graceful stop, or on error).
 */
export function startCapture({ rec, dataDir, maxMinutes, userAgent, referer, onFinish }) {
  const dir = recordingsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const filename = fileNameFor(rec.id);
  const filePath = path.join(dir, filename);

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-user_agent',
    userAgent || 'Mozilla/5.0 (RO-IPTV)',
    // Forward a Referer for streams that require it (CRLF-terminated per ffmpeg).
    ...(referer ? ['-headers', `Referer: ${referer}\r\n`] : []),
    '-i',
    rec.url,
    '-c',
    'copy',
    '-t',
    String(Math.max(1, Math.round(maxMinutes * 60))),
    // Fragmented MP4: the moov/init lands at the START, so the file streams in
    // the browser immediately and stays playable even if the capture is cut off
    // (no end-of-file "finalisation" needed). Also drops negative start offsets.
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    filePath,
  ];

  // Arg array (no shell) → no command injection from the stream URL.
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  active.set(rec.id, { child, filePath });

  const finalize = async (status, error) => {
    active.delete(rec.id);
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      /* no file */
    }
    const ok = size > 0;
    onFinish({
      id: rec.id,
      filename: ok ? filename : '',
      size,
      status: ok ? status : 'failed',
      end: new Date().toISOString(),
      error: ok ? '' : (error || stderr.slice(-400)) || 'capture produced no data',
    });
  };

  child.on('exit', () => finalize('completed'));
  child.on('error', (err) => finalize('failed', String(err)));

  return { filename };
}

// Gracefully stop a capture so the MP4 is finalised. SIGKILL only as a backstop.
export function stopCapture(id) {
  const a = active.get(id);
  if (!a) return false;
  try {
    a.child.stdin.write('q\n');
  } catch {
    try {
      a.child.kill('SIGINT');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    try {
      if (active.has(id)) a.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 8000);
  return true;
}

export function stopAll() {
  for (const id of active.keys()) stopCapture(id);
}
