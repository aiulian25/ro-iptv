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

  fetchEpg: (url) => jsonFetch(`${BASE}/api/epg?url=${encodeURIComponent(url)}`),

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

// Wrap any stream URL through the backend CORS proxy.
export function proxied(url) {
  if (!url) return url;
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export default api;
