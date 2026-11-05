// ffmpeg-based stream capture manager.
// Records a live stream (HLS/MP4/TS) to an .mp4 file in DATA_DIR/recordings.
// Stream-copies (no re-encode) for speed, and stops ffmpeg gracefully so the
// MP4 moov atom is finalised (seekable + downloadable). Per-recording duration
// is capped by media time plus an independent wall-clock supervisor.
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { mkdirSync } from 'fs';
import path from 'path';
import { BLOCK_PRIVATE, FETCH_HEADERS } from './http.js';
import { relayRecording } from './recording-input.js';

export const RECORDING_STOP_GRACE_MS = 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
export function validateRecordingMinutes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value * 60000 > MAX_TIMER_MS) {
    throw Object.assign(new Error('Invalid recording duration'), { status: 400 });
  }
  return value;
}

const FILENAME_RE = /^[a-zA-Z0-9-]+\.mp4$/;
// Everything a live HLS/TS/MP4 capture over http(s) needs, and nothing else, so a
// crafted input can never make ffmpeg open file:, concat:, subfile:, data: or udp:.
// Applies to the INPUT only — the captured .mp4 is still written over file:.
const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto';

export function recordingsDir(dataDir) {
  return path.join(dataDir, 'recordings');
}

export function isValidRecordingId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id);
}

export function isValidRecordingWindow(start, end) {
  return typeof start === 'string' && typeof end === 'string' &&
    Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) &&
    Date.parse(end) > Date.parse(start);
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

