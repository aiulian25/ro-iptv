// Exercise the real Makefile with a controlled PATH. No scanner, Docker daemon,
// registry, credential helper or network service is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tools = ['hadolint', 'trivy', 'grype', 'syft'];
const makefile = process.env.AUD003_MAKEFILE || new URL('../../Makefile', import.meta.url);
async function fixture(t, missing) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-scan-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.copyFile(makefile, path.join(root, 'Makefile'));
  for (const tool of ['make', 'date', 'grep', 'mktemp', 'mv', 'rm']) {
    await fs.symlink('/usr/bin/' + tool, path.join(bin, tool));
  }
  for (const tool of [...tools, 'docker', 'gh', 'git']) {
    if (tool === missing) continue;
    await fs.writeFile(path.join(bin, tool), `#!/bin/sh
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$CALLS"
if [ "$name" = syft ]; then printf '%s\\n' '{"spdxVersion":"SPDX-2.3"}'; fi
if [ "$name" = "$FAIL_TOOL" ]; then exit 42; fi
if [ "$name" = gh ]; then printf '%s\\n' synthetic-token; fi
if [ "$name" = git ]; then printf '%s\\n' synthetic-revision; fi
`, { mode: 0o755 });
  }
  const sbom = path.join(root, 'candidate sbom.json');
  await fs.writeFile(sbom, 'previous-good-sbom');
  const calls = path.join(root, 'calls');
  return { root, bin, sbom, calls };
}
async function run(f, target = 'scan', fail = '', parallel = false) {
  const result = spawnSync('/usr/bin/make', [...(parallel ? ['-j4'] : []), target, 'SBOM=' + f.sbom], {
    cwd: f.root, env: { ...process.env, PATH: f.bin, CALLS: f.calls, FAIL_TOOL: fail }, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  return { ...result, calls: await fs.readFile(f.calls, 'utf8').catch(() => '') };
}
for (const tool of tools) {
  test(`scan propagates installed ${tool} failure`, async (t) => {
    const f = await fixture(t);
    const r = await run(f, 'scan', tool);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /scan suite complete|not installed/);
    assert.match(r.stderr, /Error 42/);
    assert.equal(await fs.readFile(f.sbom, 'utf8'), 'previous-good-sbom');
    assert.deepEqual((await fs.readdir(f.root)).filter((v) => v.includes('.tmp.')), []);
  });
  test(`scan truthfully fails when ${tool} is missing`, async (t) => {
    const f = await fixture(t, tool);
    const r = await run(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp('required scanner ' + tool + ' is not installed'));
    assert.doesNotMatch(r.stdout, /scan suite complete/);
  });
}
test('all passing scanners yield success and atomically replace the SBOM', async (t) => {
  const f = await fixture(t);
  const r = await run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scan suite complete/);
  assert.equal(JSON.parse(await fs.readFile(f.sbom, 'utf8')).spdxVersion, 'SPDX-2.3');
  for (const tool of tools) assert.match(r.calls, new RegExp('^' + tool + ' ', 'm'));
  assert.deepEqual((await fs.readdir(f.root)).filter((v) => v.includes('.tmp.')), []);
});
test('failed SBOM rename preserves old artifact and removes the temporary file', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.bin, 'mv'));
  await fs.writeFile(path.join(f.bin, 'mv'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  assert.notEqual((await run(f, 'sbom')).status, 0);
  assert.equal(await fs.readFile(f.sbom, 'utf8'), 'previous-good-sbom');
  assert.deepEqual((await fs.readdir(f.root)).filter((v) => v.includes('.tmp.')), []);
});
for (const fail of ['docker', 'trivy']) {
  test(`parallel release stops before login/publish when ${fail} fails`, async (t) => {
    const f = await fixture(t);
    const r = await run(f, 'release', fail, true);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.calls, /^gh |^docker login |--push|^docker run /m);
  });
}
test('parallel release builds/scans before login and publish', async (t) => {
  const f = await fixture(t);
  const r = await run(f, 'release', '', true);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.calls.split('\n');
  const build = lines.findIndex((v) => v.startsWith('docker build '));
  const login = lines.findIndex((v) => v.startsWith('docker login '));
  const push = lines.findIndex((v) => v.includes('--push'));
  assert.ok(build >= 0 && login > build && push > login);
  for (const tool of tools) {
    const scan = lines.findIndex((v) => v.startsWith(tool + ' '));
    assert.ok(scan > build && scan < login, tool);
  }
});
