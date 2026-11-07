import { exportConfiguration, previewConfiguration, restoreConfiguration } from './lib/configBackup.js';
import { sidecarUrl } from './lib/sidecar.js';
import { canonicalStateValue, registerChannelAliases, recordingIdentity } from './lib/channel-identity.js';
import { listPlaylists, savePlaylist, commitPlaylistFile, deletePlaylist, listLocalStations, changeLocalStation } from './lib/playlists.js';
import { safeDiagnostic, sourceId, requestDiagnostic } from './lib/redact.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import { createRequire } from 'module';

import { parseM3U } from '../shared/m3u.js';
import { programmeInWindow } from '../shared/epg-time.js';
import {
  readCollection,
  writeCollection,
  updateCollection,
  playlistFilePath,
  DATA_DIR,
} from './lib/store.js';
import { FETCH_HEADERS, isValidUrl, isBlockedTarget, fetchToBuffer } from './lib/http.js';
import { getWantedChannels, markWantedChannelsDirty, readPlaylistChannels } from './lib/channels.js';
import { suggestionsForCountries } from './lib/epgsources.js';
import { matchGuideToChannels, matchAll, buildAltNameIndex } from './lib/epgmatch.js';
import { loadIptvOrgIndex, warmIptvOrgDataset } from './lib/iptvorg.js';
import { probeNowPlaying } from './lib/icy.js';
import { generateChannelsXml, ensureChannelsXmlExists, readSidecarSummary } from './lib/channelsxml.js';
import { proxyExtra } from './lib/manifest.js';
import { createStreamProxy } from './lib/proxy.js';
import { sendRecordingFile } from './lib/recording-http.js';
import {
  fetchAndParseGuide,
  getMergedGuide,
  getMergedGuideSnapshot,
  epgSourceRevision,
  configuredEpgUrls,
  refreshAll,
  readSourceHealth,
} from './lib/epgstore.js';
import {
  COOKIE,
  revokeRequestSession,
  REMEMBER_DAYS,
  isAuthEnabled,
  initAuth,
  verifyCredentials,
  issueToken,
  userFromRequest,
  currentUsername,
  needsPasswordChange,
  setPassword,
} from './lib/auth.js';
import {
  startCapture,
  validateRecordingMinutes,
  RECORDING_STOP_GRACE_MS,
  stopCapture,
  stopAll,
  isRecording,
  currentSize,
  resolveFile,
  fileNameFor,
  isValidRecordingId,
  isValidRecordingWindow,
  recordingsDir,
} from './lib/recorder.js';

// The single source of truth for the version. createRequire rather than a JSON import
// attribute: the runtime image is node 20, where that syntax is not dependable.
const { version: APP_VERSION } = createRequire(import.meta.url)('./package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '56892', 10);
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

const app = express();
// Express 4 does not catch a rejected async handler: the request would hang until the
// client gives up. Every async route is wrapped so a rejection reaches the API error
// handler below instead.
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
app.disable('x-powered-by');
// How many reverse-proxy hops sit in front of this process (Express "trust proxy").
// Default 0 = none: req.ip is the socket peer and X-Forwarded-* is ignored, so a
// client cannot spoof its address past the rate limiter. Behind a TLS proxy set
// TRUST_PROXY=1 (or the proxy's IP/CIDR) — that is also what makes req.secure true,
// which the session cookie's Secure flag depends on.
const TRUST_PROXY = process.env.TRUST_PROXY || '';
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? parseInt(TRUST_PROXY, 10) : TRUST_PROXY || false);

// ---- Security headers (§4) -----------------------------------
// CSP is tuned to this app: scripts are external-only (no inline JS), but React
// style props need inline styles, and logos/media come from arbitrary IPTV
// origins. Cross-origin isolation is OFF because the app embeds cross-origin
// media/images and the proxy serves with ACAO:* — COEP/strict CORP would break it.
const HSTS_MAX_AGE = parseInt(process.env.HSTS_MAX_AGE || '15552000', 10); // 180 days
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        // Inline style props (dynamic widths, floating-box geometry). Fonts are
        // served from this origin, so no third-party font host is allowed.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        // Channel / station logos load from arbitrary http(s) hosts.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        // Media is proxied (same-origin) but allow direct streams + MSE blobs.
        mediaSrc: ["'self'", 'blob:', 'data:', 'https:', 'http:'],
        workerSrc: ["'self'", 'blob:'], // HLS.js transmux worker
        manifestSrc: ["'self'"],
        // API is same-origin; weather + IP-geo are the only direct third parties.
        connectSrc: [
          "'self'",
          'https://api.open-meteo.com',
          'https://geocoding-api.open-meteo.com',
          'https://get.geojs.io',
          'https://ipwho.is',
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Honored only over HTTPS (behind the TLS reverse proxy); inert on plain HTTP.
    hsts: { maxAge: HSTS_MAX_AGE, includeSubDomains: false, preload: false },
  })
);

// Permissions-Policy: deny powerful features the app never uses; keep the ones
// it does (geolocation → weather, fullscreen, picture-in-picture, autoplay).
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), fullscreen=(self), picture-in-picture=(self), autoplay=(self), ' +
      'camera=(), microphone=(), usb=(), payment=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  next();
});

// ---- Rate limiting (§4) --------------------------------------
// Applied ONLY to abuse-prone endpoints: upstream fetches (playlist/EPG/parse)
// and writes. Playback (/api/proxy), media streaming, health and polled list
// GETs are intentionally UNLIMITED so streaming and live UI updates are never
// throttled. Tune via RL_* env; disable entirely with RATE_LIMIT_DISABLED=1.
const RL_DISABLED = process.env.RATE_LIMIT_DISABLED === '1';
const passthrough = (req, res, next) => next();
function makeLimiter(max, windowMs = 60_000) {
  if (RL_DISABLED) return passthrough;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  });
}
const upstreamLimiter = makeLimiter(parseInt(process.env.RL_UPSTREAM_MAX || '120', 10));
const writeLimiter = makeLimiter(parseInt(process.env.RL_WRITE_MAX || '120', 10));
// Stricter limiter for the login endpoint to blunt brute-force / credential stuffing.
const loginLimiter = RL_DISABLED
  ? passthrough
  : rateLimit({
      windowMs: 15 * 60_000,
      max: parseInt(process.env.RL_LOGIN_MAX || '10', 10),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many login attempts. Try again in a few minutes.' },
    });

