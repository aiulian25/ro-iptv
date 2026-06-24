// XMLTV EPG parser. Converts XMLTV documents into a per-channel programme map.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

// XMLTV timestamps look like: 20240115203000 +0000
function parseXmltvDate(value) {
  if (!value) return null;
  const m = String(value).match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz) iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return node['#text'] || '';
  return String(node);
}

/**
 * Parse XMLTV text into { channels: {id: displayName}, programmes: {channelId: [{...}]} }
 */
export function parseEPG(xml = '') {
  const doc = parser.parse(xml);
  const tv = doc.tv || {};
  const channels = {};
  const programmes = {};

  const chanList = Array.isArray(tv.channel) ? tv.channel : tv.channel ? [tv.channel] : [];
  for (const c of chanList) {
    const id = c['@_id'];
    if (!id) continue;
    channels[id] = textOf(c['display-name']);
  }

  const progList = Array.isArray(tv.programme) ? tv.programme : tv.programme ? [tv.programme] : [];
  for (const p of progList) {
    const channelId = p['@_channel'];
    if (!channelId) continue;
    const entry = {
      title: textOf(p.title),
      desc: textOf(p.desc),
      category: textOf(p.category),
      start: parseXmltvDate(p['@_start']),
      stop: parseXmltvDate(p['@_stop']),
    };
    if (!programmes[channelId]) programmes[channelId] = [];
    programmes[channelId].push(entry);
  }

  // Sort each channel's programmes by start time.
  for (const id of Object.keys(programmes)) {
    programmes[id].sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  return { channels, programmes };
}

export default parseEPG;
