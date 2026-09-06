// The credential model (server/lib/auth.js) — the app's only security boundary.
//
// auth.js reads AUTH_* and store.js reads DATA_DIR at module load, so both must be
// set before the dynamic import below, exactly as the other suites do it.
//
// These tests share one module instance on purpose: setPassword() permanently
// replaces the bootstrap credential, and that transition is the thing worth
// testing. They therefore run in order, and the order is load-bearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-auth-'));
const BOOTSTRAP_USERNAME = 'admin';
const BOOTSTRAP_PASSWORD = 'Bootstrap1';
const REPLACEMENT_PASSWORD = 'NewPass123';
const TOO_SHORT_PASSWORD = 'short';
const SESSION_DAYS = 1;

process.env.DATA_DIR = DATA_DIR;
process.env.AUTH_USERNAME = BOOTSTRAP_USERNAME;
process.env.AUTH_PASSWORD = BOOTSTRAP_PASSWORD;
// A secret from the ambient environment would mask the generate-and-persist path.
delete process.env.AUTH_SESSION_SECRET;

const {
  initAuth,
  isAuthEnabled,
  needsPasswordChange,
  currentUsername,
  verifyCredentials,
  issueToken,
  verifyToken,
  signToken,
  setPassword,
} = await import('../lib/auth.js');

test.after(() => fs.rm(DATA_DIR, { recursive: true, force: true }));

// A token minted while still on the bootstrap credential, kept for the final test.
let bootstrapToken = null;

// Replace one character of a base64url string with a different one, keeping the
// length identical so verifyToken has to reject on the signature, not the size.
function flipLastChar(text) {
  const last = text.slice(-1);
  return text.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

test('the bootstrap credential authenticates until a password is stored', async () => {
  await initAuth();

  assert.equal(isAuthEnabled(), true);
  assert.equal(needsPasswordChange(), true, 'no stored credential yet');
  assert.equal(currentUsername(), BOOTSTRAP_USERNAME);

  assert.equal(verifyCredentials(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD), true);
  assert.equal(verifyCredentials(BOOTSTRAP_USERNAME, 'wrong-password'), false);
  assert.equal(verifyCredentials('not-admin', BOOTSTRAP_PASSWORD), false);
  assert.equal(verifyCredentials('', ''), false);
});

test('a freshly issued token verifies', () => {
  bootstrapToken = issueToken(SESSION_DAYS, false).token;

  const payload = verifyToken(bootstrapToken);
  assert.ok(payload, 'the token it just minted must verify');
  assert.equal(payload.u, BOOTSTRAP_USERNAME);
  assert.equal(payload.mc, 0);
  assert.ok(payload.exp > Date.now());
});

test('a token with a tampered signature is rejected', () => {
  const [body, signature] = issueToken(SESSION_DAYS, false).token.split('.');

  assert.equal(verifyToken(`${body}.${flipLastChar(signature)}`), null);
});

// Forging a session means changing the payload — flipping `mc` to escape the
// forced password change, or `u` to become another user — and the signature no
// longer matches the body.
test('a token with a tampered payload is rejected', () => {
  const token = issueToken(SESSION_DAYS, true).token;
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

  const forged = Buffer.from(JSON.stringify({ ...payload, mc: 0 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${signature}`), null);
});

test('an expired token is rejected even though its signature is valid', () => {
  // Signed here rather than issued, because issueToken cannot mint a past expiry.
  // `cv` matches the current credential so the expiry is the only thing wrong.
  const expired = signToken({ u: BOOTSTRAP_USERNAME, exp: Date.now() - 1000, mc: 0, cv: 'env' });

  assert.equal(verifyToken(expired), null);
});

test('malformed tokens are rejected rather than throwing', () => {
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken('no-dot-in-here'), null);
  assert.equal(verifyToken('not-base64.also-not-base64'), null);
});

test('setPassword rejects a password that is too short or still the bootstrap one', async () => {
  const tooShort = await setPassword(TOO_SHORT_PASSWORD);
  assert.equal(tooShort.ok, false);
  assert.match(tooShort.error, /8 characters/);

  const sameAsBootstrap = await setPassword(BOOTSTRAP_PASSWORD);
  assert.equal(sameAsBootstrap.ok, false);

  // Neither rejection may have replaced the credential.
  assert.equal(verifyCredentials(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD), true);
});

test('storing a password invalidates the bootstrap credential', async () => {
  const result = await setPassword(REPLACEMENT_PASSWORD);
  assert.equal(result.ok, true);

  assert.equal(verifyCredentials(BOOTSTRAP_USERNAME, REPLACEMENT_PASSWORD), true);
  assert.equal(verifyCredentials(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD), false);
  assert.equal(needsPasswordChange(), false);
});

// The credential-version claim: every session signed against the old password dies
// with it, so a stolen cookie cannot outlive a password change.
test('a token issued before the password change no longer verifies', () => {
  assert.equal(verifyToken(bootstrapToken), null);
  assert.ok(verifyToken(issueToken(SESSION_DAYS, false).token), 'a token issued after it does');
});