// ---- CORS allowlist ------------------------------------------------------
// CORS_ALLOWED_ORIGINS: comma-separated domains/origins allowed to call the API
// cross-origin. Entries may be a full origin, a host, or host:port, with or
// without scheme (e.g. "tv.example.com, http://192.168.0.10:56892, 10.0.0.5").
// Unset or "*" → allow any origin to READ (default; the app itself is same-origin
// anyway). Mutations are stricter: only the request's own origin or an explicit
// entry, never "*" and never an empty list.
const CORS_ALLOWLIST = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function hostPort(value) {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function isOriginAllowed(origin) {
  if (!CORS_ALLOWLIST.length || CORS_ALLOWLIST.includes('*')) return true;
  if (!origin) return true; // same-origin / server-to-server requests send no Origin
  const o = hostPort(origin);
  const oHost = o.split(':')[0];
  return CORS_ALLOWLIST.some((entry) => {
    const e = hostPort(entry);
    if (e === o) return true; // exact host or host:port
    if (!e.includes(':') && e === oHost) return true; // host-only entry → any port
    return false;
  });
}

// Does an explicit entry cover this origin, for a *mutation*? An entry naming a
// scheme must match exactly, so listing https://host does not also admit
// http://host. A schemeless entry (host or host:port) matches either scheme — the
// form the comment above documents, and the form the CORS check already accepts.
// The two disagreed in 1.4.x: a documented "host:port" entry passed CORS and was
// silently ignored for every mutation, so a configured client got 403 on each write.
// "*" and an empty list match nothing here: absent configuration must never mean
// "any site may write".
function allowlistPermitsMutation(parsedOrigin) {
  const target = hostPort(parsedOrigin.origin);
  const targetHost = target.split(':')[0];
  return CORS_ALLOWLIST.some((entry) => {
    if (entry === '*') return false;
    if (/^https?:\/\//i.test(entry)) return new URL(entry).origin === parsedOrigin.origin;
    const e = hostPort(entry);
    if (e === target) return true; // exact host or host:port
    return !e.includes(':') && e === targetHost; // host-only entry → any port
  });
}

app.use(cors({ origin: (origin, cb) => cb(null, isOriginAllowed(origin)) }));
// Simple same-site forms can carry cookies even when CORS blocks reading their
// response. Reject browser mutation origins before any route or cookie change.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  let allowed = !origin && req.get('sec-fetch-site') !== 'cross-site';
  if (origin) {
    try {
      const parsed = new URL(origin);
      allowed = parsed.origin === new URL(`${req.protocol}://${req.get('host')}`).origin ||
        allowlistPermitsMutation(parsed);
    } catch { allowed = false; }
  }
  if (!allowed) return res.status(403).json({ error: 'Cross-origin mutation rejected' });
  next();
});
app.use(compression());
// Playlist metadata, recordings and settings are small; only raw playlist text
// (express.text below) needs a large body, so JSON gets a much tighter ceiling.
const JSON_BODY_LIMIT = '1mb';
app.use(express.json({ limit: JSON_BODY_LIMIT, inflate: false }));
app.use(express.text({ type: ['text/plain', 'application/x-mpegurl', 'audio/x-mpegurl'], limit: '25mb', inflate: false }));

// ---- Authentication (§4) -------------------------------------
// Cookie options. Secure is set dynamically: ON over HTTPS (honored via
// `trust proxy` → X-Forwarded-Proto), OFF over plain HTTP so login still works
// on a LAN address. SameSite=Lax + the CORS allowlist defend against CSRF.
function sessionCookieOpts(req, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!req.secure,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

// Report whether auth is required, whether this request is authenticated, and
// whether the session must still change its (bootstrap) password.
app.get('/api/auth/status', (req, res) => {
  if (!isAuthEnabled()) return res.json({ authRequired: false, authed: true });
  const user = userFromRequest(req);
  res.json({
    authRequired: true,
    authed: !!user,
    mustChange: user ? !!user.mc : false,
    username: user ? currentUsername() : '',
  });
});

// Exchange credentials for a session cookie. A bootstrap login is flagged
// mustChange until a real password is set.
app.post('/api/auth/login', loginLimiter, (req, res) => {
  if (!isAuthEnabled()) return res.json({ authRequired: false, authed: true });
  const { username = '', password = '', remember = false } = req.body || {};
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const mustChange = needsPasswordChange();
  const days = remember ? REMEMBER_DAYS : 1;
  const { token } = issueToken(days, mustChange);
  res.cookie(COOKIE, token, sessionCookieOpts(req, remember ? days * 24 * 60 * 60 * 1000 : undefined));
  res.json({ authRequired: true, authed: true, mustChange, username: currentUsername() });
});

// Set a new password. Allowed for an authenticated session. A bootstrap (mc)
// session needs no current password (the session already proves bootstrap auth);
// a normal change requires the current password. Issues a fresh, cleared cookie.
app.post('/api/auth/password', loginLimiter, asyncRoute(async (req, res) => {
  if (!isAuthEnabled()) return res.status(400).json({ error: 'Authentication is disabled' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  const { currentPassword = '', newPassword = '', remember = false } = req.body || {};
  // Voluntary change (not a forced first-login) must prove the current password.
  if (!user.mc && !verifyCredentials(currentUsername(), currentPassword)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const result = await setPassword(newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const days = remember ? REMEMBER_DAYS : 1;
  const { token } = issueToken(days, false);
  res.cookie(COOKIE, token, sessionCookieOpts(req, remember ? days * 24 * 60 * 60 * 1000 : undefined));
  res.json({ ok: true, authed: true, mustChange: false, username: currentUsername() });
}));

// Clear the session cookie.
app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  await revokeRequestSession(req);
  res.clearCookie(COOKIE, sessionCookieOpts(req));
  res.json({ authRequired: isAuthEnabled(), authed: false });
}));

// Guard everything else under /api. Public: health + the auth endpoints above
// (so the login page can load and check status). Static SPA assets are served
// outside /api and stay public so the login screen itself can render. A
// must-change (bootstrap) session is blocked from data routes until it sets a
// password — it can only reach the auth endpoints above.
const PUBLIC_API = new Set(['/health', '/auth/status', '/auth/login', '/auth/logout', '/auth/password']);
app.use('/api', (req, res, next) => {
  if (!isAuthEnabled() || PUBLIC_API.has(req.path)) return next();
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.mc) return res.status(403).json({ error: 'Password change required', mustChange: true });
  next();
});

// ---- Simple in-memory caches (EPG + playlist text) -----------------------
// Bounded so a run of distinct EPG/playlist URLs can't grow memory without limit.
const MAX_CACHE_ENTRIES = 8;
// How long an ad-hoc /api/epg guide stays in memory. Configured sources bypass
// this entirely — they are served from the persistent store in lib/epgstore.js.
const EPG_MEMORY_CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return null;
}
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    cache.delete(oldest[0]);
  }
}

// Some streams only respond to a specific User-Agent / Referer (carried in the
// playlist via tvg attributes or #EXTVLCOPT). Sanitize caller-supplied values
// (strip CR/LF to block header injection, cap length) before forwarding.
function cleanHeader(v) {
  return typeof v === 'string' ? v.replace(/[\r\n]/g, '').slice(0, 512) : '';
}
// Refuse literal private/loopback/link-local targets when PROXY_BLOCK_PRIVATE=1
// (the predicate itself lives in lib/http.js so background fetches share it).
// Returns false (after sending the 403) when the request should stop.
function guardTarget(target, res) {
  if (isBlockedTarget(target)) {
    res.status(403).json({ error: 'Refusing to fetch a private-network URL' });
    return false;
  }
  return true;
}

// ---- Health --------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: APP_VERSION });
});

// ---- CORS / stream proxy -------------------------------------------------
// Streams arbitrary http(s) resources through the backend so the browser can
// play streams that lack permissive CORS headers. Honors Range requests.
const streamProxy = createStreamProxy();
app.all('/api/proxy', asyncRoute(async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }
  if (!guardTarget(target, res)) return;
  const ua = cleanHeader(req.query.ua);
  const ref = cleanHeader(req.query.ref);
  const headers = { ...FETCH_HEADERS };
  if (ua) headers['User-Agent'] = ua;
  if (ref) headers.Referer = ref;
  if (req.headers.range) headers.Range = req.headers.range;
  await streamProxy(req, res, { target, headers, extra: proxyExtra(ua, ref) });
}));