export function createCaptureManager({ maxConcurrent = 4, idleTimeoutMs = 30000,
  stopGraceMs = RECORDING_STOP_GRACE_MS, ffmpegPath = 'ffmpeg' } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid recording concurrency');
  for (const value of [idleTimeoutMs, stopGraceMs]) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) throw new Error('Invalid recording timeout');
  }
  const active = new Map();
  let shuttingDown = false;

  function isRecording(id) {
    return active.has(id);
  }

  async function currentSize(id) {
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
  function startCapture({ rec, dataDir, maxMinutes, deadlineAt = Date.now() + maxMinutes * 60000, userAgent, referer, onFinish }) {
    if (!isValidRecordingId(rec.id)) throw new Error('Invalid recording ID');
    validateRecordingMinutes(maxMinutes);
    if (shuttingDown) throw Object.assign(new Error('Recorder shutting down'), { status: 503 });
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw Object.assign(new Error('Recording deadline has passed'), { status: 400 });
    if (active.has(rec.id)) throw Object.assign(new Error('Recording already active'), { status: 409 });
    if (active.size >= maxConcurrent) throw Object.assign(new Error('Recording capacity reached'), { status: 503, code: 'RECORDING_CAPACITY' });
    const deadline = Math.min(deadlineAt, Date.now() + maxMinutes * 60000);
    const filename = fileNameFor(rec.id);
    const filePath = resolveFile(dataDir, filename);
    if (!filePath) throw new Error('Invalid recording output path');
    mkdirSync(recordingsDir(dataDir), { recursive: true });

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-progress', 'pipe:1',
      '-nostats',
      ...(BLOCK_PRIVATE ? ['-protocol_whitelist', 'pipe', '-format_whitelist', 'mpegts,mov,mp3,aac,ogg,flac,wav,matroska,flv'] : [
        '-rw_timeout', String(Math.ceil(idleTimeoutMs * 1000)),
        '-user_agent', userAgent || 'Mozilla/5.0 (RO-IPTV)',
        ...(referer ? ['-headers', `Referer: ${referer}\r\n`] : []),
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
      ]),
      '-i',
      BLOCK_PRIVATE ? 'pipe:0' : rec.url,
      '-c',
      'copy',
      '-t',
      String(Math.max(1, Math.round(maxMinutes * 60))),
      // Let the muxer see packet/codec data before the initial moov (empty_moov
      // breaks automatic ADTS AAC conversion on supported host ffmpeg). Keep
      // keyframe fragmentation; the first header/fragment may be delayed.
      '-avoid_negative_ts',
      'make_zero',
      '-movflags',
      '+frag_keyframe+default_base_moof',
      '-f',
      'mp4',
      filePath,
    ];

    // Arg array (no shell) → no command injection from the stream URL.
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const controller = new AbortController();
    let inputError = '';
    let stopReason = '';
    let finalized = false;
    let deadlineTimer, idleTimer, killTimer;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    function stop(reason) {
      if (finalized || stopReason) return;
      stopReason = reason;
      clearTimeout(deadlineTimer);
      clearTimeout(idleTimer);
      controller.abort();
      if (BLOCK_PRIVATE) child.stdin.destroy();
      try { child.kill('SIGINT'); } catch { /* escalation below */ }
      killTimer = setTimeout(() => {
        if (!finalized) { try { child.kill('SIGKILL'); } catch { /* process already closed */ } }
      }, stopGraceMs);
    }
    function progress() {
      if (stopReason || finalized) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle-timeout'), idleTimeoutMs);
    }
    active.set(rec.id, { child, filePath, stop, done });
    deadlineTimer = setTimeout(() => stop('deadline'), Math.max(1, deadline - Date.now()));
    progress();
    let progressBuffer = '';
    const lastProgress = new Map();
    child.stdout.on('data', (bytes) => {
      progressBuffer = (progressBuffer + bytes.toString()).slice(-16384);
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop();
      for (const line of lines) {
        const [name, value] = line.trim().split('=');
        if (!['out_time_us', 'total_size'].includes(name)) continue;
        const number = Number(value);
        if (Number.isFinite(number) && number > (lastProgress.get(name) ?? -1)) {
          lastProgress.set(name, number);
          progress();
        }
      }
    });
    child.stdin.on('error', () => {});
    if (BLOCK_PRIVATE) {
      relayRecording(rec.url, child.stdin, {
        headers: { ...FETCH_HEADERS, 'User-Agent': userAgent || FETCH_HEADERS['User-Agent'], ...(referer ? { Referer: referer } : {}) },
        signal: controller.signal,
      }).catch(() => {
        if (controller.signal.aborted) return;
        inputError = 'Recording input refused or unavailable';
        stop('input-error');
      });
    }
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const finalize = async (exitCode, exitSignal) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(deadlineTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      controller.abort();
      let size = 0;
      try {
        size = (await fs.stat(filePath)).size;
      } catch {
        /* no file */
      }
      const ok = size > 0;
      const intentional = ['stopped', 'deadline'].includes(stopReason);
      const muxFailure = /Malformed AAC bitstream|Error muxing|Error submitting a packet to the muxer/i.test(stderr);
      const failureDiagnostic = /Malformed AAC bitstream|aac_adtstoasc/i.test(stderr) ? 'AAC audio could not be copied into MP4'
        : /Error muxing|not currently supported in container/i.test(stderr) ? 'Media could not be written to MP4'
        : /timed out/i.test(stderr) ? 'Recording input timed out'
        : `Capture failed (exit code ${Number.isInteger(exitCode) ? exitCode : 'unknown'})`;
      const graceful = exitCode === 0 || (intentional && !muxFailure && (exitCode === 255 || exitSignal === 'SIGINT'));
      let status = 'completed';
      let error = '';
      if (inputError || stopReason === 'idle-timeout') {
        status = 'failed';
        error = inputError || 'Recording input stalled';
      } else if (muxFailure && exitCode !== 0) {
        status = 'failed'; error = failureDiagnostic;
      } else if (stopReason === 'shutdown' || exitSignal === 'SIGKILL' || (exitSignal && !graceful)) {
        status = 'interrupted';
        error = exitSignal === 'SIGKILL' ? 'Capture required a forced stop' : 'Capture was interrupted';
      } else if (!graceful) {
        status = 'failed';
        // Allowlisted diagnostic categories only. Raw ffmpeg text may contain
        // provider userinfo, query/path credentials or arbitrary server messages.
        error = failureDiagnostic;
      }
      if (!ok) { status = 'failed'; error ||= 'Capture produced no data'; }
      const patch = {
        id: rec.id,
        filename: ok ? filename : '',
        size,
        status,
        end: new Date().toISOString(),
        error,
        partial: ok && status !== 'completed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        exitSignal: exitSignal || null,
        stopReason: stopReason || 'source-ended',
      };
      try { await onFinish(patch); } finally { active.delete(rec.id); resolveDone(patch); }
    };

    child.once('error', () => { inputError = 'Capture process unavailable'; stop('spawn-error'); });
    child.once('close', (code, signal) => { finalize(code, signal).catch(() => {}); });

    return { filename };
  }

  // All stop paths share one signal/escalation timer and finalize on close once.
  function stopCapture(id) {
    const entry = active.get(id);
    if (!entry) return false;
    entry.stop('stopped');
    return true;
  }
  function stopAll() {
    shuttingDown = true;
    const entries = [...active.values()];
    for (const entry of entries) entry.stop('shutdown');
    return Promise.all(entries.map((entry) => entry.done));
  }
  return { startCapture, stopCapture, stopAll, isRecording, currentSize };
}

export const { startCapture, stopCapture, stopAll, isRecording, currentSize } = createCaptureManager({
  maxConcurrent: Number(process.env.RECORDING_MAX_CONCURRENT || '4'),
  idleTimeoutMs: Number(process.env.RECORDING_INPUT_IDLE_SECONDS || '30') * 1000,
});
