'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('plugin exports the loader-required info and init', () => {
    const plugin = require('../server/index.js');
    assert.equal(typeof plugin.info, 'object');
    assert.equal(plugin.info.id, 'apercus-gateway');
    assert.match(plugin.info.id, /^[a-z0-9_-]+$/);
    assert.equal(typeof plugin.info.name, 'string');
    assert.equal(typeof plugin.info.description, 'string');
    assert.equal(typeof plugin.init, 'function');
});

test('binding namespace constant targets the v3 name', () => {
    const { BINDING_SECRET_KEY } = require('../server/core.js');
    assert.equal(BINDING_SECRET_KEY, 'apercus_gateway');
});

test('init fails closed when the loader cwd is not a SillyTavern root', async () => {
    const previous = process.cwd();
    const projectRoot = path.resolve(__dirname, '..');
    const calls = [];
    const router = {
        get(y, handler) { calls.push(['get', y, handler]); },
        post(y, handler) { calls.push(['post', y, handler]); },
    };
    try {
        process.chdir(projectRoot);
        await assert.rejects(
            require('../server/index.js').init(router),
            /SillyTavern/,
        );
        assert.equal(calls.length, 0);
    } finally {
        process.chdir(previous);
    }
});