// ---- Playlist fetch + parse ---------------------------------------------
// The same ceiling the uploaded-file PUT enforces: anything larger is not a playlist.
// Without these this was the only download that buffered an unbounded response.
const PLAYLIST_MAX_BYTES = 64 * 1024 * 1024;
const PLAYLIST_FETCH_TIMEOUT_MS = 30_000;
app.get('/api/playlist', upstreamLimiter, asyncRoute(async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) return res.status(400).json({ error: 'Invalid or missing url parameter' });
  if (!guardTarget(target, res)) return;
  try {
    const cached = req.query.refresh === '1' ? null : cacheGet(`pl:${target}`, 60 * 1000);
    let text = cached;
    if (!text) {
      const downloaded = await fetchToBuffer(target, {
        timeoutMs: PLAYLIST_FETCH_TIMEOUT_MS,
        maxBytes: PLAYLIST_MAX_BYTES,
      });
      text = downloaded.toString('utf8');
      cacheSet(`pl:${target}`, text);
    }
    const channels = parseM3U(text);
    res.json({ url: target, count: channels.length, channels, fetchedAt: new Date().toISOString() });
  } catch (err) {
    // fetchToBuffer carries the upstream's own status (and 413 for an oversized
    // response), so the passthrough this endpoint always had is preserved.
    if (err.status) return res.status(err.status).json({ error: `Upstream ${err.status}` });
    res.status(502).json({ error: 'Failed to fetch playlist', detail: safeDiagnostic(err) });
  }
}));

// Parse uploaded/raw M3U text (POST body is text/plain).
app.post('/api/parse', upstreamLimiter, (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.text || '';
  // Reject binary blobs masquerading as a playlist (NUL byte = not text M3U).
  if (typeof text !== 'string' || text.includes(String.fromCharCode(0))) {
    return res.status(400).json({ error: 'Invalid playlist: expected M3U text' });
  }
  const channels = parseM3U(text);
  res.json({ count: channels.length, channels, fetchedAt: new Date().toISOString() });
});

// ---- EPG -----------------------------------------------------------------
// Fetching, parsing, persistence and merging live in lib/epgstore.js. What stays
// here is the request-shaped part: clamping the requested window and serving it.
const MS_PER_HOUR = 3600_000;
const EPG_MAX_WINDOW_HOURS = 168; // 7 days — ceiling on both window directions
const EPG_WINDOW_LOOKBACK_HOURS = 3; // legacy /api/epg default: Now context only
// Catchup browses up to `catchup-days` back, so the merged guide keeps a week.
const EPG_MERGED_LOOKBACK_HOURS = 168;
const EPG_MERGED_FORWARD_HOURS = 48;
// Background refresh cadence, from the same REFRESH_INTERVAL_MINUTES knob the
// client uses for playlists. 0 disables it (as .env.example documents); anything
// lower than the floor is raised to it so guides are never hammered.
const EPG_REFRESH_MIN_MINUTES = 15;
// A validation runs while the user waits on a button, so it gets the short budget
// rather than the background fetcher's.
const EPG_VALIDATE_TIMEOUT_MS = 20_000;
// The iptv-org grabber running alongside this app, if the optional overlay is up.
const EPG_SIDECAR_URL = sidecarUrl;
// Rebuilding channels.xml re-reads the iptv-org dataset, so collapse a burst of
// playlist edits into one run.
const SIDECAR_REGEN_DEBOUNCE_MS = 15_000;
// The iptv-org dataset itself only changes slowly; a daily rebuild keeps the
// mapping current without re-reading 36 MB of JSON more often than that.
const SIDECAR_REGEN_INTERVAL_MS = 24 * 60 * 60 * 1000;
let sidecarRegenTimer = null;

// Keep the sidecar's channel list in step with the playlists it is derived from.
// Only meaningful when a sidecar is configured — otherwise nothing consumes it.
function scheduleSidecarRegen() {
  if (!EPG_SIDECAR_URL) return;
  clearTimeout(sidecarRegenTimer);
  sidecarRegenTimer = setTimeout(() => {
    regenerateSidecarChannels().catch((err) => console.warn('epg-sidecar: regen failed:', safeDiagnostic(err)));
  }, SIDECAR_REGEN_DEBOUNCE_MS);
  sidecarRegenTimer.unref?.();
}

async function regenerateSidecarChannels() {
  const summary = await generateChannelsXml(await getWantedChannels());
  console.log(`epg-sidecar: channels.xml → ${summary.mapped}/${summary.total} channels mapped`);
  return summary;
}
// Enough unmatched names to show the user what a guide is missing, not the list.
const MAX_UNMATCHED_SAMPLE = 8;
// The coverage card lists unmatched channels to fix by hand; past this many the
// list stops being a to-do list and the response stops being small.
const MAX_UNMATCHED_PER_GROUP = 200;

function epgRefreshIntervalMs() {
  const minutes = parseInt(process.env.REFRESH_INTERVAL_MINUTES || '360', 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(EPG_REFRESH_MIN_MINUTES, minutes) * 60_000;
}

function clampWindowHours(value, fallback) {
  const hours = parseInt(value, 10);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(EPG_MAX_WINDOW_HOURS, hours);
}

// Return a windowed shallow copy of a parsed guide: only programmes overlapping
// [now − lookback, now + hours]. `channels` is kept whole (F13 needs the full map);
// channels with no programmes left in the window are dropped from `programmes`.
function windowEpg(parsed, hours, lookbackHours = EPG_WINDOW_LOOKBACK_HOURS, at = Date.now()) {
  const from = at - lookbackHours * MS_PER_HOUR;
  const to = at + hours * MS_PER_HOUR;
  const programmes = {};
  for (const [id, list] of Object.entries(parsed.programmes || {})) {
    const kept = list.filter((p) => programmeInWindow(p, from, to));
    if (kept.length) programmes[id] = kept;
  }
  return { channels: parsed.channels, programmes };
}

// Single-source fetch. Kept for ad-hoc guide URLs and as the client's fallback
// when it talks to a server without /api/epg/merged. Results stay in the shared
// memory cache only — arbitrary URLs are never persisted to the data volume.
app.get('/api/epg', upstreamLimiter, asyncRoute(async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) return res.status(400).json({ error: 'Invalid or missing url parameter' });
  if (!guardTarget(target, res)) return;
  const hours = Math.min(EPG_MAX_WINDOW_HOURS, parseInt(req.query.hours, 10) || 0);
  const lookbackHours = clampWindowHours(req.query.lookbackHours, EPG_WINDOW_LOOKBACK_HOURS);
  try {
    let parsed = cacheGet(`epg:${target}`, EPG_MEMORY_CACHE_TTL_MS);
    if (!parsed) {
      parsed = await fetchAndParseGuide(target);
      cacheSet(`epg:${target}`, parsed);
    }
    res.json(hours > 0 ? windowEpg(parsed, hours, lookbackHours) : parsed);
  } catch (err) {
    // Preserve the pre-existing contract: the upstream's own status (and the 413
    // for an oversized guide) reach the client rather than a blanket 502.
    if (err.status === 413) return res.status(413).json({ error: 'EPG file too large' });
    if (err.status) return res.status(err.status).json({ error: `Upstream ${err.status}` });
    res.status(502).json({ error: 'Failed to fetch EPG', detail: safeDiagnostic(err) });
  }
}));

