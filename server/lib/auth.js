// Single-user authentication for RO-IPTV.
//
// Credential model (bootstrap → stored):
//   • On a fresh install the env AUTH_USERNAME/AUTH_PASSWORD (Compose defaults admin/admin)
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

let authState = 'uninitialized'; // disabled | bootstrap | established | error
let secret = null;
let revokedSessions = new Map();
let storedCred = null; // { username, salt, hash, updatedAt } once a password is set

// Fail closed until initialization succeeds, and after any initialization error.
export function isAuthEnabled() {
  return authState !== 'disabled';
}

// The effective username (stored credential wins over env).
export function currentUsername() {
  return storedCred ? storedCred.username : ENV_USERNAME;
}

// The credential a token was minted against. Setting a password writes a new
// updatedAt, so every token signed before it stops verifying. Persisted with the
// credential, so a restart does NOT invalidate sessions — only a password change does.
function credentialVersion() {
  return storedCred ? storedCred.updatedAt : 'env';
}

// True while still on the bootstrap credential (no stored password yet).
export function needsPasswordChange() {
  return authState === 'bootstrap';
}

// Load the signing secret + any stored credential. Called once at boot.
export async function initAuth() {
  authState = 'error';
  secret = null;
  storedCred = null;
  revokedSessions = new Map();
  // Strict reads preserve invalid bytes and propagate I/O errors. Only ENOENT
  // denotes a fresh installation; an existing empty/malformed record is invalid.
  const coll = await readCollection('auth', { strict: true });
  const rec = coll === null ? {} : coll[0];
  if (coll !== null) {
    if (coll.length !== 1 || !rec || typeof rec !== 'object' || Array.isArray(rec) ||
        (Object.hasOwn(rec, 'secret') ? typeof rec.secret !== 'string' || !rec.secret.length :
          !process.env.AUTH_SESSION_SECRET || !Object.hasOwn(rec, 'credential'))) {
      throw new Error('Invalid authentication state');
    }
    if (Object.hasOwn(rec, 'credential')) {
      const c = rec.credential;
      if (!c || typeof c !== 'object' || typeof c.username !== 'string' || !c.username.length ||
          typeof c.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(c.salt) ||
          typeof c.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(c.hash) ||
          typeof c.updatedAt !== 'string' || !Number.isFinite(Date.parse(c.updatedAt))) {
        throw new Error('Invalid authentication credential');
      }
    }
  }
  if (rec.revokedSessions !== undefined) {
    if (!Array.isArray(rec.revokedSessions) || rec.revokedSessions.some(item => !item || !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isFinite(item.exp))) throw new Error('Invalid session revocations');
    revokedSessions = new Map(rec.revokedSessions.filter(item => item.exp > Date.now()).map(item => [item.hash, item.exp]));
  }
  const nextSecret = process.env.AUTH_SESSION_SECRET || rec.secret || crypto.randomBytes(32).toString('hex');
  if (coll === null) {
    await updateCollection('auth', () => [{ secret: nextSecret }], { strict: true });
  }
  secret = nextSecret;
  storedCred = rec.credential || null;
  authState = storedCred ? 'established' : ENV_ENABLED ? 'bootstrap' : 'disabled';
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

export function verifyToken(token, allowRevoked = false) {
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
  // Minted against a password that has since been replaced (or a pre-cv token).
  if (payload.cv !== credentialVersion()) return null;
  if (!allowRevoked && revokedSessions.has(sha(token).toString('hex'))) return null;
  return payload;
}

// Mint a signed token. `mustChange` flags a bootstrap session. Returns { token }.
export function issueToken(days, mustChange) {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  return { token: signToken({ u: currentUsername(), exp, mc: mustChange ? 1 : 0, cv: credentialVersion(), sid: crypto.randomBytes(16).toString('hex') }) };
}

// ---- credential verification --------------------------------------------
// Constant-time. Verifies against the stored credential if present, else the
// env bootstrap credential (which is thereby invalidated once a password is set).
export function verifyCredentials(username, password) {
  if (authState !== 'bootstrap' && authState !== 'established') return false;
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
  if (authState === 'error' || authState === 'uninitialized') throw new Error('Authentication unavailable');
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
  }, { strict: true });
  storedCred = credential;
  authState = 'established';
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
    if (k) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie is not a session */ } }
  }
  return out;
}

export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return verifyToken(token);
}

// Persist only a digest, never the bearer token. Retry is possible if a previous
// revocation was rejected by storage; expiry pruning never revives live sessions.
export async function revokeRequestSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE], payload = verifyToken(token, true);
  if (!payload) return;
  const hash = sha(token).toString('hex');
  revokedSessions.set(hash, payload.exp);
  await updateCollection('auth', list => {
    const entries = (list[0].revokedSessions || []).filter(item => item.exp > Date.now() && item.hash !== hash);
    list[0] = { ...list[0], revokedSessions: [...entries, { hash, exp: payload.exp }] };
    return list;
  }, { strict: true });
}
