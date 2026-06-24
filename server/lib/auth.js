// Single-user authentication for RO-IPTV.
//
// Credential model (bootstrap → stored):
//   • On a fresh install the env AUTH_USERNAME/AUTH_PASSWORD (default admin/admin)
//     act as a ONE-TIME bootstrap credential.
//   • The first login with the bootstrap credential forces a password change.
//   • Setting a new password stores a salted scrypt hash in the /data volume.
//     From then on the stored credential is authoritative and the env bootstrap
//     credential no longer works (it is "invalidated").
//
// Sessions are stateless: a compact HMAC-SHA256 signed token ({u,exp,mc}) carried
// in an HttpOnly cookie. `mc` (must-change) marks a bootstrap session that may
// only change the password until it does so. The signing secret is taken from
// AUTH_SESSION_SECRET or generated once and persisted to /data. Built-in crypto
// only — no extra dependencies.
import crypto from 'crypto';
import { readCollection, updateCollection } from './store.js';

const ENV_USERNAME = process.env.AUTH_USERNAME || 'admin';
const ENV_PASSWORD = process.env.AUTH_PASSWORD || '';
const ENV_ENABLED = ENV_PASSWORD.length > 0;
const SESSION_DAYS = Math.max(1, parseInt(process.env.AUTH_SESSION_DAYS || '30', 10));
const MIN_PASSWORD = 8;

export const COOKIE = 'ro_session';
export const REMEMBER_DAYS = SESSION_DAYS;

let secret = null;
let storedCred = null; // { username, salt, hash, updatedAt } once a password is set

// Auth is on when a bootstrap password is configured OR a stored credential exists.
export function isAuthEnabled() {
  return ENV_ENABLED || !!storedCred;
}

// The effective username (stored credential wins over env).
export function currentUsername() {
  return storedCred ? storedCred.username : ENV_USERNAME;
}

// True while still on the bootstrap credential (no stored password yet).
export function needsPasswordChange() {
  return isAuthEnabled() && !storedCred;
}

// Load the signing secret + any stored credential. Called once at boot.
export async function initAuth() {
  const coll = await readCollection('auth');
  const rec = coll[0] || {};
  if (process.env.AUTH_SESSION_SECRET) {
    secret = process.env.AUTH_SESSION_SECRET;
  } else if (rec.secret) {
    secret = rec.secret;
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    await updateCollection('auth', (list) => {
      list[0] = { ...(list[0] || {}), secret };
      return list;
    });
  }
  if (rec.credential && rec.credential.hash) storedCred = rec.credential;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', secret).update(data).digest();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64);
}

// ---- tokens --------------------------------------------------------------
export function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(hmac(body))}`;
}

export function verifyToken(token) {
  if (!secret || !token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  let expected;
  try {
    expected = Buffer.from(b64url(hmac(body)));
  } catch {
    return null;
  }
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// Mint a signed token. `mustChange` flags a bootstrap session. Returns { token }.
export function issueToken(days, mustChange) {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  return { token: signToken({ u: currentUsername(), exp, mc: mustChange ? 1 : 0 }) };
}

// ---- credential verification --------------------------------------------
// Constant-time. Verifies against the stored credential if present, else the
// env bootstrap credential (which is thereby invalidated once a password is set).
export function verifyCredentials(username, password) {
  if (storedCred) {
    const okUser = crypto.timingSafeEqual(sha(username || ''), sha(storedCred.username));
    const key = scryptHash(password || '', Buffer.from(storedCred.salt, 'hex'));
    const stored = Buffer.from(storedCred.hash, 'hex');
    const okPass = key.length === stored.length && crypto.timingSafeEqual(key, stored);
    return okUser && okPass;
  }
  const okUser = crypto.timingSafeEqual(sha(username || ''), sha(ENV_USERNAME));
  const okPass = crypto.timingSafeEqual(sha(password || ''), sha(ENV_PASSWORD));
  return okUser && okPass;
}

// Validate + persist a new password (salted scrypt hash) to /data. After this,
// the env bootstrap credential no longer authenticates.
export async function setPassword(newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  if (pw === ENV_PASSWORD) {
    return { ok: false, error: 'Choose a password different from the default.' };
  }
  const salt = crypto.randomBytes(16);
  const credential = {
    username: currentUsername(),
    salt: salt.toString('hex'),
    hash: scryptHash(pw, salt).toString('hex'),
    updatedAt: new Date().toISOString(),
  };
  await updateCollection('auth', (list) => {
    list[0] = { ...(list[0] || {}), credential };
    return list;
  });
  storedCred = credential;
  return { ok: true };
}

// ---- cookies -------------------------------------------------------------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return verifyToken(token);
}