// The whole guide: every configured source, merged and windowed. Served from the
// disk-backed store, so it is warm at first paint and after a restart. The window
// defaults to a week back / two days forward so Catchup sees its full archive.
app.get('/api/epg/merged', upstreamLimiter, asyncRoute(async (req, res) => {
  const hours = clampWindowHours(req.query.hours, EPG_MERGED_FORWARD_HOURS);
  const lookbackHours = clampWindowHours(req.query.lookbackHours, EPG_MERGED_LOOKBACK_HOURS);
  try {
    const urls = await configuredEpgUrls();
    const revision = epgSourceRevision(urls);
    if (req.query.sourceRevision && req.query.sourceRevision !== revision) {
      return res.status(409).json({ error: 'Guide sources changed. Sync settings and retry.' });
    }
    const { guide, ...snapshot } = await getMergedGuideSnapshot(urls);
    if (epgSourceRevision(await configuredEpgUrls()) !== revision) {
      return res.status(409).json({ error: 'Guide sources changed during loading. Sync settings and retry.' });
    }
    res.json({ ...windowEpg(guide, hours, lookbackHours), ...snapshot });
  } catch (err) {
    res.status(502).json({ error: 'Failed to load EPG', detail: safeDiagnostic(err) });
  }
}));

// Known public guides for the countries this install actually has. Pure lookup —
// no upstream traffic; validating a candidate is the separate call below.
app.get('/api/epg/suggest', upstreamLimiter, asyncRoute(async (req, res) => {
  try {
    const { countries } = await getWantedChannels();
    res.json(suggestionsForCountries(countries));
  } catch (err) {
    res.status(500).json({ error: 'Failed to build suggestions', detail: safeDiagnostic(err) });
  }
}));

// Try a guide URL before committing to it: download, parse, and report how much
// of the user's channel set it covers. Nothing is persisted — a candidate the
// user rejects leaves no trace on the data volume.
app.post('/api/epg/validate', upstreamLimiter, asyncRoute(async (req, res) => {
  const url = (req.body && req.body.url) || '';
  const country = (req.body && req.body.country) || '';
  if (!isValidUrl(url)) return res.status(400).json({ ok: false, error: 'Enter a valid http(s) URL' });
  if (!guardTarget(url, res)) return;
  try {
    let guide = cacheGet(`epg:${url}`, EPG_MEMORY_CACHE_TTL_MS);
    if (!guide) {
      guide = await fetchAndParseGuide(url, { timeoutMs: EPG_VALIDATE_TIMEOUT_MS });
      cacheSet(`epg:${url}`, guide);
    }
    const { channels } = await getWantedChannels();
    const scope = country ? channels.filter((channel) => channel.country === country) : channels;
    const { matched, total, unmatched } = matchGuideToChannels(guide, scope);
    res.json({
      ok: true,
      channelCount: Object.keys(guide.channels || {}).length,
      matched,
      total,
      sampleUnmatched: unmatched.slice(0, MAX_UNMATCHED_SAMPLE),
    });
  } catch (err) {
    res.json({ ok: false, error: safeDiagnostic(err) });
  }
}));

// How much of the user's channel set the guide actually resolves, grouped by
// country and by playlist, with the channels that missed named so they can be
// linked by hand. Memoized against the guide and the channel index, so opening
// Settings repeatedly costs nothing.
let coverageCache = null;

// The alt-name tier arriving changes the answer, but nothing else about the guide
// or the channel set does — so the memo has to be dropped explicitly once a warm
// lands, or coverage would keep reporting the pre-dataset numbers.
function warmDatasetThenRecompute(countries) {
  warmIptvOrgDataset(countries).then((loaded) => {
    if (loaded) coverageCache = null;
  });
}

async function computeCoverage() {
  const wanted = await getWantedChannels();
  const state = await readCollection('state');
  const settings = state.find((entry) => entry.key === SETTINGS_KEY)?.value || {};
  const { guide: fullGuide, sourceRevision, guideRevision } = await getMergedGuideSnapshot(await configuredEpgUrls(settings));
  const at = Date.now();
  const signature = `${sourceRevision}|${guideRevision}|${wanted.updatedAt}`;
  const overrides = settings.epgOverrides || {};
  const overridesSignature = JSON.stringify(overrides);
  if (coverageCache && coverageCache.signature === signature && coverageCache.overrides === overridesSignature && at < coverageCache.expiresAt) {
    return coverageCache.value;
  }

  const guide = windowEpg(fullGuide, EPG_MERGED_FORWARD_HOURS, EPG_MERGED_LOOKBACK_HOURS, at);
  const dataset = await loadIptvOrgIndex(wanted.countries, { cachedOnly: true });
  if (!dataset && wanted.countries.length) warmDatasetThenRecompute(wanted.countries);
  const altNames = buildAltNameIndex(dataset, guide);
  const results = matchAll(wanted.channels, guide, overrides, altNames);

  const value = {
    generatedAt: new Date().toISOString(),
    sourceRevision,
    guideRevision,
    window: { from: new Date(at - EPG_MERGED_LOOKBACK_HOURS * MS_PER_HOUR).toISOString(),
      to: new Date(at + EPG_MERGED_FORWARD_HOURS * MS_PER_HOUR).toISOString() },
    links: results.filter((r) => r.method === 'override').map(({ channelId, targetKey, status, hasProgrammes }) =>
      ({ channelId, targetKey, status, hasProgrammes })),
    altNamesAvailable: !!dataset,
    byCountry: groupCoverage(results, (result) => result.country),
    byPlaylist: groupCoverage(results, (result) => result.playlistId),
  };
  // Schedule availability changes as the rolling window moves, even when no
  // guide refresh occurs. Expire at the next entry/exit boundary.
  let expiresAt = Infinity;
  for (const list of Object.values(fullGuide.programmes || {})) {
    for (const programme of list) {
      for (const boundary of [Date.parse(programme.start) - EPG_MERGED_FORWARD_HOURS * MS_PER_HOUR + 1,
        (programme.endStatus === 'unknown' ? Date.parse(programme.start) + 1 : Date.parse(programme.stop)) + EPG_MERGED_LOOKBACK_HOURS * MS_PER_HOUR]) {
        if (boundary > at) expiresAt = Math.min(expiresAt, boundary);
      }
    }
  }
  coverageCache = { signature, overrides: overridesSignature, value, expiresAt };
  return value;
}

// One row per group: how many matched, and which channels did not.
function groupCoverage(results, keyOf) {
  const groups = new Map();
  for (const result of results) {
    const key = keyOf(result);
    if (!groups.has(key)) groups.set(key, { key, total: 0, matched: 0, scheduled: 0, missingLinks: 0, unmatched: [] });
    const group = groups.get(key);
    group.total += 1;
    if (result.hasProgrammes) group.scheduled += 1;
    if (result.status === 'missing-target') group.missingLinks += 1;
    if (result.matchedKey) group.matched += 1;
    else if (group.unmatched.length < MAX_UNMATCHED_PER_GROUP) {
      group.unmatched.push({ id: result.channelId, name: result.name, tvgId: result.tvgId, status: result.status, targetKey: result.targetKey });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, pct: group.total ? Math.round((group.matched / group.total) * 100) : 0 }))
    .sort((a, b) => a.pct - b.pct || a.key.localeCompare(b.key));
}

app.get('/api/epg/coverage', asyncRoute(async (req, res) => {
  try {
    res.json(await computeCoverage());
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute coverage', detail: safeDiagnostic(err) });
  }
}));

