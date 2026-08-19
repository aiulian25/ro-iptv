// The M3U parser's URL detection (server/lib/m3u.js).
//
// Anything that was not a `#` directive used to be accepted as a stream URL. Real
// playlists carry `;` section banners and stray notes, and each one became a
// phantom channel — unnamed, unplayable, and counted in the channel total. A
// 93-channel radio list was really 69 channels and 24 banners.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseM3U } from '../lib/m3u.js';

test('semicolon banners and stray text do not become channels', () => {
  const channels = parseM3U(
    [
      '#EXTM3U',
      '; ============================================',
      '; ROMANIA - PUBLIC',
      '; ============================================',
      '#EXTINF:-1 tvg-logo="http://example.com/a.png",Radio Romania',
      'http://example.com/live.mp3',
      'just some stray note',
      '#EXTINF:-1,Radio Two',
      'https://example.com/two.aac',
    ].join('\n'),
  );

  assert.equal(channels.length, 2);
  assert.deepEqual(
    channels.map((c) => c.name),
    ['Radio Romania', 'Radio Two'],
  );
  assert.equal(channels[0].logo, 'http://example.com/a.png');
});

test('every scheme a stream can legitimately use is still accepted', () => {
  const urls = [
    'http://example.com/a.ts',
    'https://example.com/b.m3u8',
    'rtmp://example.com/live/c',
    'rtsp://example.com/d',
    'udp://@239.0.0.1:1234',
    'rtp://239.0.0.2:5000',
  ];
  const channels = parseM3U(['#EXTM3U', ...urls.flatMap((u, i) => [`#EXTINF:-1,Ch ${i}`, u])].join('\n'));

  assert.equal(channels.length, urls.length);
  assert.deepEqual(
    channels.map((c) => c.url),
    urls,
  );
});

// A banner between the #EXTINF and its URL must not detach the two.
test('a banner between EXTINF and its URL keeps the metadata attached', () => {
  const channels = parseM3U(
    ['#EXTM3U', '#EXTINF:-1 tvg-id="X.ro",Named Channel', '; a stray banner', 'http://example.com/x.m3u8'].join('\n'),
  );

  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, 'Named Channel');
  assert.equal(channels[0].tvgId, 'X.ro');
});

test('a URL with no preceding EXTINF is still kept, with a generated name', () => {
  const channels = parseM3U(['#EXTM3U', 'http://example.com/bare.m3u8'].join('\n'));

  assert.equal(channels.length, 1);
  assert.match(channels[0].name, /^Channel \d+$/);
  assert.equal(channels[0].url, 'http://example.com/bare.m3u8');
});
