import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { parseM3U } from './lib/m3u.js';
import { parseEPG } from './lib/epg.js';
import { readCollection, writeCollection, updateCollection, DATA_DIR } from './lib/store.js';
import {
  COOKIE,
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
  stopCapture,
  stopAll,
  isRecording,
  currentSize,
  resolveFile,
  fileNameFor,
} from './lib/recorder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '56892', 10);
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // honor X-Forwarded-* from a reverse proxy

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
        // Inline style props (dynamic widths, floating-box geometry) + Google Fonts CSS.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
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
    // We deliberately trust the reverse proxy (app.set('trust proxy', true)).
    validate: { trustProxy: false },
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
      validate: { trustProxy: false },
      message: { error: 'Too many login attempts. Try again in a few minutes.' },
    });

// ---- CORS allowlist ------------------------------------------------------
// CORS_ALLOWED_ORIGINS: comma-separated domains/origins allowed to call the API
// cross-origin. Entries may be a full origin, a host, or host:port, with or
// without scheme (e.g. "tv.example.com, http://192.168.0.10:56892, 10.0.0.5").
// Unset or "*" → allow any origin (default; the app itself is same-origin anyway).
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

app.use(cors({ origin: (origin, cb) => cb(null, isOriginAllowed(origin)) }));
app.use(compression());
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: ['text/plain', 'application/x-mpegurl', 'audio/x-mpegurl'], limit: '25mb' }));

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
app.post('/api/auth/password', loginLimiter, async (req, res) => {
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
});

// Clear the session cookie.
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, sessionCookieOpts(req));
  res.json({ authRequired: isAuthEnabled(), authed: false });
});

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
const cache = new Map();
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return null;
}
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (RO-IPTV; +https://github.com/ro-iptv) AppleWebKit/537.36',
  Accept: '*/*',
};

// Some streams only respond to a specific User-Agent / Referer (carried in the
// playlist via tvg attributes or #EXTVLCOPT). Sanitize caller-supplied values
// (strip CR/LF to block header injection, cap length) before forwarding.
function cleanHeader(v) {
  return typeof v === 'string' ? v.replace(/[\r\n]/g, '').slice(0, 512) : '';
}
// Query suffix that carries the same UA/Referer onto rewritten manifest URLs so
// nested playlists, keys and segments are fetched with the same headers.
function proxyExtra(ua, ref) {
  return (ua ? `&ua=${encodeURIComponent(ua)}` : '') + (ref ? `&ref=${encodeURIComponent(ref)}` : '');
}

function isValidUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- Health --------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ---- CORS / stream proxy -------------------------------------------------
// Streams arbitrary http(s) resources through the backend so the browser can
// play streams that lack permissive CORS headers. Honors Range requests.
app.all('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }
  const ua = cleanHeader(req.query.ua);
  const ref = cleanHeader(req.query.ref);
  try {
    const headers = { ...FETCH_HEADERS };
    if (ua) headers['User-Agent'] = ua;
    if (ref) headers.Referer = ref;
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(target, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
    });

    res.status(upstream.status);
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = upstream.headers.get('content-type') || '';
    // Rewrite HLS manifests so nested segment/playlist URLs also flow through the proxy.
    if (/mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(target)) {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, target, proxyExtra(ua, ref));
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.removeHeader('content-length');
      return res.send(rewritten);
    }

    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    res.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Proxy fetch failed', detail: String(err) });
    else res.end();
  }
});

function rewriteManifest(text, manifestUrl, extra = '') {
  const base = new URL(manifestUrl);
  // Relative proxy URL: the browser resolves it against the manifest's own URL,
  // so it inherits the page scheme (https) — no mixed content behind a TLS proxy,
  // and no dependency on req.protocol (which is http inside the container).
  // `extra` re-attaches the UA/Referer so segments inherit the same headers.
  const proxyBase = `/api/proxy?url=`;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // Rewrite URI="..." inside tags (keys, media, etc.)
        return line.replace(/URI="([^"]+)"/g, (full, uri) => {
          const abs = new URL(uri, base).toString();
          return `URI="${proxyBase}${encodeURIComponent(abs)}${extra}"`;
        });
      }
      const abs = new URL(trimmed, base).toString();
      return proxyBase + encodeURIComponent(abs) + extra;
    })
    .join('\n');
}

