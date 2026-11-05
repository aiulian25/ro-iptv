import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verificationFixture } from './helpers/verification-fixture.js';
const require = createRequire(import.meta.url), proxyaddr = require('proxy-addr'), qs = require('qs');

test('mapped IPv6 trust does not silently trust unrelated IPv4 peers', () => {
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/8')('198.51.100.9', 0), false);
  assert.equal(proxyaddr.compile('10.0.0.0/8')('10.2.3.4', 0), true);
  assert.equal(proxyaddr.compile('10.0.0.0/8')('198.51.100.9', 0), false);
  assert.doesNotThrow(() => qs.stringify(qs.parse('x[constructor][isBuffer]=bad', { plainObjects: true })));
});
test('request IP/protocol respects zero, numeric, CIDR and mapped trust profiles', async t => {
  for (const [trust, forwarded, expected] of [
    ['', '198.51.100.9', '127.0.0.1'], ['1', '198.51.100.9', '198.51.100.9'],
    ['2', '198.51.100.9, 127.0.0.2', '198.51.100.9'], ['127.0.0.0/8', '198.51.100.9, 127.0.0.2', '198.51.100.9'],
    ['::ffff:10.0.0.0/8', '198.51.100.9', '127.0.0.1'],
  ]) {
    await t.test('TRUST_PROXY=' + (trust || 'off'), async () => {
      const f = await verificationFixture({ env: { TRUST_PROXY: trust } });
      try {
        const r = await f.request('/api/__verification/request', { headers: { cookie: f.cookie, 'x-forwarded-for': forwarded, 'x-forwarded-proto': 'https' } });
        const value = await r.json(); assert.ok(value.ip.endsWith(expected), JSON.stringify(value)); assert.equal(value.secure, !!trust && trust !== '::ffff:10.0.0.0/8');
        const query = await f.request('/api/health?x[constructor][isBuffer]=bad&x[toString]=bad'); assert.equal(query.status, 200);
      } finally { await f.cleanup(); }
    });
  }
});
test('spoofing forwarding headers cannot evade the default login limiter', async () => {
  const f = await verificationFixture({ authenticate: false, env: { RATE_LIMIT_DISABLED: '', RL_LOGIN_MAX: '3' } });
  try {
    for (let i = 0; i < 5; i++) {
      const response = await f.post('/api/auth/login', { username: 'wrong', password: 'wrong' }, { 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-forwarded-proto': 'https' });
      assert.equal(response.status, i < 3 ? 401 : 429);
    }
  } finally { await f.cleanup(); }
});
test('mutation origins, remembered cookies and persisted per-session revocation', async () => {
  const f = await verificationFixture();
  try {
    const login = async remember => {
      const r = await f.post('/api/auth/login', { username: 'fixture', password: 'fixture-established', remember }); assert.equal(r.status, 200); return r.headers.get('set-cookie');
    };
    const a = await login(false), b = await login(true); assert.doesNotMatch(a, /Max-Age=|Expires=/i); assert.match(b, /Max-Age=/i);
    const ca = a.split(';')[0], cb = b.split(';')[0]; assert.notEqual(ca, cb);
    for (const route of ['/api/auth/logout', '/api/recordings/missing/stop', '/api/auth/login']) {
      const r = await f.post(route, {}, { cookie: ca, origin: 'http://127.0.0.1:1' }); assert.equal(r.status, 403); assert.equal(r.headers.get('set-cookie'), null);
    }
    const r = await f.post('/api/auth/logout', {}, { cookie: ca, origin: f.base }); assert.equal(r.status, 200);
    assert.equal((await (await f.request('/api/auth/status', { headers: { cookie: ca } })).json()).authed, false);
    assert.equal((await (await f.request('/api/auth/status', { headers: { cookie: cb } })).json()).authed, true);
    await f.restart();
    assert.equal((await (await f.request('/api/auth/status', { headers: { cookie: ca } })).json()).authed, false);
    assert.equal((await (await f.request('/api/auth/status', { headers: { cookie: cb } })).json()).authed, true);
    assert.equal((await f.request('/api/recordings', { headers: { cookie: 'ro_session=%broken' } })).status, 401);
  } finally { await f.cleanup(); }
});
test('two-device stale writes are rejected without replacing current shared data', async () => {
  const f = await verificationFixture();
  try {
    const put = (value, baseUpdatedAt) => f.request('/api/state/favourites', { method: 'PUT', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ value, baseUpdatedAt }) });
    const first = await put(['a'], 0); assert.equal(first.status, 200); const base = await first.json();
    const accepted = await put(['a', 'b'], base.updatedAt); assert.equal(accepted.status, 200); const latest = await accepted.json();
    const stale = await put(['a', 'c'], base.updatedAt); assert.equal(stale.status, 409); const conflict = await stale.json(); assert.deepEqual(conflict.current.value, ['a', 'b']); assert.equal(conflict.current.updatedAt, latest.updatedAt);
    assert.equal((await put(['unguarded'])).status, 409);
    const read = await (await f.request('/api/state', { headers: { cookie: f.cookie } })).json(); assert.deepEqual(read.find(r => r.key === 'favourites').value, ['a', 'b']);
  } finally { await f.cleanup(); }
});
