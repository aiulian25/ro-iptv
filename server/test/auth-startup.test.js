import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

const authUrl = new URL('../lib/auth.js', import.meta.url).href;
const serverPath = new URL('../index.js', import.meta.url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-auth-startup-'));
test.after(() => fs.rm(root, { recursive: true, force: true }));
function env(dir, password = '') {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;
  return { ...inherited, DATA_DIR: dir, AUTH_USERNAME: 'admin', AUTH_PASSWORD: password,
    AUTH_SESSION_SECRET: '', EPG_URL: '', EPG_SIDECAR_URL: '', M3U_URL: '', REFRESH_INTERVAL_MINUTES: '0', PORT: '0' };
}
function run(dir, script, password = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const a = await import(${JSON.stringify(authUrl)}); ${script}`],
  { env: env(dir, password), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return result;
}
const checkInit = `try { await a.initAuth(); console.log('accepted'); } catch { if (!a.isAuthEnabled() || a.verifyCredentials('admin', 'Bootstrap1')) throw new Error('fail open'); console.log('rejected'); }`;

for (const [name, bytes] of [
  ['truncated', '{"secret":'], ['object', '{}'], ['empty', '[]'],
  ['bad secret', '[{"secret":42}]'], ['missing secret', '[{}]'],
  ['bad credential', '[{"secret":"fixture","credential":{"hash":"x"}}]'],
  ['null credential', '[{"secret":"fixture","credential":null}]'],
]) {
  test(`invalid auth (${name}) rejects without changing bytes or accepting bootstrap`, async () => {
    const dir = await fs.mkdtemp(path.join(root, 'invalid-'));
    const file = path.join(dir, 'auth.json');
    await fs.writeFile(file, bytes);
    for (const password of ['', 'Bootstrap1']) {
      const r = run(dir, checkInit, password);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'rejected');
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
      assert.deepEqual(await fs.readdir(dir), ['auth.json']);
    }
  });
}

test('fresh missing auth supports intentional open mode and bootstrap', async () => {
  for (const password of ['', 'Bootstrap1']) {
    const dir = await fs.mkdtemp(path.join(root, 'fresh-'));
    const r = run(dir, `await a.initAuth(); console.log(JSON.stringify([a.isAuthEnabled(), a.needsPasswordChange()]));`, password);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), [!!password, !!password]);
  }
});

test('stored credentials and sessions survive restart with empty bootstrap', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'restart-'));
  const first = run(dir, `await a.initAuth(); await a.setPassword('Replacement123'); console.log(a.issueToken(1, false).token);`, 'Bootstrap1');
  assert.equal(first.status, 0);
  const token = first.stdout.trim();
  const next = run(dir, `await a.initAuth(); console.log(JSON.stringify([a.isAuthEnabled(), a.needsPasswordChange(), a.verifyCredentials('admin','Replacement123'), a.verifyCredentials('admin','Bootstrap1'), !!a.verifyToken(${JSON.stringify(token)})]));`);
  assert.equal(next.status, 0);
  assert.deepEqual(JSON.parse(next.stdout), [true, false, true, false, true]);
});

for (const kind of ['corrupt', 'directory']) {
  test(`server refuses to listen with ${kind} auth storage`, async () => {
    const dir = await fs.mkdtemp(path.join(root, 'boot-'));
    const file = path.join(dir, 'auth.json');
    if (kind === 'directory') await fs.mkdir(file);
    else await fs.writeFile(file, '{invalid');
    const r = spawnSync(process.execPath, [serverPath.pathname], {
      env: env(dir), encoding: 'utf8', timeout: 3000,
    });
    assert.equal(r.status, 1, 'must exit before opening a listener');
    assert.doesNotMatch(r.stdout, /server listening/);
    assert.match(r.stderr, /Auth init failed/);
  });
}

test('filesystem permission errors propagate without resetting auth', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'permission-'));
  const r = run(dir, `
    const { promises: fs } = await import('node:fs');
    fs.readFile = async () => { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); };
    try { await a.initAuth(); console.log('accepted'); } catch(e) { console.log(e.code); }
  `);
  assert.equal(r.stdout.trim(), 'EACCES');
  assert.deepEqual(await fs.readdir(dir), []);
});


test('legacy credentials with an environment-pinned secret remain compatible', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'pinned-'));
  assert.equal(run(dir, `await a.initAuth(); await a.setPassword('Replacement123');`, 'Bootstrap1').status, 0);
  const file = path.join(dir, 'auth.json');
  const records = JSON.parse(await fs.readFile(file, 'utf8'));
  delete records[0].secret;
  await fs.writeFile(file, JSON.stringify(records));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const a = await import(${JSON.stringify(authUrl)}); await a.initAuth(); console.log(a.verifyCredentials('admin','Replacement123'));`],
    { env: { ...env(dir), AUTH_SESSION_SECRET: 'synthetic-pinned-secret' }, encoding: 'utf8', timeout: 10000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'true');
});
