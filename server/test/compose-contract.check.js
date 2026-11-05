import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.AUD020_COMPOSE_ROOT || repo;
const bases = ['docker-compose.yml', 'docker-compose.build.yml'];
function render(base, env = {}, overlay = false) {
  const args = ['compose', '--project-directory', repo, '--env-file', '/dev/null', '-f', path.join(root, base)];
  if (overlay) args.push('-f', path.join(root, 'docker-compose.epg.yml'));
  args.push('config', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, { cwd: repo, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
}
for (const base of bases) {
  test(base + ': unset / explicit empty / custom bootstrap and security forwarding', () => {
    for (const password of [undefined, '', 'SyntheticBootstrap123']) {
      const env = { AUTH_SESSION_SECRET: 'synthetic-session-signing-secret', RL_LOGIN_MAX: '3', HSTS_MAX_AGE: '12345', PORT: '57017', ...(password === undefined ? {} : { AUTH_PASSWORD: password }) };
      const config = render(base, env), app = config.services['ro-iptv'];
      assert.equal(app.environment.AUTH_PASSWORD, password ?? 'admin');
      for (const key of ['AUTH_SESSION_SECRET', 'RL_LOGIN_MAX', 'HSTS_MAX_AGE', 'PORT']) assert.equal(app.environment[key], env[key]);
      assert.equal(app.ports[0].published, '57017'); assert.equal(app.ports[0].target, 57017);
      assert.ok(app.healthcheck.test.some(value => value.includes(':57017/api/health')));
      assert.equal(app.environment.EPG_SIDECAR_ENABLED, '0'); assert.equal(app.environment.EPG_SIDECAR_URL, '');
      assert.equal(config.services.epg, undefined);
    }
  });
  test(base + ': a stale URL alone stays off; explicit overlay enables and starts the sidecar', () => {
    const stale = render(base, { EPG_SIDECAR_URL: 'http://old-sidecar:3000/guide.xml' });
    assert.equal(stale.services['ro-iptv'].environment.EPG_SIDECAR_ENABLED, '0'); assert.equal(stale.services.epg, undefined);
    const on = render(base, {}, true); assert.ok(on.services.epg); assert.equal(on.services.epg.profiles, undefined);
    assert.equal(on.services['ro-iptv'].environment.EPG_SIDECAR_ENABLED, '1');
    assert.equal(on.services['ro-iptv'].environment.EPG_SIDECAR_URL, 'http://epg:3000/guide.xml');
    assert.equal(on.services.epg.volumes[0].volume.subpath, 'epg'); assert.equal(on.services.epg.volumes[0].read_only, true);
    assert.equal(on.services.epg.depends_on['ro-iptv'].condition, 'service_healthy');
    const custom = render(base, { EPG_SIDECAR_URL: 'http://guide.example/custom.xml' }, true);
    assert.equal(custom.services['ro-iptv'].environment.EPG_SIDECAR_URL, 'http://guide.example/custom.xml');
  });
}
test('published and source-build application runtime environment contracts match', () => {
  assert.deepEqual(render(bases[0]).services['ro-iptv'].environment, render(bases[1]).services['ro-iptv'].environment);
});
