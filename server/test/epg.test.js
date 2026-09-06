// XMLTV parsing (server/lib/epg.js).
//
// Every guide-offset bug lives in parseXmltvDate, which is not exported — so the
// timestamps are exercised through parseEPG's `@_start`, the same way the app does.
// Stamps here are literal rather than generated (as in epgstore.test.js, which cares
// about *when* a programme is): the conversion itself is what is under test.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEPG } from '../lib/epg.js';

const CHANNEL_ID = 'c1';
const STOP_STAMP = '20240115220000 +0000';

// One programme on one channel, with whatever start stamp the case needs.
function guideXml(startStamp, extraProgrammeXml = '') {
  return (
    `<tv><channel id="${CHANNEL_ID}"><display-name>One</display-name></channel>` +
    `<programme channel="${CHANNEL_ID}" start="${startStamp}" stop="${STOP_STAMP}">` +
    `<title>Programme</title>${extraProgrammeXml}` +
    `</programme></tv>`
  );
}

const firstProgramme = (xml) => parseEPG(xml).programmes[CHANNEL_ID][0];
const startOf = (stamp) => firstProgramme(guideXml(stamp)).start;

test('a lone <channel> and <programme> parse as well as arrays of them', () => {
  const { channels, programmes } = parseEPG(
    `<tv><channel id="${CHANNEL_ID}"><display-name>One</display-name><icon src="http://i/1.png"/></channel>` +
      `<programme channel="${CHANNEL_ID}" start="20240115200000 +0000" stop="${STOP_STAMP}">` +
      `<title>Solo</title></programme></tv>`
  );

  assert.deepEqual(Object.keys(channels), [CHANNEL_ID]);
  assert.equal(channels[CHANNEL_ID].name, 'One');
  assert.equal(channels[CHANNEL_ID].icon, 'http://i/1.png');
  assert.equal(programmes[CHANNEL_ID].length, 1);
  assert.equal(programmes[CHANNEL_ID][0].title, 'Solo');
});

test('a UTC offset in the stamp is applied', () => {
  assert.equal(startOf('20240115203000 +0200'), '2024-01-15T18:30:00.000Z');
  assert.equal(startOf('20240115203000 -0500'), '2024-01-16T01:30:00.000Z');
  // The same instant written two ways must land on the same instant.
  assert.equal(startOf('20240115203000 +0200'), startOf('20240115183000 +0000'));
  // Some guides omit the space before the offset.
  assert.equal(startOf('20240115203000+0200'), '2024-01-15T18:30:00.000Z');
});

test('a stamp without seconds parses as :00', () => {
  assert.equal(startOf('202401152030 +0200'), '2024-01-15T18:30:00.000Z');
});

// A stamp carrying no offset is read as the SERVER's local time, so its instant
// depends on the host clock. Deliberately not pinned to a literal — asserting one
// would pass in the UTC container and fail on a developer's machine.
test('a stamp without an offset still yields a valid instant', () => {
  const start = startOf('20240115203000');

  assert.ok(start, 'must not be null');
  assert.equal(start, new Date(start).toISOString(), 'must be a real ISO instant');
  assert.match(start, /^2024-01-1[56]T/);
});

test('an unparseable stamp becomes null rather than an invalid date', () => {
  // The last three are the right shape but not a real date — the parser's isNaN
  // guard is what stops them becoming an Invalid Date downstream.
  const unparseable = [
    'not-a-date',
    '',
    '2024011520',
    '0000',
    '20241315203000 +0000',
    '20240132203000 +0000',
    '20240115253000 +0000',
  ];
  for (const stamp of unparseable) {
    const programme = firstProgramme(guideXml(stamp));
    assert.equal(programme.start, null, JSON.stringify(stamp));
    // The programme itself is still kept — a bad stamp must not drop the entry.
    assert.equal(programme.title, 'Programme');
  }
});

test('programmes come back sorted by start, whatever order the guide lists them in', () => {
  const { programmes } = parseEPG(
    `<tv><channel id="${CHANNEL_ID}"><display-name>One</display-name></channel>` +
      ['22', '20', '23', '21']
        .map(
          (hour) =>
            `<programme channel="${CHANNEL_ID}" start="20240115${hour}0000 +0000" ` +
            `stop="${STOP_STAMP}"><title>At ${hour}</title></programme>`
        )
        .join('') +
      `</tv>`
  );

  assert.deepEqual(
    programmes[CHANNEL_ID].map((p) => p.title),
    ['At 20', 'At 21', 'At 22', 'At 23']
  );
});

test('an <icon> takes the first src whether it is a single node or a list', () => {
  const single = parseEPG(guideXml('20240115200000 +0000', '<icon src="http://i/only.png"/>'));
  assert.equal(single.programmes[CHANNEL_ID][0].icon, 'http://i/only.png');

  const many = parseEPG(
    guideXml('20240115200000 +0000', '<icon src="http://i/first.png"/><icon src="http://i/second.png"/>')
  );
  assert.equal(many.programmes[CHANNEL_ID][0].icon, 'http://i/first.png');

  const none = parseEPG(guideXml('20240115200000 +0000'));
  assert.equal(none.programmes[CHANNEL_ID][0].icon, '');
});

test('a <rating> is read from its nested <value>, not the element itself', () => {
  const programme = firstProgramme(
    guideXml('20240115200000 +0000', '<rating system="RO"><value>12</value></rating>')
  );

  assert.equal(programme.rating, '12');
  assert.equal(firstProgramme(guideXml('20240115200000 +0000')).rating, '');
});

// parseEPG runs on bytes downloaded from a third-party guide URL, so a malformed
// document must come back empty rather than throw and take the refresh down.
test('documents with nothing usable in them parse to empty maps', () => {
  for (const xml of ['', 'this is not xml', '<other><channel id="c1"/></other>', '<tv></tv>']) {
    assert.deepEqual(parseEPG(xml), { channels: {}, programmes: {} }, JSON.stringify(xml));
  }

  // Nodes the parser cannot key on are skipped, not half-inserted.
  assert.deepEqual(parseEPG('<tv><channel><display-name>X</display-name></channel></tv>').channels, {});
  assert.deepEqual(
    parseEPG(`<tv><programme start="20240115200000 +0000"><title>X</title></programme></tv>`).programmes,
    {}
  );
});

// Guide XML is remote input. Both classic XML attacks are refused by the parser's
// configuration; this pins that, since a future option change could re-enable them.
test('entity expansion cannot be used to blow up or read the host', () => {
  const nestedEntities =
    `<?xml version="1.0"?><!DOCTYPE tv [` +
    `<!ENTITY a "aaaaaaaaaa">` +
    `<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">` +
    `<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">` +
    `<!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">` +
    `<!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">` +
    `]><tv><channel id="${CHANNEL_ID}"><display-name>&e;</display-name></channel></tv>`;

  // Not expanded: the name stays the reference itself, not 10^5 characters.
  assert.ok(parseEPG(nestedEntities).channels[CHANNEL_ID].name.length < 16);

  const externalEntity =
    `<?xml version="1.0"?><!DOCTYPE tv [<!ENTITY xxe SYSTEM "file:///etc/hostname">]>` +
    `<tv><channel id="${CHANNEL_ID}"><display-name>&xxe;</display-name></channel></tv>`;

  assert.throws(() => parseEPG(externalEntity), /External entities are not supported/);
});
