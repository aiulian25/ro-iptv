// Generate the iptv-org grabber's channels.xml from the user's own channel set.
//
// The sidecar container grabs whatever this file lists, so listing exactly the
// channels this install has — and nothing else — is what makes the resulting
// guide "precision" rather than a country pack that mostly misses.
//
// Site choice is by COVERAGE: the site that carries the most of this user's
// channels wins, which collapses the grab onto as few sites as possible (for a
// Romanian list, programetv.ro alone carries 93 of 94 mappable channels). The
// plan called for preferring the country's language, but countries.json stores
// ISO 639-3 ("ron") while guides.json stores 639-1 ("ro"), so that comparison
// could never match; coverage is the stronger signal anyway, with the site name
// as a deterministic tie-break.
import { promises as fs } from 'fs';
import path from 'path';

import { writeFileAtomic, writeCollection, readCollection, DATA_DIR } from './store.js';
import { normalizeName, channelIdCandidates } from './epgmatch.js';
import { loadIptvOrgIndex } from './iptvorg.js';

const SIDECAR_COLLECTION = 'epg-sidecar';
const CHANNELS_XML_DIR = path.join(DATA_DIR, 'epg');
const CHANNELS_XML_PATH = path.join(CHANNELS_XML_DIR, 'channels.xml');
// Enough to show the user what the sidecar will not cover, not the whole tail.
const MAX_UNMAPPED_SAMPLE = 20;

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// Channel names and site ids reach this file from playlists and from the
// iptv-org dataset; both are escaped so neither can break the document.
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => XML_ENTITIES[character]);
}

// Which iptv-org channel a wanted channel is: its tvg-id when that is already an
// iptv-org id, else a normalized name match within its own country.
function resolveIptvOrgChannel(wantedChannel, index) {
  for (const candidate of channelIdCandidates(wantedChannel.tvgId)) {
    const byId = index.byId.get(candidate);
    if (byId) return byId;
  }
  const names = index.byCountryName.get(wantedChannel.country);
  if (!names) return null;
  return names.get(normalizeName(wantedChannel.tvgName || wantedChannel.name)) || null;
}

/**
 * Decide what the sidecar should grab.
 * @returns {{entries: Array, mapped: number, unmapped: string[], sites: Array}}
 */
export function planChannelsXml(wantedChannels, index) {
  const candidatesByChannel = new Map();
  const unmapped = [];
  const siteCoverage = new Map();
  // Counted separately from the emitted entries: an HD and an SD variant are two
  // covered channels but one thing for the grabber to fetch.
  let matchedChannels = 0;

  for (const wantedChannel of wantedChannels) {
    if (!wantedChannel.country) continue;
    const iptvOrgChannel = resolveIptvOrgChannel(wantedChannel, index);
    const guides = iptvOrgChannel && index.guidesByChannel.get(iptvOrgChannel.id);
    if (!guides || !guides.length) {
      unmapped.push(wantedChannel.name);
      continue;
    }
    matchedChannels += 1;
    if (candidatesByChannel.has(iptvOrgChannel.id)) continue;
    candidatesByChannel.set(iptvOrgChannel.id, { channel: iptvOrgChannel, guides });
    for (const guide of new Set(guides.map((g) => g.site))) {
      siteCoverage.set(guide, (siteCoverage.get(guide) || 0) + 1);
    }
  }

  const entries = [];
  for (const { channel, guides } of candidatesByChannel.values()) {
    const best = [...guides].sort((a, b) => {
      const coverage = (siteCoverage.get(b.site) || 0) - (siteCoverage.get(a.site) || 0);
      if (coverage !== 0) return coverage;
      return a.site.localeCompare(b.site) || a.siteId.localeCompare(b.siteId);
    })[0];
    entries.push({ site: best.site, lang: best.lang, xmltvId: channel.id, siteId: best.siteId, name: channel.name });
  }
  entries.sort((a, b) => a.site.localeCompare(b.site) || a.xmltvId.localeCompare(b.xmltvId));

  const sites = [...new Set(entries.map((entry) => entry.site))].map((site) => ({
    site,
    channels: entries.filter((entry) => entry.site === site).length,
  }));

  return { entries, mapped: entries.length, matchedChannels, unmapped, sites };
}

/** Serialise a plan into the grabber's channels.xml format. */
export function renderChannelsXml(entries) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>'];
  for (const entry of entries) {
    lines.push(
      `  <channel site="${escapeXml(entry.site)}" lang="${escapeXml(entry.lang)}"` +
        ` xmltv_id="${escapeXml(entry.xmltvId)}" site_id="${escapeXml(entry.siteId)}">` +
        `${escapeXml(entry.name)}</channel>`
    );
  }
  lines.push('</channels>', '');
  return lines.join('\n');
}

/**
 * Make sure the grabber's input file exists, empty if need be.
 *
 * A container that mounts a path which is not there yet fails to START — not to
 * read — so the sidecar cannot wait for the first real generation, which has to
 * download a large dataset before it can write anything. This runs at boot and
 * costs nothing; the real list replaces it a minute later.
 */
export async function ensureChannelsXmlExists() {
  await fs.mkdir(CHANNELS_XML_DIR, { recursive: true });
  try {
    await fs.access(CHANNELS_XML_PATH);
  } catch {
    await writeFileAtomic(CHANNELS_XML_PATH, renderChannelsXml([]));
  }
}

/**
 * Build DATA_DIR/epg/channels.xml from the wanted-channels index and persist a
 * summary of what was mapped. Returns that summary.
 */
export async function generateChannelsXml(wanted) {
  const generatedAt = new Date().toISOString();
  const inScope = wanted.channels.filter((channel) => channel.country);
  if (!inScope.length) {
    return persistSummary({
      generatedAt,
      written: false,
      mapped: 0,
      matchedChannels: 0,
      total: 0,
      unmapped: [],
      unmappedCount: 0,
      sites: [],
    });
  }

  const index = await loadIptvOrgIndex(wanted.countries);
  const plan = planChannelsXml(inScope, index);

  await fs.mkdir(CHANNELS_XML_DIR, { recursive: true });
  await writeFileAtomic(CHANNELS_XML_PATH, renderChannelsXml(plan.entries));

  return persistSummary({
    generatedAt,
    written: true,
    // `mapped` is what the grabber will fetch; `matchedChannels` is how many of
    // the user's channels that covers — they differ wherever variants collapse.
    mapped: plan.mapped,
    matchedChannels: plan.matchedChannels,
    total: inScope.length,
    unmapped: plan.unmapped.slice(0, MAX_UNMAPPED_SAMPLE),
    unmappedCount: plan.unmapped.length,
    sites: plan.sites,
  });
}

async function persistSummary(summary) {
  await writeCollection(SIDECAR_COLLECTION, [summary]);
  return summary;
}

/** The last generation summary, or null if channels.xml has never been built. */
export async function readSidecarSummary() {
  return (await readCollection(SIDECAR_COLLECTION))[0] || null;
}

export { CHANNELS_XML_PATH };