// The alt-name tier as a flat map the client can apply while resolving channels.
// Served only from an already-cached dataset: this is on the page-load path, so
// it must never pay for the download — a warm runs in the background instead.
app.get('/api/epg/altnames', asyncRoute(async (req, res) => {
  try {
    const wanted = await getWantedChannels();
    const dataset = await loadIptvOrgIndex(wanted.countries, { cachedOnly: true });
    if (!dataset) {
      if (wanted.countries.length) warmDatasetThenRecompute(wanted.countries);
      return res.json({});
    }
    res.json(buildAltNameIndex(dataset, await getMergedGuide()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to build alt-name index', detail: safeDiagnostic(err) });
  }
}));

// The optional iptv-org sidecar: what the generated channels.xml covers, and
// whether the grabber that consumes it is actually serving a guide.
app.get('/api/epg/sidecar', asyncRoute(async (req, res) => {
  try {
    const summary = await readSidecarSummary();
    const health = (await readSourceHealth()).find((source) => source.sourceId === sourceId(EPG_SIDECAR_URL));
    res.json({
      configured: !!EPG_SIDECAR_URL,
      sourceId: sourceId(EPG_SIDECAR_URL),
      live: !!(health && health.ok),
      error: health && !health.ok ? health.error : '',
      summary,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read sidecar status', detail: safeDiagnostic(err) });
  }
}));

// Per-source status of the last refresh — which guides loaded, which failed and why.
app.get('/api/epg/health', asyncRoute(async (req, res) => {
  res.json(await readSourceHealth());
}));

// What a radio stream is playing right now, straight from the stream. Stations
// rarely appear in an XMLTV guide, but most announce the current track over ICY.
// Best-effort by nature: a station that says nothing answers with empty fields
// rather than an error, so a polling client never has to treat silence as broken.
app.get('/api/nowplaying', upstreamLimiter, asyncRoute(async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) return res.status(400).json({ error: 'Invalid or missing url parameter' });
  if (!guardTarget(target, res)) return;
  try {
    res.json(await probeNowPlaying(target, cleanHeader(req.query.ua)));
  } catch (err) {
    res.json({ title: '', name: '', bitrate: '', genre: '', error: safeDiagnostic(err) });
  }
}));

// ---- Wanted-channels index ----------------------------------------------
// The channels this install actually has (enabled playlists only), with the
// countries they fall into — the scope every EPG feature filters by. Served from
// a memoized, disk-backed index; `?refresh=1` forces a rebuild. Rate-limited with
// the upstream limiter because a rebuild re-fetches URL playlists.
app.get('/api/epg/channels', upstreamLimiter, asyncRoute(async (req, res) => {
  try {
    res.json(await getWantedChannels({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to build channel index', detail: safeDiagnostic(err) });
  }
}));

// ---- Playlists persistence ----------------------------------------------
app.get('/api/playlists', asyncRoute(async (req, res) => {
  res.json(await listPlaylists());
}));

// Current channel identity is server-authoritative across browsers and EPG.
async function currentPlaylistChannels(id) {
  const playlist=(await listPlaylists()).find(record=>record.id===id);
  if(!playlist)throw Object.assign(new Error('Playlist is unavailable'),{status:404});
  return readPlaylistChannels(playlist);
}
app.get('/api/playlists/:id/channels', upstreamLimiter, asyncRoute(async(req,res)=>{
  res.json(await currentPlaylistChannels(req.params.id));
}));
app.post('/api/playlists/:id/aliases', writeLimiter, asyncRoute(async(req,res)=>{
  if(!(await listPlaylists()).some(record=>record.id===req.params.id))return res.status(404).json({error:'Playlist is unavailable'});
  res.json(await registerChannelAliases(req.params.id,req.body?.aliases));
}));

// Explicit, user-managed radio entries share the durable playlist transaction.
app.get('/api/local-stations', asyncRoute(async (req, res) => {
  try { res.json(await listLocalStations()); } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Local stations could not be loaded' }); }
}));
for (const [method, route, remove] of [['post', '/api/local-stations', false], ['put', '/api/local-stations/:id', false], ['delete', '/api/local-stations/:id', true]]) {
  app[method](route, writeLimiter, asyncRoute(async (req, res) => {
    try {
      const result = await changeLocalStation(req.body || {}, req.params.id, remove);
      markWantedChannelsDirty(); scheduleSidecarRegen(); res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Station could not be saved; reload the list before retrying' }); }
  }));
}

app.post('/api/playlists', writeLimiter, asyncRoute(async (req, res) => {
  try {
    const record = await savePlaylist(req.body || {});
    markWantedChannelsDirty();
    scheduleSidecarRegen();
    res.json(record);
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to save playlist', detail: safeDiagnostic(err) });
  }
}));

// Store the raw uploaded .m3u so the user can download the original later.
app.put('/api/playlists/:id/file', writeLimiter, asyncRoute(async (req, res) => {
  try {
    const record = await commitPlaylistFile(req.params.id, req.body, {
      ...(typeof req.query.name === 'string' ? { name: req.query.name } : {}),
      ...(typeof req.query.contentKind === 'string' ? { contentKind: req.query.contentKind } : {}),
      ...(req.query.revision !== undefined ? { revision: Number(req.query.revision) } : {}),
      ...(typeof req.query.operationId === 'string' ? { operationId: req.query.operationId } : {}),
    });
    markWantedChannelsDirty();
    scheduleSidecarRegen();
    res.json({ ok: true, playlist: record });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to store file', detail: safeDiagnostic(err) });
  }
}));

// Download the stored raw playlist file.
app.get('/api/playlists/:id/file', asyncRoute(async (req, res) => {
  const fp = playlistFilePath(req.params.id);
  if (!fp) return res.status(400).json({ error: 'Bad id' });
  const meta = (await listPlaylists()).find((p) => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: 'No stored playlist' });
  let text;
  try {
    text = await fs.readFile(fp, 'utf8');
  } catch {
    return res.status(404).json({ error: 'No stored file for this playlist' });
  }
  const safe = ((meta && meta.name) || 'playlist').replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 80) || 'playlist';
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  if (req.query.dl) res.setHeader('Content-Disposition', `attachment; filename="${safe}.m3u"`);
  res.send(text);
}));

app.delete('/api/playlists/:id', writeLimiter, asyncRoute(async (req, res) => {
  try {
    await deletePlaylist(req.params.id, req.query.revision === undefined ? undefined : Number(req.query.revision));
    markWantedChannelsDirty();
    scheduleSidecarRegen();
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to delete playlist', detail: safeDiagnostic(err) });
  }
}));

// ---- Cross-device state sync (favourites / history / settings) -----------
// A generic key→value collection so per-origin localStorage follows the user to
// any device pointed at this backend, the same way playlists already do.
const SYNCED_STATE_KEYS = ['favourites', 'history', 'settings'];
const SETTINGS_KEY = 'settings';
const MAX_STATE_BYTES = 256 * 1024;
// Collapse a burst of settings saves into one guide refresh.
const EPG_REFRESH_DEBOUNCE_MS = 5000;
let epgRefreshTimer = null;

function scheduleEpgRefresh() {
  clearTimeout(epgRefreshTimer);
  epgRefreshTimer = setTimeout(() => {
    refreshAll({ maxAgeMs: 60_000 }).catch((err) => console.warn('epg: refresh failed:', safeDiagnostic(err)));
  }, EPG_REFRESH_DEBOUNCE_MS);
  epgRefreshTimer.unref?.();
}

app.get('/api/state', asyncRoute(async (req, res) => {
  const records = await readCollection('state');
  res.json(await Promise.all(records.map(async (record) => ({
    ...record,
    value: await canonicalStateValue(record.key, record.value),
    ...(record.key === SETTINGS_KEY
      ? { epgSourceRevision: epgSourceRevision(await configuredEpgUrls(record.value || {})) } : {}),
  }))));
}));

app.put('/api/state/:key', writeLimiter, asyncRoute(async (req, res) => {
  const { key } = req.params;
  if (!SYNCED_STATE_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown state key' });
  let value = req.body && req.body.value;
  if (value === undefined) return res.status(400).json({ error: 'Missing value' });
  if (JSON.stringify(value).length > MAX_STATE_BYTES) return res.status(413).json({ error: 'State too large' });
  value = await canonicalStateValue(key, value);
  const rec = { key, value, updatedAt: new Date().toISOString() };
  let conflict = null;
  await updateCollection('state', (list) => {
    const i = list.findIndex((e) => e.key === key);
    const expected = req.body.baseUpdatedAt ?? 0;
    if (expected !== (list[i]?.updatedAt || 0)) { conflict = list[i] || { key, value: null, updatedAt: 0 }; return list; }
    rec.updatedAt = new Date(Math.max(Date.now(), (Date.parse(list[i]?.updatedAt) || 0) + 1)).toISOString();
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    return list;
  });
  if (conflict) return res.status(409).json({ error: 'Shared state changed on another device. Review before saving.', current: conflict });
  // The EPG source list lives in the settings blob — pick up edits to it without
  // waiting for the next scheduled refresh.
  if (key === SETTINGS_KEY) {
    rec.epgSourceRevision = epgSourceRevision(await configuredEpgUrls(value || {}));
    scheduleEpgRefresh();
  }
  res.json(rec);
}));

// Portable saved preferences/curation only; source files and secrets stay out.
for (const [method, route, action] of [['get', '/api/config/export', exportConfiguration], ['post', '/api/config/preview', previewConfiguration], ['post', '/api/config/restore', restoreConfiguration]]) {
  app[method](route, writeLimiter, asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await action(req.body);
      if (route.endsWith('/restore')) scheduleEpgRefresh();
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Configuration operation failed. Previous state or its private server rollback snapshot is preserved.' }); }
  }));
}

// ---- Recordings ----------------------------------------------------------
const RECORDING_MAX_MINUTES = validateRecordingMinutes(Number(process.env.RECORDING_MAX_MINUTES || '180'));
const BYTES_PER_GB = 1024 ** 3;
// Total-storage cap for recordings (GB → bytes); null = unlimited (no pruning).
const RECORDINGS_MAX_BYTES = parseFloat(process.env.RECORDINGS_MAX_GB || '0') * BYTES_PER_GB || null;
// Statuses whose files may be pruned by retention — never an active 'recording'/'scheduled'.
const PRUNABLE_STATUSES = new Set(['completed', 'interrupted', 'failed', 'missed']);
// Both recording endpoints reject a bad target with the same message.
const INVALID_STREAM_URL = 'Invalid or missing stream url';

// Sum of all files currently in the recordings directory (ENOENT → 0).
async function recordingsDirBytes() {
  const dir = recordingsDir(DATA_DIR);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      total += (await fs.stat(path.join(dir, name))).size;
    } catch {
      /* file vanished between readdir and stat */
    }
  }
  return total;
}

async function updateRecording(id, patch) {
  await updateCollection('recordings', (list) => {
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list[i] = { ...list[i], ...patch };
    return list;
  });
}

// Called by the recorder when an ffmpeg capture exits.
function onCaptureFinish(patch) {
  return updateRecording(patch.id, {
    filename: patch.filename,
    size: patch.size,
    status: patch.status,
    end: patch.end,
    error: patch.error ? safeDiagnostic(patch.error) : '',
    stopReason: patch.stopReason || '',
    exitCode: patch.exitCode ?? null,
    exitSignal: patch.exitSignal || null,
    partial: !!patch.partial,
  }).catch(() => {});
}

app.get('/api/recordings', asyncRoute(async (req, res) => {
  const list = await readCollection('recordings');
  // Surface live-growing size for in-progress captures.
  for (const r of list) {
    if (r.status === 'recording' && isRecording(r.id)) {
      const s = await currentSize(r.id);
      if (s != null) r.size = s;
    }
  }
  res.json(list.map((record) => ({ ...record, error: record.error ? safeDiagnostic(record.error) : '' })));
}));

// Start capturing a channel "now".
app.post('/api/recordings/start', writeLimiter, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isValidUrl(b.url)) return res.status(400).json({ error: INVALID_STREAM_URL });
  if (!guardTarget(b.url, res)) return;
  // Omitted duration uses the configured maximum; supplied invalid values fail.
  let mins;
  try {
    if (b.durationMinutes !== undefined && !['number', 'string'].includes(typeof b.durationMinutes)) throw new Error();
    mins = Math.min(RECORDING_MAX_MINUTES, Math.max(1, validateRecordingMinutes(
      b.durationMinutes === undefined ? RECORDING_MAX_MINUTES : Number(b.durationMinutes)
    )));
  } catch { return res.status(400).json({ error: 'Invalid recording duration' }); }
  const id = randomUUID();
  const rec = {
    id,
    channelId: b.channelId || '',
    channelName: b.channelName || 'Unknown',
    channelLogo: b.channelLogo || '',
    url: b.url,
    title: b.title || b.channelName || 'Recording',
    httpUserAgent: cleanHeader(b.httpUserAgent),
    httpReferrer: cleanHeader(b.httpReferrer),
    start: new Date().toISOString(),
    end: new Date(Date.now() + mins * 60000).toISOString(),
    status: 'recording',
    filename: fileNameFor(id),
    size: 0,
    createdAt: new Date().toISOString(),
  };
  try {
    await updateCollection('recordings', (list) => {
      list.push(rec);
      return list;
    });
    startCapture({
      rec,
      dataDir: DATA_DIR,
      maxMinutes: mins,
      deadlineAt: Date.parse(rec.end),
      userAgent: rec.httpUserAgent || FETCH_HEADERS['User-Agent'],
      referer: rec.httpReferrer,
      onFinish: onCaptureFinish,
    });
    res.json(rec);
  } catch (err) {
    await updateRecording(id, { status: 'failed', filename: '', size: 0, error: err.code === 'RECORDING_CAPACITY' ? 'Recording capacity reached' : 'Failed to start recording' });
    res.status(err.status || 500).json({ error: err.code === 'RECORDING_CAPACITY' ? 'Recording capacity reached' : 'Failed to start recording' });
  }
}));