// ---- Playlist fetch + parse ---------------------------------------------
app.get('/api/playlist', upstreamLimiter, async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) return res.status(400).json({ error: 'Invalid or missing url parameter' });
  try {
    const cached = cacheGet(`pl:${target}`, 60 * 1000);
    let text = cached;
    if (!text) {
      const upstream = await fetch(target, { headers: FETCH_HEADERS, redirect: 'follow' });
      if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
      text = await upstream.text();
      cacheSet(`pl:${target}`, text);
    }
    const channels = parseM3U(text);
    res.json({ url: target, count: channels.length, channels, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch playlist', detail: String(err) });
  }
});

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

// ---- EPG fetch + parse ---------------------------------------------------
// Accepts plain XMLTV and gzip-compressed guides (iptv-org/epg `--gzip` output,
// commonly served as .xml.gz). Guards against oversized downloads / zip bombs.
const EPG_MAX_DOWNLOAD = 200 * 1024 * 1024; // 200 MB compressed
const EPG_MAX_DECOMPRESSED = 600 * 1024 * 1024; // 600 MB after gunzip

app.get('/api/epg', upstreamLimiter, async (req, res) => {
  const target = req.query.url;
  if (!isValidUrl(target)) return res.status(400).json({ error: 'Invalid or missing url parameter' });
  try {
    const cached = cacheGet(`epg:${target}`, 15 * 60 * 1000);
    if (cached) return res.json(cached);

    const upstream = await fetch(target, { headers: FETCH_HEADERS, redirect: 'follow' });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > EPG_MAX_DOWNLOAD) return res.status(413).json({ error: 'EPG file too large' });

    // gzip magic bytes (1f 8b) → a .xml.gz guide; otherwise treat as plain XML.
    let xml;
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      xml = zlib.gunzipSync(buf, { maxOutputLength: EPG_MAX_DECOMPRESSED }).toString('utf8');
    } else {
      xml = buf.toString('utf8');
    }

    const parsed = parseEPG(xml);
    cacheSet(`epg:${target}`, parsed);
    res.json(parsed);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch EPG', detail: String(err) });
  }
});

// ---- Playlists persistence ----------------------------------------------
app.get('/api/playlists', async (req, res) => {
  res.json(await readCollection('playlists'));
});

app.post('/api/playlists', writeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const record = {
      id: body.id || randomUUID(),
      name: body.name || 'Untitled Playlist',
      url: body.url || '',
      type: body.type || 'url',
      channelCount: body.channelCount || 0,
      enabled: body.enabled !== false,
      contentKind: ['live', 'radio', 'auto'].includes(body.contentKind) ? body.contentKind : 'auto',
      hasFile: body.hasFile || false,
      updatedAt: new Date().toISOString(),
    };
    await updateCollection('playlists', (list) => {
      const idx = list.findIndex((p) => p.id === record.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...record };
      else list.push(record);
      return list;
    });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save playlist', detail: String(err) });
  }
});

const PLAYLIST_DIR = path.join(DATA_DIR, 'playlists');
function playlistFilePath(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null; // guard against traversal
  return path.join(PLAYLIST_DIR, `${id}.m3u`);
}

