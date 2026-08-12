// Thin client over the RO-IPTV backend API.
const BASE = '';

// A session expiring mid-use returns 401 from a guarded endpoint. Register a
// handler (the store does) so the app can flip back to the login screen.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function jsonFetch(url, opts) {
  // same-origin includes the HttpOnly session cookie on every API call.
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    onUnauthorized?.();
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // ---- auth ----
  authStatus: () => jsonFetch(`${BASE}/api/auth/status`),
  // Login is kept off the global 401 handler so the real error message
  // ("Invalid username or password") reaches the form.
  login: async (username, password, remember) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data;
  },
  logout: () =>
    fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'same-origin' })
      .then((r) => r.json())
      .catch(() => ({})),
  // Set a new password. currentPassword is only needed for a voluntary change
  // (a forced first-login change is authorised by the bootstrap session itself).
  changePassword: async (newPassword, remember, currentPassword) => {
    const res = await fetch(`${BASE}/api/auth/password`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword, remember, currentPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not set password');
    return data;
  },

  config: () => jsonFetch(`${BASE}/api/config`),

  fetchPlaylistFromUrl: (url) => jsonFetch(`${BASE}/api/playlist?url=${encodeURIComponent(url)}`),

  parseText: (text) =>
    jsonFetch(`${BASE}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    }),

  fetchEpg: (url) => jsonFetch(`${BASE}/api/epg?url=${encodeURIComponent(url)}&hours=48`),

  // Cross-device state sync (favourites / history / settings).
  listState: () => jsonFetch(`${BASE}/api/state`),
  saveState: (key, value) =>
    jsonFetch(`${BASE}/api/state/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }),

  listPlaylists: () => jsonFetch(`${BASE}/api/playlists`),
  savePlaylist: (p) =>
    jsonFetch(`${BASE}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }),
  deletePlaylist: (id) => jsonFetch(`${BASE}/api/playlists/${id}`, { method: 'DELETE' }),
  // Store the raw uploaded .m3u so it can be downloaded later.
  savePlaylistFile: (id, text) =>
    fetch(`${BASE}/api/playlists/${id}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    }).then((r) => {
      if (!r.ok) throw new Error('Failed to store playlist file');
    }),

  listRecordings: () => jsonFetch(`${BASE}/api/recordings`),
  // Storage meter: recordings footprint, free/total disk, and the optional cap.
  storage: () => jsonFetch(`${BASE}/api/storage`),
  // Schedule a future (EPG) recording.
  saveRecording: (r) =>
    jsonFetch(`${BASE}/api/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    }),
  // Start / stop a live capture to disk.
  startRecording: (r) =>
    jsonFetch(`${BASE}/api/recordings/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    }),
  stopRecording: (id) => jsonFetch(`${BASE}/api/recordings/${id}/stop`, { method: 'POST' }),
  deleteRecording: (id) => jsonFetch(`${BASE}/api/recordings/${id}`, { method: 'DELETE' }),
};

// Download URL for a stored raw playlist file.
export function playlistDownloadUrl(id) {
  return `${BASE}/api/playlists/${id}/file?dl=1`;
}

// URLs for the captured recording file (playback supports Range; ?dl=1 downloads).
export function recordingFileUrl(id) {
  return `${BASE}/api/recordings/${id}/file`;
}
export function recordingDownloadUrl(id) {
  return `${BASE}/api/recordings/${id}/file?dl=1`;
}

// Wrap any stream URL through the backend CORS proxy. Optional per-channel
// headers (User-Agent / Referer) are forwarded to the upstream — some streams
// only respond when these are present.
export function proxied(url, ua = '', referer = '') {
  if (!url) return url;
  let out = `/api/proxy?url=${encodeURIComponent(url)}`;
  if (ua) out += `&ua=${encodeURIComponent(ua)}`;
  if (referer) out += `&ref=${encodeURIComponent(referer)}`;
  return out;
}

// Per-session memo of which upstream URLs played directly (bandwidth saver): the
// player probes direct-first and records the outcome so later zaps skip re-probing.
const DIRECT_MEMO_KEY = 'ro-iptv:directok';

function readDirectMemo() {
  try {
    return JSON.parse(sessionStorage.getItem(DIRECT_MEMO_KEY) || '{}');
  } catch {
    return {};
  }
}

// Record whether a URL played directly (true) or had to fall back to the proxy (false).
export function memoDirect(url, ok) {
  try {
    const memo = readDirectMemo();
    memo[url] = ok;
    sessionStorage.setItem(DIRECT_MEMO_KEY, JSON.stringify(memo));
  } catch {
    /* storage disabled / private mode — just skip the memo */
  }
}

// Ordered playback sources for a channel: [direct, proxied] when a direct attempt
// is worth trying, else [proxied] only. Direct is skipped when the stream needs
// custom headers (only the proxy forwards them), when an http URL on an https page
// would be blocked as mixed content, or when a prior direct attempt is known to fail.
export function sourceCandidates(channel) {
  const { url = '', httpUserAgent, httpReferrer } = channel || {};
  const proxiedUrl = proxied(url, httpUserAgent, httpReferrer);
  if (httpUserAgent || httpReferrer) return [proxiedUrl];
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http:')) {
    return [proxiedUrl];
  }
  if (readDirectMemo()[url] === false) return [proxiedUrl];
  return [url, proxiedUrl];
}

export default api;
