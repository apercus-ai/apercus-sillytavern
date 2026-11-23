// Test-instance only: copy the plugin into a SillyTavern install and point its
// origin constants at the local mock gateway. The repository copies are never
// modified; normal deployments keep the compile-time gw/api hosts.
//
// Usage:
//   node tools/mock-gateway/patch-test-instance.mjs \
//     --server <ST>/plugins/apercus-gateway \
//     --ui <ST>/data/<user>/extensions/apercus-gateway \
//     --base http://127.0.0.1:9100
//   node ... --restore --server ... --ui ...
//
// Safety: only loopback mock base URLs are accepted; deployment targets must
// be outside this repository (the script refuses to overwrite repo sources).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_SOURCE = path.join(ROOT, 'server');
const UI_SOURCE = path.join(ROOT, 'ui');
const SERVER_FILES = [
    'index.js', 'core.js', 'gateway-client.js', 'binding-store.js',
    'secrets-binding.js', 'package.json',
];
const UI_FILES = ['index.js', 'logic.mjs', 'style.css', 'manifest.json'];

function parseArgs(argv) {
    const args = { restore: false, base: 'http://127.0.0.1:9100' };
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (item === '--restore') {
            args.restore = true;
        } else if (item === '--server' || item === '--ui' || item === '--base') {
            const value = argv[index + 1];
            if (!value) throw new Error(`missing value for ${item}`);
            args[item.slice(2)] = value;
            index += 1;
        } else {
            throw new Error(`unknown argument: ${item}`);
        }
    }
    if (!args.server || !args.ui) {
        throw new Error('both --server and --ui deployment directories are required');
    }
    return args;
}

function assertLocalBase(base) {
    let parsed;
    try {
        parsed = new URL(base);
    } catch {
        throw new Error('--base must be a valid URL');
    }
    if (parsed.protocol !== 'http:') throw new Error('--base must use http (local mock only)');
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        throw new Error('--base host must be loopback (127.0.0.1/localhost)');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('--base must be an origin without path/query/hash');
    }
    // The mock always advertises 127.0.0.1; canonicalize localhost so the
    // patched authorize validators match the URL actually returned.
    const port = parsed.port || '80';
    return { base: `http://127.0.0.1:${port}`, host: '127.0.0.1', port };
}

function assertDeployTarget(target, label) {
    const resolved = path.resolve(target);
    const relative = path.relative(ROOT, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error(`--${label} must not point inside the repository (${resolved})`);
    }
    return resolved;
}

function replaceOnce(source, from, to, label) {
    if (!source.includes(from)) throw new Error(`expected source pattern not found: ${label}`);
    return source.replace(from, to);
}

function patchServer(sourceDir, targetDir, baseInfo) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of SERVER_FILES) {
        let content = fs.readFileSync(path.join(sourceDir, name), 'utf8');
        if (name === 'gateway-client.js') {
            content = replaceOnce(
                content,
                "const PORTAL_ORIGIN = 'https://gw.apercus.ai';",
                `const PORTAL_ORIGIN = '${baseInfo.base}';`,
                'gateway-client PORTAL_ORIGIN',
            );
            content = replaceOnce(
                content,
                "const GATEWAY_HOST = 'gw.apercus.ai';",
                `const GATEWAY_HOST = '${baseInfo.host}';`,
                'gateway-client GATEWAY_HOST',
            );
            content = replaceOnce(
                content,
                "if (parsed.protocol !== 'https:') return false;",
                "if (parsed.protocol !== 'http:') return false;",
                'gateway-client authorize protocol',
            );
            content = replaceOnce(
                content,
                "if (parsed.port !== '' && parsed.port !== '443') return false;",
                `if (parsed.port !== '' && parsed.port !== '${baseInfo.port}') return false;`,
                'gateway-client authorize port',
            );
        }
        if (name === 'core.js') {
            content = replaceOnce(
                content,
                "const DATA_ORIGIN = 'https://api.apercus.ai';",
                `const DATA_ORIGIN = '${baseInfo.base}';`,
                'core DATA_ORIGIN',
            );
        }
        fs.writeFileSync(path.join(targetDir, name), content, 'utf8');
    }
}

function patchUi(sourceDir, targetDir, baseInfo) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of UI_FILES) {
        let content = fs.readFileSync(path.join(sourceDir, name), 'utf8');
        if (name === 'logic.mjs') {
            content = replaceOnce(
                content,
                "export const GATEWAY_HOST = 'gw.apercus.ai';",
                `export const GATEWAY_HOST = '${baseInfo.host}';`,
                'ui GATEWAY_HOST',
            );
            content = replaceOnce(
                content,
                "if (parsed.protocol !== 'https:') return false;",
                "if (parsed.protocol !== 'http:') return false;",
                'ui authorize protocol',
            );
            content = replaceOnce(
                content,
                "if (parsed.port !== '' && parsed.port !== '443') return false;",
                `if (parsed.port !== '' && parsed.port !== '${baseInfo.port}') return false;`,
                'ui authorize port',
            );
        }
        fs.writeFileSync(path.join(targetDir, name), content, 'utf8');
    }
}

function copyPristine(sourceDir, targetDir, files) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of files) {
        fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
    }
}

const args = parseArgs(process.argv.slice(2));
const serverTarget = assertDeployTarget(args.server, 'server');
const uiTarget = assertDeployTarget(args.ui, 'ui');
if (args.restore) {
    copyPristine(SERVER_SOURCE, serverTarget, SERVER_FILES);
    copyPristine(UI_SOURCE, uiTarget, UI_FILES);
    console.log('restored deployment files to repository copies');
    process.exit(0);
}

const baseInfo = assertLocalBase(args.base);
patchServer(SERVER_SOURCE, serverTarget, baseInfo);
patchUi(UI_SOURCE, uiTarget, baseInfo);
console.log(`patched TEST deployment for mock gateway ${baseInfo.base}`);
console.log('repository sources unchanged; run --restore to put the real-host copies back');