// Store the raw uploaded .m3u so the user can download the original later.
app.put('/api/playlists/:id/file', writeLimiter, async (req, res) => {
  try {
    const fp = playlistFilePath(req.params.id);
    if (!fp) return res.status(400).json({ error: 'Bad id' });
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text || text.length > 64 * 1024 * 1024) return res.status(400).json({ error: 'Empty or oversized file' });
    // Reject binary uploads — a stored .m3u must be text (NUL byte ⇒ not a playlist).
    if (text.includes(String.fromCharCode(0))) return res.status(400).json({ error: 'Invalid playlist: expected M3U text' });
    await fs.mkdir(PLAYLIST_DIR, { recursive: true });
    await fs.writeFile(fp, text, 'utf8');
    await updateCollection('playlists', (list) => {
      const i = list.findIndex((p) => p.id === req.params.id);
      if (i >= 0) list[i].hasFile = true;
      return list;
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to store file', detail: String(err) });
  }
});

// Download the stored raw playlist file.
app.get('/api/playlists/:id/file', async (req, res) => {
  const fp = playlistFilePath(req.params.id);
  if (!fp) return res.status(400).json({ error: 'Bad id' });
  let text;
  try {
    text = await fs.readFile(fp, 'utf8');
  } catch {
    return res.status(404).json({ error: 'No stored file for this playlist' });
  }
  const list = await readCollection('playlists');
  const meta = list.find((p) => p.id === req.params.id);
  const safe = ((meta && meta.name) || 'playlist').replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 80) || 'playlist';
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  if (req.query.dl) res.setHeader('Content-Disposition', `attachment; filename="${safe}.m3u"`);
  res.send(text);
});

app.delete('/api/playlists/:id', writeLimiter, async (req, res) => {
  try {
    await updateCollection('playlists', (list) => list.filter((p) => p.id !== req.params.id));
    const fp = playlistFilePath(req.params.id);
    if (fp) await fs.unlink(fp).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete playlist', detail: String(err) });
  }
});

// ---- Recordings ----------------------------------------------------------
const RECORDING_MAX_MINUTES = parseInt(process.env.RECORDING_MAX_MINUTES || '180', 10);

async function updateRecording(id, patch) {
  await updateCollection('recordings', (list) => {
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list[i] = { ...list[i], ...patch };
    return list;
  });
}

// Called by the recorder when an ffmpeg capture exits.
function onCaptureFinish(patch) {
  updateRecording(patch.id, {
    filename: patch.filename,
    size: patch.size,
    status: patch.status,
    end: patch.end,
    error: patch.error || '',
  }).catch(() => {});
}

app.get('/api/recordings', async (req, res) => {
  const list = await readCollection('recordings');
  // Surface live-growing size for in-progress captures.
  for (const r of list) {
    if (r.status === 'recording' && isRecording(r.id)) {
      const s = await currentSize(r.id);
      if (s != null) r.size = s;
    }
  }
  res.json(list);
});

// Start capturing a channel "now".
app.post('/api/recordings/start', writeLimiter, async (req, res) => {
  const b = req.body || {};
  if (!isValidUrl(b.url)) return res.status(400).json({ error: 'Invalid or missing stream url' });
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
    end: new Date(Date.now() + RECORDING_MAX_MINUTES * 60000).toISOString(),
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
      maxMinutes: RECORDING_MAX_MINUTES,
      userAgent: rec.httpUserAgent || FETCH_HEADERS['User-Agent'],
      referer: rec.httpReferrer,
      onFinish: onCaptureFinish,
    });
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start recording', detail: String(err) });
  }
});

// Stop an in-progress capture (graceful — file is finalised on exit).
app.post('/api/recordings/:id/stop', async (req, res) => {
  stopCapture(req.params.id);
  const rec = (await readCollection('recordings')).find((r) => r.id === req.params.id);
  res.json(rec || { ok: true });
});

