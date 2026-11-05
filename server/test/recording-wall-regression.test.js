import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('stalled child obeys wall duration independently of media output', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-wall-regression-'));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
process.on('SIGINT',()=>process.exit(0));process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000);
`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + previous;
  const recorder = await import(process.env.AUD007_RECORDER_MODULE || '../lib/recorder.js');
  let finish; const finished = new Promise((r) => { finish = r; });
  try {
    recorder.startCapture({ rec: { id: 'wall', url: 'http://fixture.invalid/' }, dataDir: root, maxMinutes: 1 / 60, onFinish: finish });
    await new Promise((r) => setTimeout(r, 1500));
    const stillActive = recorder.isRecording('wall');
    // Cleanup even on the original implementation, whose watchdog is absent.
    recorder.stopCapture('wall'); await finished;
    assert.equal(stillActive, false, 'a one-second capture must stop even when no media time advances');
  } finally {
    process.env.PATH = previous;
    recorder.stopCapture('wall');
    await fs.rm(root, { recursive: true, force: true });
  }
});
