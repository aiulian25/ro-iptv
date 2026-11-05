// Outbound-target safety checks (server/lib/http.js).
// PROXY_BLOCK_PRIVATE is read once at module load, so it must be set before the
// import below — hence this lives in its own file.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PROXY_BLOCK_PRIVATE = '1';
const { isValidUrl, isPrivateHost, isBlockedTarget } = await import(process.env.AUD005_HTTP_MODULE || '../lib/http.js');

test('isValidUrl accepts only http(s)', () => {
  assert.equal(isValidUrl('http://example.com/a.m3u'), true);
  assert.equal(isValidUrl('https://example.com/a.m3u'), true);
  assert.equal(isValidUrl('file:///etc/passwd'), false);
  assert.equal(isValidUrl('concat:/etc/passwd'), false);
  assert.equal(isValidUrl(''), false);
  assert.equal(isValidUrl(undefined), false);
});

test('isPrivateHost covers loopback, RFC1918, CGNAT, link-local and internal names', () => {
  for (const host of [
    'localhost',
    'router.local',
    'svc.internal',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    // IPv4-mapped IPv6: the dotted spelling a user types, and the hex-pair form
    // Node's URL parser hands back for it.
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
    'fe90::1',
    '::',
    '224.0.0.1',
    '64:ff9b::7f00:1',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} must be private`);
  }
  for (const host of ['example.com', 'fchannel.example', 'fdomain.example', 'fe80-radio.example', '8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', '::ffff:8.8.8.8', '::ffff:808:808']) {
    assert.equal(isPrivateHost(host), false, `${host} must be public`);
  }
});

test('isBlockedTarget gates on PROXY_BLOCK_PRIVATE and fails closed', () => {
  assert.equal(isBlockedTarget('http://192.168.0.10/list.m3u'), true);
  assert.equal(isBlockedTarget('http://169.254.169.254/latest/meta-data'), true);
  assert.equal(isBlockedTarget('https://example.com/guide.xml'), false);
  assert.equal(isBlockedTarget('not a url'), true, 'unparseable targets fail closed');
});