// Schedule a future recording (EPG). The scheduler starts/stops capture at its time.
app.post('/api/recordings', writeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const record = {
      id: body.id || randomUUID(),
      channelId: body.channelId || '',
      channelName: body.channelName || 'Unknown',
      channelLogo: body.channelLogo || '',
      url: body.url || '',
      title: body.title || body.channelName || 'Recording',
      httpUserAgent: cleanHeader(body.httpUserAgent),
      httpReferrer: cleanHeader(body.httpReferrer),
      start: body.start || new Date().toISOString(),
      end: body.end || new Date(Date.now() + 3600_000).toISOString(),
      status: body.status || 'scheduled',
      filename: '',
      size: 0,
      createdAt: new Date().toISOString(),
    };
    await updateCollection('recordings', (list) => {
      const idx = list.findIndex((r) => r.id === record.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...record };
      else list.push(record);
      return list;
    });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save recording', detail: String(err) });
  }
});

// Stream a finished recording for playback (Range) or download (?dl=1).
app.get('/api/recordings/:id/file', async (req, res) => {
  const rec = (await readCollection('recordings')).find((r) => r.id === req.params.id);
  if (!rec || !rec.filename) return res.status(404).json({ error: 'No file for this recording' });
  const filePath = resolveFile(DATA_DIR, rec.filename);
  if (!filePath) return res.status(400).json({ error: 'Bad filename' });
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }

  if (req.query.dl) {
    const safe = (rec.title || 'recording').replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 80) || 'recording';
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.mp4"`);
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', stat.size);
  createReadStream(filePath).pipe(res);
});

app.delete('/api/recordings/:id', writeLimiter, async (req, res) => {
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
    res.status(500).json({ error: 'Failed to delete recording', detail: String(err) });
  }
});

// ---- Runtime config exposed to the client --------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    m3uUrl: process.env.M3U_URL || '',
    epgUrl: process.env.EPG_URL || '',
    refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES || '360', 10),
  });
});

// ---- Static frontend (single-image mode) ---------------------------------
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

// SPA fallback — serve index.html for any non-API route.
app.get(/^\/(?!api\/).*/, async (req, res) => {
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
});

// On boot, captures from a previous run are gone — mark them interrupted and
// record whatever partial size landed on disk.
async function reconcileRecordings() {
  const list = await readCollection('recordings');
  let changed = false;
  for (const r of list) {
    if (r.status === 'recording' && !isRecording(r.id)) {
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
    }
  }
  if (changed) await writeCollection('recordings', list);
}

// Start/finish scheduled (EPG) recordings at their programme times.
async function tickScheduler() {
  const now = Date.now();
  const list = await readCollection('recordings');
  for (const r of list) {
    if (r.status !== 'scheduled') continue;
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    if (start <= now && now < end && !isRecording(r.id)) {
      const mins = Math.min(RECORDING_MAX_MINUTES, Math.max(1, Math.ceil((end - now) / 60000)));
      await updateRecording(r.id, { status: 'recording', filename: fileNameFor(r.id), start: new Date().toISOString() });
      startCapture({
        rec: r,
        dataDir: DATA_DIR,
        maxMinutes: mins,
        userAgent: r.httpUserAgent || FETCH_HEADERS['User-Agent'],
        referer: r.httpReferrer,
        onFinish: onCaptureFinish,
      });
    }
  }
}

// Safety net: never let a single stray async error take the whole server down
// (a crashed process would 500 every request, as happened with the temp-file race).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err);
});

await initAuth().catch((e) => console.error('Auth init failed:', e));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`RO-IPTV server listening on http://0.0.0.0:${PORT}`);
  console.log(`Serving static frontend from: ${PUBLIC_DIR}`);
  if (isAuthEnabled()) {
    console.log(
      `🔒 Authentication ENABLED (user: ${currentUsername()})` +
        (needsPasswordChange() ? ' — bootstrap password; change required on first login.' : '')
    );
  } else {
    console.warn('⚠  AUTHENTICATION DISABLED — set AUTH_PASSWORD to require login.');
  }
  await reconcileRecordings().catch(() => {});
  setInterval(() => tickScheduler().catch(() => {}), 30000);
});

// Finalise active captures gracefully on shutdown so MP4s aren't corrupted.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopAll();
    setTimeout(() => process.exit(0), 1500);
  });
}
