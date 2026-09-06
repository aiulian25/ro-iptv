// One realistic playlist through the one parser (shared/m3u.js).
//
// This began as a parity test: server/lib/m3u.js and client/src/lib/m3u.js were
// hand-kept copies, and F3 shipped a fix to only one of them — the same playlist
// counted 93 channels in the browser and 69 on the server. There is now a single
// module, so there is nothing left to compare; what remains worth keeping is the
// fixture, which covers every shape the parser has been broken by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseM3U } from '../../shared/m3u.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures/playlist.m3u');

const playlist = await fs.readFile(FIXTURE, 'utf8');
const channels = parseM3U(playlist);

test('the fixture exercises every parser feature it was written for', () => {
  const byName = Object.fromEntries(channels.map((channel) => [channel.name, channel]));

  assert.equal(channels.length, 9, 'banners, notes and directives must not become channels');
  assert.ok(byName['Antena 1, HD'], 'a comma inside the name');
  assert.ok(byName['Pro TV "Live" Edition'], 'a quoted phrase inside the name');
  assert.equal(byName['Antena 1, HD'].chno, 4, 'tvg-chno');
  assert.equal(byName['Pro TV "Live" Edition'].httpUserAgent, 'Mozilla/5.0 (SmartTV)', '#EXTVLCOPT user agent');
  assert.equal(byName['Pro TV "Live" Edition'].httpReferrer, 'https://protv.example/', '#EXTVLCOPT referrer');
  assert.equal(byName['Digi 24'].catchup, 'shift', 'catchup');
  assert.equal(byName['Digi 24'].catchupDays, 7, 'catchup-days');
  assert.equal(byName['Digi 24'].tvgShift, -1.5, 'tvg-shift');
  assert.equal(byName['Europa FM'].radio, true, 'radio="true"');
  assert.equal(byName['Europa FM'].kind, 'radio');
  assert.equal(byName['Radio Without Attributes'].kind, 'radio', 'kind guessed from the name');
  assert.equal(byName['Fallback Name Only'].name, 'Fallback Name Only', 'name falling back to tvg-name');
  assert.equal(byName['Grouped By Directive'].group, 'RO | Sport', '#EXTGRP overriding group-title');
  assert.equal(byName['Legacy RTMP'].url, 'rtmp://legacy.example/live/stream', 'a non-http scheme');
  assert.ok(
    channels.some((channel) => /^Channel \d+$/.test(channel.name)),
    'a bare URL with no #EXTINF'
  );
});

test('no banner, note or directive is turned into a channel', () => {
  const bannerCount = playlist.split('\n').filter((line) => line.trim().startsWith(';')).length;

  assert.ok(bannerCount >= 5, 'the fixture must still contain banners to be meaningful');
  assert.equal(channels.filter((channel) => !channel.url).length, 0, 'every channel must have a URL');
  assert.equal(
    channels.filter((channel) => channel.url.startsWith(';')).length,
    0,
    'no banner may have been read as a stream URL'
  );
});

// Channel ids are the join key between a playlist parsed in the browser and the same
// file re-parsed on the server (favourites, EPG overrides and recordings are keyed by
// them). One module now guarantees that; this pins that they are stable and unique.
test('channel ids are stable across parses and unique within a playlist', () => {
  const ids = channels.map((channel) => channel.id);

  assert.equal(new Set(ids).size, ids.length, 'no two channels may share an id');
  assert.deepEqual(
    parseM3U(playlist).map((channel) => channel.id),
    ids,
    'parsing the same bytes twice must give the same ids'
  );
});