// Stop an in-progress capture (graceful — file is finalised on exit).
app.post('/api/recordings/:id/stop', asyncRoute(async (req, res) => {
  stopCapture(req.params.id);
  const rec = (await readCollection('recordings')).find((r) => r.id === req.params.id);
  res.json(rec || { ok: true });
}));

// Schedule a future recording (EPG). The scheduler starts/stops capture at its time.
app.post('/api/recordings', writeLimiter, asyncRoute(async (req, res) => {
  try {
    const body = await recordingIdentity(req.body || {}, currentPlaylistChannels);
    const hasId = Object.hasOwn(body, 'id');
    if (hasId && !isValidRecordingId(body.id)) return res.status(400).json({ error: 'Invalid recording ID' });
    if ((Object.hasOwn(body, 'status') && body.status !== 'scheduled') ||
        ['filename', 'size', 'createdAt', 'error'].some((key) => Object.hasOwn(body, key))) {
      return res.status(400).json({ error: 'Recording output and status are server-owned' });
    }
    const start = Object.hasOwn(body, 'start') ? body.start : new Date().toISOString();
    const end = Object.hasOwn(body, 'end') ? body.end : new Date(Date.now() + 3600_000).toISOString();
    if (!isValidRecordingWindow(start, end)) return res.status(400).json({ error: 'Invalid recording times' });
    if (!isValidUrl(body.url)) return res.status(400).json({ error: INVALID_STREAM_URL });
    if (!guardTarget(body.url, res)) return;
    const record = {
      id: hasId ? body.id : randomUUID(),
      channelId: body.channelId || '',
      channelName: body.channelName || 'Unknown',
      channelTvgId: body.channelTvgId || '',
      channelNumber: body.channelNumber ?? null,
      channelLogo: body.channelLogo || '',
      url: body.url,
      title: body.title || body.channelName || 'Recording',
      httpUserAgent: cleanHeader(body.httpUserAgent),
      httpReferrer: cleanHeader(body.httpReferrer),
      start,
      end,
      status: 'scheduled',
      filename: '',
      size: 0,
      createdAt: new Date().toISOString(),
    };
    let conflict = 0;
    await updateCollection('recordings', (list) => {
      const idx = list.findIndex((r) => r.id === record.id);
      if (hasId && idx < 0) conflict = 404;
      else if (hasId && (list[idx].status !== 'scheduled' || list[idx].filename || isRecording(record.id))) conflict = 409;
      else if (hasId) {
        record.createdAt = list[idx].createdAt;
        list[idx] = { ...list[idx], ...record };
      } else list.push(record);
      return list;
    });
    if (conflict) return res.status(conflict).json({ error: 'Recording is missing or no longer scheduled' });
    res.json(record);
  } catch (err) {
    if(err.code==='CHANNEL_UNAVAILABLE'||err.status===404)return res.status(409).json({error:'Scheduled channel is unavailable or ambiguous'});
    res.status(500).json({ error: 'Failed to save recording', detail: safeDiagnostic(err) });
  }
}));

