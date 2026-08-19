// ICY now-playing probe (server/lib/icy.js), against a real Icecast-shaped server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

const { probeNowPlaying } = await import('../lib/icy.js');

const METAINT = 512;
const METADATA_LENGTH_UNIT = 16;

// Build one ICY metadata block: a length byte in 16-byte units, then the padded text.
function metadataBlock(text) {
  const payload = Buffer.from(text, 'utf8');
  const blocks = Math.ceil(payload.length / METADATA_LENGTH_UNIT);
  const block = Buffer.alloc(1 + blocks * METADATA_LENGTH_UNIT);
  block[0] = blocks;
  payload.copy(block, 1);
  return block;
}

let receivedAgent = '';
let receivedIcyRequest = '';

// Serves audio with interleaved metadata, exactly as Icecast does. Paths choose
// the shape: with metadata, headers only, or a title split across chunks.
const server = http.createServer((req, res) => {
  receivedAgent = req.headers['user-agent'] || '';
  receivedIcyRequest = req.headers['icy-metadata'] || '';

  if (req.url === '/no-metadata') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'Plain Station', 'icy-br': '96' });
    return res.end(Buffer.alloc(64));
  }
  if (req.url === '/dead') {
    res.writeHead(404);
    return res.end();
  }
  if (req.url === '/apostrophe' || req.url === '/latin1' || req.url === '/empty-first') {
    const headers = { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(METAINT) };
    res.writeHead(200, headers);
    const audio = Buffer.alloc(METAINT, 0x41);
    if (req.url === '/apostrophe') {
      res.write(Buffer.concat([audio, metadataBlock("StreamTitle='Guns N' Roses - Sweet Child O' Mine';StreamUrl='';")]));
    } else if (req.url === '/latin1') {
      // A cp1252 station: "Björk – Jóga" encoded as latin1, not UTF-8.
      const payload = Buffer.from("StreamTitle='Björk - Jóga';", 'latin1');
      const blocks = Math.ceil(payload.length / METADATA_LENGTH_UNIT);
      const block = Buffer.alloc(1 + blocks * METADATA_LENGTH_UNIT);
      block[0] = blocks;
      payload.copy(block, 1);
      res.write(Buffer.concat([audio, block]));
    } else {
      // First block empty ("unchanged"), the title arrives in the next interval.
      const empty = Buffer.from([0]);
      res.write(Buffer.concat([audio, empty, audio, metadataBlock("StreamTitle='Later Block Title';")]));
    }
    const filler = setInterval(() => res.write(Buffer.alloc(256)), 20);
    return res.on('close', () => clearInterval(filler));
  }

  const headers = {
    'Content-Type': 'audio/mpeg',
    'icy-name': 'Test FM',
    'icy-br': '128',
    'icy-genre': 'Jazz',
    'icy-metaint': String(METAINT),
  };
  res.writeHead(200, headers);

  const audio = Buffer.alloc(METAINT, 0x41);
  const block = metadataBlock("StreamTitle='Miles Davis - So What';StreamUrl='';");
  if (req.url === '/split') {
    // Deliver in awkward pieces so the reader cannot assume chunk boundaries.
    const whole = Buffer.concat([audio, block]);
    let offset = 0;
    const pump = () => {
      if (offset >= whole.length) return;
      res.write(whole.subarray(offset, offset + 100));
      offset += 100;
      setTimeout(pump, 1);
    };
    return pump();
  }
  res.write(Buffer.concat([audio, block]));
  // Keep streaming: a real station never ends, and the probe must hang up itself.
  const filler = setInterval(() => res.write(Buffer.alloc(256)), 20);
  res.on('close', () => clearInterval(filler));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

test('reads the current track and the station headers', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/stream`);

  assert.equal(station.title, 'Miles Davis - So What');
  assert.equal(station.name, 'Test FM');
  assert.equal(station.bitrate, '128');
  assert.equal(station.genre, 'Jazz');
  assert.equal(receivedIcyRequest, '1', 'the probe asks for metadata');
});

test('a title split across chunk boundaries still parses', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/split`);

  assert.equal(station.title, 'Miles Davis - So What');
});

test('a station without interleaved metadata returns headers, not an error', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/no-metadata`);

  assert.equal(station.title, '');
  assert.equal(station.name, 'Plain Station');
  assert.equal(station.bitrate, '96');
});

test('a per-channel user agent reaches the station', async () => {
  await probeNowPlaying(`${ORIGIN}/stream?ua=1`, 'CustomPlayer/2.0');

  assert.equal(receivedAgent, 'CustomPlayer/2.0');
});

test('repeat probes inside the TTL do not reopen the stream', async () => {
  const url = `${ORIGIN}/stream?cached=1`;
  await probeNowPlaying(url);
  receivedAgent = '__untouched__';

  const station = await probeNowPlaying(url);

  assert.equal(station.title, 'Miles Davis - So What');
  assert.equal(receivedAgent, '__untouched__', 'served from cache');
});

test('an upstream failure rejects rather than inventing metadata', async () => {
  await assert.rejects(() => probeNowPlaying(`${ORIGIN}/dead`), /upstream 404/);
});

// Regression: the value runs to the ICY `';` delimiter, not to the next quote.
// Matching to the quote truncated "Guns N' Roses …" to "Guns N".
test('a title containing apostrophes is not truncated', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/apostrophe`);

  assert.equal(station.title, "Guns N' Roses - Sweet Child O' Mine");
});

// Regression: Shoutcast v1 emits latin1, which decoded as UTF-8 became U+FFFD.
test('a latin1 title decodes instead of turning into replacement characters', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/latin1`);

  assert.equal(station.title, 'Björk - Jóga');
  assert.ok(!station.title.includes('�'));
});

// Regression: an empty block means "unchanged", not "no title" — the probe used
// to stop at the first one and report nothing.
test('a title in a later block is still found when the first is empty', async () => {
  const station = await probeNowPlaying(`${ORIGIN}/empty-first`);

  assert.equal(station.title, 'Later Block Title');
});

test('the same url probed with a different agent is not served from cache', async () => {
  const url = `${ORIGIN}/stream?agents=1`;
  await probeNowPlaying(url, 'AgentOne/1.0');
  await probeNowPlaying(url, 'AgentTwo/2.0');

  assert.equal(receivedAgent, 'AgentTwo/2.0', 'the second agent reached the station');
});
