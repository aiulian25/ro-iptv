import { createHash, randomUUID } from 'node:crypto';
import { readCollection, restoreStateCollection } from './store.js';
import { withPlaylistConfiguration } from './playlists.js';
import { identityState } from './channel-identity.js';
import { remapReferences } from '../../shared/channel-identity.js';
import { isValidUrl, isBlockedTarget } from './http.js';

export const BACKUP_MAX_BYTES = 256 * 1024;
const previews = new Map(), TTL = 5 * 60_000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid backup structure');
}
function text(value, max = 256) { if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid backup text'); return value; }
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,220}$/.test(value);
const safeGuide = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) && !value.includes('://');
function bounded(value, max = BACKUP_MAX_BYTES) { let size; try { size = Buffer.byteLength(JSON.stringify(value)); } catch { fail('Invalid backup structure'); } if (size > max) fail(`Backup request exceeds ${max / 1024} KiB`, 413); }
function preferences(input) {
  object(input, ['refreshIntervalMinutes', 'defaultCountry', 'recordingPadding', 'epgView']);
  const { refreshIntervalMinutes, defaultCountry, recordingPadding, epgView } = input;
  if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 0 || refreshIntervalMinutes > 10080 || typeof defaultCountry !== 'string' || !/^(?:[a-z]{2})?$/i.test(defaultCountry) || !['list', 'grid'].includes(epgView)) fail('Invalid backup preferences');
  object(recordingPadding, ['before', 'after']);
  for (const key of ['before', 'after']) if (!Number.isInteger(recordingPadding[key]) || recordingPadding[key] < 0 || recordingPadding[key] > 60) fail('Invalid recording padding');
  return { refreshIntervalMinutes, defaultCountry, recordingPadding: { ...recordingPadding }, epgView };
}
export function validateBackup(archive) {
  bounded(archive); object(archive, ['format', 'version', 'preferences', 'guideSources', 'channels']);
  if (archive.format !== 'ro-iptv-config' || archive.version !== 1) fail('Unsupported backup format or version');
  preferences(archive.preferences);
  if (!Array.isArray(archive.guideSources) || archive.guideSources.length > 32 || archive.guideSources.some((key, i) => key !== 'guide-' + (i + 1))) fail('Invalid guide source placeholders');
  if (!Array.isArray(archive.channels) || archive.channels.length > 1000) fail('Invalid saved channel list');
  const seen = new Set();
  for (const row of archive.channels) {
    object(row, ['key', 'sourceChannelId', 'name', 'favourite', 'guideTarget', 'needsGuideTarget']);
    text(row.name, 120);
    if (!/^channel-\d+$/.test(row.key) || seen.has(row.key) || (row.sourceChannelId !== null && !safeId(row.sourceChannelId)) || typeof row.favourite !== 'boolean' || typeof row.needsGuideTarget !== 'boolean' || (row.guideTarget !== null && !safeGuide(row.guideTarget)) || (row.needsGuideTarget && row.guideTarget !== null)) fail('Invalid saved channel reference');
    if (!row.favourite && row.guideTarget === null && !row.needsGuideTarget) fail('Empty saved channel reference');
    seen.add(row.key);
  }
  return archive;
}
async function catalogue() {
  const state = await identityState();
  const playlists = ((await readCollection('playlists', { strict: true })) || []).filter(p => !p.deleted && p.enabled !== false);
  return { channels: state.channels.filter(c => playlists.some(p => p.id === c.playlistId)), aliases: state.aliases,
    fingerprint: hash([playlists.map(p => [p.id, p.revision, p.contentRevision]), state.channels.map(c => [c.id, c.name]), state.aliases]) };
}
export function exportConfiguration() {
  return withPlaylistConfiguration(async () => {
    const records = (await readCollection('state', { strict: true })) || [], catalog = await catalogue();
    const settings = remapReferences(records.find(r => r.key === 'settings')?.value || {}, 'settings', catalog.aliases, catalog.channels);
    const favourites = remapReferences(records.find(r => r.key === 'favourites')?.value || [], 'favourites', catalog.aliases, catalog.channels);
    if (!Array.isArray(favourites) || !settings || typeof settings !== 'object') fail('Saved configuration is invalid');
    const overrides = settings.epgOverrides || {}, ids = [...new Set([...favourites, ...Object.keys(overrides)])];
    const archive = { format: 'ro-iptv-config', version: 1, preferences: preferences({ refreshIntervalMinutes: settings.refreshIntervalMinutes ?? 360, defaultCountry: settings.defaultCountry ?? '', recordingPadding: settings.recordingPadding || { before: 1, after: 5 }, epgView: settings.epgView || 'list' }),
      guideSources: (Array.isArray(settings.epgUrls) ? settings.epgUrls : settings.epgUrl ? [settings.epgUrl] : []).filter(Boolean).map((_, i) => 'guide-' + (i + 1)),
      channels: ids.map((id, i) => {
        const name = catalog.channels.find(c => c.id === id)?.name || 'Saved channel ' + (i + 1);
        const target = overrides[id];
        return { key: 'channel-' + (i + 1), sourceChannelId: safeId(id) ? id : null,
          name: typeof name === 'string' && !name.includes('://') && !/[\x00-\x1f\x7f]/.test(name) ? name.slice(0, 120) || 'Saved channel' : 'Saved channel ' + (i + 1),
          favourite: favourites.includes(id), guideTarget: safeGuide(target) ? target : null, needsGuideTarget: target != null && !safeGuide(target) };
      }) };
    return validateBackup(archive);
  });
}
function expire() { for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id); }
export function previewConfiguration(body) {
  return withPlaylistConfiguration(async () => {
    bounded(body, BACKUP_MAX_BYTES * 2); object(body, ['archive', 'channels', 'guideUrls', 'guideTargets']);
    const archive = validateBackup(body.archive), catalog = await catalogue();
    const mappings = body.channels || {}, guideUrls = body.guideUrls || {}, guideTargets = body.guideTargets || {};
    object(mappings, archive.channels.map(r => r.key)); object(guideUrls, archive.guideSources); object(guideTargets, archive.channels.filter(r => r.needsGuideTarget).map(r => r.key));
    const favourites = [], epgOverrides = Object.create(null), epgUrls = [], used = new Set();
    const unresolved = { channels: [], guideUrls: [], guideTargets: [] };
    for (const row of archive.channels) {
      const id = Object.hasOwn(mappings, row.key) ? mappings[row.key] : (catalog.channels.some(c => c.id === row.sourceChannelId) ? row.sourceChannelId : '');
      if (!id) { unresolved.channels.push(row.key); continue; }
      if (!catalog.channels.some(c => c.id === id)) fail('A mapped channel is unavailable; reload sources before preview');
      if (used.has(id)) fail('Each saved channel must map to a different destination');
      used.add(id); if (row.favourite) favourites.push(id);
      if (row.needsGuideTarget) {
        const target = guideTargets[row.key];
        if (!target) unresolved.guideTargets.push(row.key);
        else { text(target); epgOverrides[id] = target; }
      } else if (row.guideTarget !== null) epgOverrides[id] = row.guideTarget;
    }
    for (const key of archive.guideSources) {
      const url = guideUrls[key];
      if (!url) unresolved.guideUrls.push(key);
      else {
        text(url, 4096);
        if (!isValidUrl(url) || isBlockedTarget(url) || /[\x00-\x20\x7f]/.test(url) || /\{\{|REDACTED|REPLACE_ME/i.test(url)) fail('Enter a complete permitted HTTP(S) guide URL; placeholders cannot be restored');
        epgUrls.push(new URL(url).href);
      }
    }
    const counts = { preferences: 4, favourites: archive.channels.filter(r => r.favourite).length, manualLinks: archive.channels.filter(r => r.guideTarget !== null || r.needsGuideTarget).length, guideSources: archive.guideSources.length };
    const canRestore = Object.values(unresolved).every(list => !list.length);
    let previewId = null;
    if (canRestore) {
      const records = (await readCollection('state', { strict: true })) || [];
      const settings = { ...archive.preferences, epgUrls, epgOverrides };
      bounded(settings); bounded(favourites);
      expire(); while (previews.size >= 16) previews.delete(previews.keys().next().value);
      previewId = randomUUID(); previews.set(previewId, { stateHash: hash(records), catalogHash: catalog.fingerprint, settings, favourites, counts, expires: Date.now() + TTL });
    }
    return { canRestore, counts, unresolved, previewId, expiresInSeconds: canRestore ? TTL / 1000 : 0,
      excluded: ['Auth and sessions', 'All source URLs and headers', 'Playlist contents and local stations', 'History', 'Recordings and media', 'Environment configuration'] };
  });
}
export function restoreConfiguration(body) {
  return withPlaylistConfiguration(async () => {
    object(body, ['previewId', 'confirmed']); expire();
    if (body.confirmed !== true || typeof body.previewId !== 'string') fail('Review and explicitly confirm a restore preview');
    const staged = previews.get(body.previewId);
    if (!staged) fail('Restore preview expired or was already used; preview again', 409);
    previews.delete(body.previewId);
    await restoreStateCollection(async records => {
      const catalog = await catalogue();
      if (hash(records) !== staged.stateHash || catalog.fingerprint !== staged.catalogHash) fail('Configuration or sources changed after preview; preview again', 409);
      const now = new Date(Math.max(Date.now(), ...records.map(r => (Date.parse(r.updatedAt) || 0) + 1))).toISOString();
      const settings = { ...(records.find(r => r.key === 'settings')?.value || {}), ...staged.settings };
      delete settings.epgUrl; bounded(settings);
      return [...records.filter(r => !['settings', 'favourites'].includes(r.key)), { key: 'settings', value: settings, updatedAt: now }, { key: 'favourites', value: staged.favourites, updatedAt: now }];
    });
    return { ok: true, counts: staged.counts };
  });
}