// Stream a finished recording for playback (Range) or download (?dl=1).
app.get('/api/recordings/:id/file', asyncRoute(async (req, res) => {
  const rec = (await readCollection('recordings')).find((r) => r.id === req.params.id);
  if (!rec || !rec.filename) return res.status(404).json({ error: 'No file for this recording' });
  const filePath = resolveFile(DATA_DIR, rec.filename);
  if (!filePath) return res.status(400).json({ error: 'Bad filename' });
  await sendRecordingFile(req, res, filePath, rec.title);
}));

app.delete('/api/recordings/:id', writeLimiter, asyncRoute(async (req, res) => {
  try {
    stopCapture(req.params.id);
    const rec = (await readCollection('recordings')).find((r) => r.id === req.params.id);
    if (rec && rec.filename) {
      const filePath = resolveFile(DATA_DIR, rec.filename);
      if (filePath) await fs.unlink(filePath).catch(() => {});
    }
    await updateCollection('recordings', (list) => list.filter((r) => r.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete recording', detail: safeDiagnostic(err) });
  }
}));

// Storage meter: recordings footprint, free/total disk on the data volume, and the cap.
app.get('/api/storage', asyncRoute(async (req, res) => {
  try {
    const recordingsBytes = await recordingsDirBytes();
    let diskFreeBytes = null;
    let diskTotalBytes = null;
    try {
      const s = await fs.statfs(DATA_DIR);
      diskFreeBytes = s.bavail * s.bsize;
      diskTotalBytes = s.blocks * s.bsize;
    } catch {
      /* statfs unsupported — report nulls, meter degrades gracefully */
    }
    res.json({ recordingsBytes, diskFreeBytes, diskTotalBytes, maxBytes: RECORDINGS_MAX_BYTES });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read storage', detail: safeDiagnostic(err) });
  }
}));

// ---- Runtime config exposed to the client --------------------------------
app.get('/api/config', asyncRoute(async (req, res) => {
  const m3uUrl = process.env.M3U_URL || '';
  const fresh = (await readCollection('playlists', { strict: true })) === null;
  res.json({
    m3uUrl,
    m3uSeedAllowed: !!m3uUrl && fresh,
    m3uPlaylistId: m3uUrl ? 'configured-' + createHash('sha256').update(m3uUrl).digest('hex').slice(0, 32) : '',
    epgUrl: process.env.EPG_URL || '',
    refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES || '360', 10),
  });
}));

// ---- Static frontend (single-image mode) ---------------------------------
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

// SPA fallback — serve index.html for any non-API route.
// Deliberately generic: an internal failure must not leak a stack, a path or a
// filesystem error to the client. The detail goes to the server log instead.
const INTERNAL_ERROR = 'Internal error';

// Terminal error handler for the API: a thrown or rejected handler answers 500 rather
// than leaving the client waiting. Mounted before the SPA fallback so it only ever
// sees /api traffic.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'encoding.unsupported') {
    return res.status(415).json({ error: 'Compressed request bodies are not supported' });
  }
  if (err.type === 'entity.too.large' && req.method === 'PUT' && /^\/playlists\/[^/]+\/file$/.test(req.path)) {
    return res.status(413).json({ error: 'Playlist file too large' });
  }
  console.error('api:', requestDiagnostic(req, err));
  res.status(500).json({ error: INTERNAL_ERROR });
});

app.get(/^\/(?!api\/).*/, asyncRoute(async (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  try {
    await fs.access(indexPath);
    res.sendFile(indexPath);
  } catch {
    res
      .status(200)
      .type('html')
      .send('<h1>RO-IPTV backend running</h1><p>Frontend build not found. Run the client build or use the Docker image.</p>');
  }
}));

// On boot, captures from a previous run are gone — mark them interrupted and
// record whatever partial size landed on disk.
async function reconcileRecordings() {
  const list = await readCollection('recordings');
  const resumes = [];
  let changed = false;
  for (const r of list) {
    if (r.status !== 'recording' || isRecording(r.id)) continue;
    const originalEnd = r.end;
    r.status = 'interrupted';
    r.end = r.end || new Date().toISOString();
    const fp = r.filename && resolveFile(DATA_DIR, r.filename);
    if (fp) {
      try {
        r.size = (await fs.stat(fp)).size;
      } catch {
        /* file gone */
      }
    }
    changed = true;

    // Window still open → re-queue the remainder as a fresh scheduled record. A new
    // id/file is required because startCapture runs ffmpeg -y and would overwrite the
    // partial; the scheduler picks this up within a tick while the partial stays playable.
    if (originalEnd && Date.parse(originalEnd) > Date.now()) {
      resumes.push({
        ...r,
        id: randomUUID(),
        title: `${r.title} (resumed)`,
        start: new Date().toISOString(),
        end: originalEnd,
        status: 'scheduled',
        exitCode: null,
        exitSignal: null,
        partial: false,
        stopReason: '',
        error: '',
        filename: '',
        size: 0,
        createdAt: new Date().toISOString(),
      });
      r.end = new Date().toISOString(); // the original capture truly ended at restart
    }
  }
  if (resumes.length) list.push(...resumes);
  if (changed) await writeCollection('recordings', list);
}

// Prune the oldest finished recordings (with a file on disk) until the directory
// total is back under RECORDINGS_MAX_BYTES. Never touches an active capture. Cheap
// no-op when the cap is unset — runs on every scheduler tick, before captures start.
async function enforceRetention() {
  if (!RECORDINGS_MAX_BYTES) return;
  let total = await recordingsDirBytes();
  if (total <= RECORDINGS_MAX_BYTES) return;

  const oldestFirst = (await readCollection('recordings'))
    .filter((r) => PRUNABLE_STATUSES.has(r.status) && !isRecording(r.id) && r.filename)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  for (const r of oldestFirst) {
    if (total <= RECORDINGS_MAX_BYTES) break;
    const filePath = resolveFile(DATA_DIR, r.filename);
    let freed = 0;
    if (filePath) {
      try {
        freed = (await fs.stat(filePath)).size;
        await fs.unlink(filePath);
      } catch (error) {
        // Keep metadata for files that still exist but cannot be removed. Dropping
        // the record would hide the file and prevent a later retention retry.
        if (error.code !== 'ENOENT') {
          console.warn('retention: unable to prune', sourceId(r.id));
          continue;
        }
        freed = 0;
      }
    }
    await updateCollection('recordings', (list) => list.filter((x) => x.id !== r.id));
    total -= freed;
    console.warn('retention: pruned', sourceId(r.id));
  }
}

