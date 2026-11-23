// Integration checks for the test-instance deployment patcher. The patcher
// must only touch deployment copies outside this repo and must canonicalize
// loopback hosts to the address the mock actually advertises.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'mock-gateway', 'patch-test-instance.mjs');

function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30000,
    });
}

test('patch-test-instance: localhost is canonicalized and restore returns real hosts', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mock-patch-'));
    const serverDir = path.join(tempRoot, 'server');
    const uiDir = path.join(tempRoot, 'ui');
    try {
        const patched = run([
            '--server', serverDir,
            '--ui', uiDir,
            '--base', 'http://localhost:9100',
        ]);
        assert.equal(patched.status, 0, patched.stderr);
        const gatewayClient = fs.readFileSync(path.join(serverDir, 'gateway-client.js'), 'utf8');
        assert.match(gatewayClient, /const PORTAL_ORIGIN = 'http:\/\/127\.0\.0\.1:9100';/);
        assert.match(gatewayClient, /const GATEWAY_HOST = '127\.0\.0\.1';/);
        const uiLogic = fs.readFileSync(path.join(uiDir, 'logic.mjs'), 'utf8');
        assert.match(uiLogic, /export const GATEWAY_HOST = '127\.0\.0\.1';/);

        const restored = run(['--restore', '--server', serverDir, '--ui', uiDir]);
        assert.equal(restored.status, 0, restored.stderr);
        const restoredClient = fs.readFileSync(path.join(serverDir, 'gateway-client.js'), 'utf8');
        assert.match(restoredClient, /const PORTAL_ORIGIN = 'https:\/\/gw\.apercus\.ai';/);
        assert.match(restoredClient, /const GATEWAY_HOST = 'gw\.apercus\.ai';/);
        const restoredCore = fs.readFileSync(path.join(serverDir, 'core.js'), 'utf8');
        assert.match(restoredCore, /const DATA_ORIGIN = 'https:\/\/api\.apercus\.ai';/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('patch-test-instance: refuses repository targets and non-loopback bases', () => {
    const repoServer = path.join(ROOT, 'server');
    const repoUi = path.join(ROOT, 'ui');
    const inside = run([
        '--server', repoServer,
        '--ui', repoUi,
        '--base', 'http://127.0.0.1:9100',
    ]);
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /must not point inside the repository/);
    const serverSource = fs.readFileSync(path.join(repoServer, 'core.js'), 'utf8');
    assert.match(serverSource, /const DATA_ORIGIN = 'https:\/\/api\.apercus\.ai';/);

    const external = run([
        '--server', path.join(os.tmpdir(), 'ag-never-server'),
        '--ui', path.join(os.tmpdir(), 'ag-never-ui'),
        '--base', 'http://example.com:9100',
    ]);
    assert.notEqual(external.status, 0);
    assert.match(external.stderr, /loopback/);
});
