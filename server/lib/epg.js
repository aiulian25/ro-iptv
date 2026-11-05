// XMLTV EPG parser. Converts XMLTV documents into a per-channel programme map.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  // Keep built-in/numeric XML entities; custom DTD entities are refused below.
  processEntities: true,
  htmlEntities: true,
  maxNestedTags: 100,
});

// XMLTV uses UTC when no zone is supplied. Accept complete leading fields,
// retaining precision so coarse listings cannot silently schedule a recording.
function parseXmltvDate(value) {
  const match = String(value || '').trim().match(/^(\d{4}(?:\d{2}){0,5})\s*(Z|UTC|GMT|BST|[+-]\d{4})?$/);
  if (!match) return null;
  const [, digits, zone = 'UTC'] = match;
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] =
    [digits.slice(0, 4), ...digits.slice(4).match(/../g) || []].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offset = zone === 'BST' ? 60 : 0;
  if (/^[+-]/.test(zone)) {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(3));
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
  }
  date.setTime(date.getTime() - offset * 60_000);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return { iso: date.toISOString(), precision: digits.length };
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return node['#text'] || '';
  return String(node);
}

// XMLTV <icon> may be a single node or an array; return the first src (or '').
function iconSrc(node) {
  const first = Array.isArray(node) ? node[0] : node;
  return first?.['@_src'] || '';
}

/**
 * Parse XMLTV text into { channels: {id: {name, icon}}, programmes: {channelId: [{...}]} }
 */
export function parseEPG(xml = '') {
  // XMLTV commonly declares an external xmltv.dtd. It is metadata only: never
  // fetch it. Reject internal subsets, entity declarations and repeated DTDs.
  const declarations = xml.match(/<!DOCTYPE\b[^>]*>/gi) || [];
  if (/<!ENTITY\b/i.test(xml) || declarations.length > 1 ||
      declarations.some((d) => !/^<!DOCTYPE\s+tv(?:\s+SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*'))?\s*>$/i.test(d))) {
    throw new Error('Unsupported XMLTV DTD or entity declaration');
  }
  const doc = parser.parse(xml);
  const tv = doc.tv || {};
  const channels = {};
  const programmes = {};
  let invalid = 0;
  const rejectedStarts = new Map();

  const chanList = Array.isArray(tv.channel) ? tv.channel : tv.channel ? [tv.channel] : [];
  for (const c of chanList) {
    const id = c['@_id'];
    if (!id) continue;
    Object.defineProperty(channels, id, { value: { name: textOf(c['display-name']), icon: iconSrc(c.icon) }, enumerable: true, writable: true, configurable: true });
  }

  const progList = Array.isArray(tv.programme) ? tv.programme : tv.programme ? [tv.programme] : [];
  for (const p of progList) {
    const channelId = p['@_channel'];
    const start = parseXmltvDate(p['@_start']);
    const suppliedStop = Object.hasOwn(p, '@_stop');
    const stop = suppliedStop ? parseXmltvDate(p['@_stop']) : null;
    if (!channelId || !start || (suppliedStop && (!stop || stop.iso <= start.iso))) {
      invalid++;
      if (channelId && start) {
        if (!rejectedStarts.has(channelId)) rejectedStarts.set(channelId, []);
        rejectedStarts.get(channelId).push(Date.parse(start.iso));
      }
      continue;
    }
    const entry = {
      title: textOf(p.title),
      subTitle: textOf(p['sub-title']),
      desc: textOf(p.desc),
      category: textOf(p.category),
      episode: textOf(p['episode-num']),
      date: textOf(p.date),
      rating: textOf(p.rating?.value),
      icon: iconSrc(p.icon),
      start: start.iso,
      stop: stop?.iso || null,
      startPrecision: start.precision,
      stopPrecision: stop?.precision || null,
      endStatus: stop ? 'explicit' : 'unknown',
      timeUncertain: start.precision < 12 || (stop != null && stop.precision < 12),
    };
    if (!Object.hasOwn(programmes, channelId)) Object.defineProperty(programmes, channelId, { value: [], enumerable: true, writable: true, configurable: true });
    programmes[channelId].push(entry);
  }

  for (const [id, list] of Object.entries(programmes)) {
    list.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const counts = new Map();
    for (const entry of list) counts.set(entry.start, (counts.get(entry.start) || 0) + 1);
    const barriers = (rejectedStarts.get(id) || []).sort((a, b) => a - b);
    let priorStop = -Infinity, barrierIndex = 0;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i], next = list[i + 1], start = Date.parse(entry.start);
      while (barrierIndex < barriers.length && barriers[barrierIndex] < start) barrierIndex++;
      // Equal-start/clumped or overlapping listings are ambiguous. Do not infer
      // through a rejected record or from coarse timestamps either.
      if (!entry.stop && next && counts.get(entry.start) === 1 && counts.get(next.start) === 1 &&
          !entry.timeUncertain && next.startPrecision >= 12 && priorStop <= start &&
          !(barriers[barrierIndex] <= Date.parse(next.start))) {
        entry.stop = next.start; entry.stopPrecision = next.startPrecision; entry.endStatus = 'inferred';
      }
      if (entry.stop) priorStop = Math.max(priorStop, Date.parse(entry.stop));
    }
  }
  // One aggregate message per document, with no provider strings or per-row log
  // amplification. Other valid records remain usable.
  if (invalid) console.warn(`epg: ignored ${invalid} invalid programme record(s)`);

  return { channels, programmes };
}

export default parseEPG;