// Start/finish scheduled (EPG) recordings at their programme times.
//
// setInterval fires every 30s whether or not the previous tick has finished, and a
// tick stats every recording file before it starts anything — so on a slow volume two
// ticks can overlap and start the same programme twice. A tick arriving while one is
// running is DROPPED rather than queued: the next one is 30s away and sees the same
// work, so queueing would only duplicate it.
let schedulerTicking = false;

async function tickScheduler() {
  if (schedulerTicking) return;
  schedulerTicking = true;
  try {
    await runSchedulerTick();
  } finally {
    schedulerTicking = false;
  }
}

function isValidScheduledRecording(r) {
  return isValidRecordingId(r.id) && isValidRecordingWindow(r.start, r.end) && isValidUrl(r.url);
}

async function runSchedulerTick() {
  await enforceRetention();
  const now = Date.now();
  const list = await readCollection('recordings');
  for (const r of list) {
    if (r.status !== 'scheduled') continue;
    if (!isValidScheduledRecording(r)) {
      // Recheck under the collection lock, including malformed non-string IDs.
      await updateCollection('recordings', (rows) => rows.map((row) =>
        row.status === 'scheduled' && !isValidScheduledRecording(row)
          ? { ...row, status: 'failed', error: 'Invalid stored recording schedule' } : row));
      continue;
    }
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    if (end <= now) {
      await updateRecording(r.id, { status: 'missed' });
      continue;
    }
    if (start <= now && now < end && !isRecording(r.id)) {
      let input;
      try { input=await recordingIdentity(r,currentPlaylistChannels); }
      catch {
        await updateCollection('recordings',rows=>rows.map(row=>row.id===r.id&&row.status==='scheduled'&&row.channelId===r.channelId&&row.url===r.url&&row.start===r.start&&row.end===r.end?{...row,status:'failed',error:'Scheduled channel is unavailable or ambiguous'}:row));
        continue;
      }
      const claimedAt=Date.now();
      if(claimedAt>=end){await updateCollection('recordings',rows=>rows.map(row=>row.id===r.id&&row.status==='scheduled'&&row.start===r.start&&row.end===r.end?{...row,status:'missed'}:row));continue}
      let claimed=false,claimedRecord;
      await updateCollection('recordings',rows=>rows.map(row=>{
        if(row.id!==r.id||row.status!=='scheduled'||row.filename||![r.channelId,input.channelId].includes(row.channelId)||row.start!==r.start||row.end!==r.end||![r.url,input.url].includes(row.url))return row;
        claimed=true;claimedRecord={...row,channelId:input.channelId,channelName:input.channelName,channelLogo:input.channelLogo,channelTvgId:input.channelTvgId,channelNumber:input.channelNumber,url:input.url,httpUserAgent:input.httpUserAgent,httpReferrer:input.httpReferrer,channelIdentityIssue:'',status:'recording',filename:fileNameFor(r.id),start:new Date(claimedAt).toISOString()};return claimedRecord;
      }));
      if(!claimed)continue;
      const mins=Math.min(RECORDING_MAX_MINUTES,Math.max(1,Math.ceil((end-claimedAt)/60000)));
      try { startCapture({
        rec: claimedRecord, dataDir: DATA_DIR, maxMinutes: mins,
        deadlineAt: Math.min(end,claimedAt+RECORDING_MAX_MINUTES*60000),
        userAgent: input.httpUserAgent||FETCH_HEADERS['User-Agent'],referer:input.httpReferrer,onFinish:onCaptureFinish,
      }); } catch(error) {
        await updateRecording(r.id,{status:'failed',filename:'',size:0,error:error.code==='RECORDING_CAPACITY'?'Recording capacity reached':'Failed to start scheduled recording'});
      }
    }
  }
}

// Safety net: never let a single stray async error take the whole server down
// (a crashed process would 500 every request, as happened with the temp-file race).
// How long ffmpeg gets to finalise its MP4s before the process goes away. Shared by
// the signal handlers and the uncaught-exception path.
const SHUTDOWN_GRACE_MS = RECORDING_STOP_GRACE_MS + 2000;
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const fallback = setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS);
  stopAll().finally(() => { clearTimeout(fallback); process.exit(code); });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept alive):', safeDiagnostic(reason));
});
// After an uncaught exception the process state is undefined (Node's own guidance):
// timers, locks and file handles may be half-torn-down, so serving on is riskier than
// restarting. Captures are finalised first, then the process exits non-zero and the
// container's restart policy brings it back. The crash-loop this replaced was caused by
// a shared temp-file race, fixed at the root by the write queue in lib/store.js.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting:', safeDiagnostic(err));
  shutdown(1);
});

try {
  await initAuth();
} catch {
  console.error('Auth init failed: authentication storage is unavailable or invalid; startup refused. See README recovery instructions.');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`RO-IPTV server listening on http://0.0.0.0:${PORT}`);
  console.log('Serving built frontend');
  if (isAuthEnabled()) {
    console.log(
      '🔒 Authentication ENABLED' +
        (needsPasswordChange() ? ' — bootstrap password; change required on first login.' : '')
    );
  } else {
    console.warn('⚠  AUTHENTICATION DISABLED — set AUTH_PASSWORD to require login.');
  }
  await reconcileRecordings().catch(() => {});
  setInterval(() => tickScheduler().catch(() => {}), 30000);

  // Keep the guide warm in the background so it no longer depends on a browser
  // tab being open. At boot only genuinely stale sources are re-downloaded, so a
  // container restart doesn't re-fetch guides the data volume already holds.
  // With refresh disabled nothing is fetched here at all — a guide is then only
  // downloaded on demand, the first time a client asks for one.
  const epgIntervalMs = epgRefreshIntervalMs();
  if (epgIntervalMs) {
    refreshAll({ maxAgeMs: epgIntervalMs }).catch((err) => console.warn('epg: initial refresh failed:', safeDiagnostic(err)));
    setInterval(() => refreshAll().catch(() => {}), epgIntervalMs);
  } else {
    console.log('EPG background refresh disabled (REFRESH_INTERVAL_MINUTES=0)');
  }

  // Build the alt-name index up front when its dataset is already on the volume,
  // so the first page load after a restart doesn't pay to parse it.
  getWantedChannels()
    .then((wanted) => wanted.countries.length && loadIptvOrgIndex(wanted.countries, { cachedOnly: true }))
    .catch(() => {});

  // Keep the sidecar's channel list current: once at boot and daily, so a guide
  // for a channel added months ago is still grabbed after the dataset moves on.
  if (EPG_SIDECAR_URL) {
    console.log(`EPG sidecar configured: ${sourceId(EPG_SIDECAR_URL)}`);
    // Before anything else: the grabber container mounts this file, and a mount
    // of a missing path stops it starting at all.
    await ensureChannelsXmlExists().catch((err) => console.warn('epg-sidecar:', safeDiagnostic(err)));
    regenerateSidecarChannels().catch((err) => console.warn('epg-sidecar: initial regen failed:', safeDiagnostic(err)));
    setInterval(
      () => regenerateSidecarChannels().catch((err) => console.warn('epg-sidecar: regen failed:', safeDiagnostic(err))),
      SIDECAR_REGEN_INTERVAL_MS
    );
  }
});

// Finalise active captures gracefully on shutdown so MP4s aren't corrupted.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdown(0);
  });
}
