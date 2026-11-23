// Contract-level tests for the local mock gateway. These tests run a real
// HTTP server on 127.0.0.1 with an ephemeral port; no external network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'tools', 'mock-gateway', 'server.mjs')).href;

async function startGateway() {
    const mod = await import(MODULE_URL);
    const gateway = mod.createMockGateway({ port: 0 });
    const started = await gateway.start();
    return {
        gateway,
        base: `http://127.0.0.1:${started.port}`,
    };
}

async function jsonCall(base, pathName, init = {}) {
    const response = await fetch(`${base}${pathName}`, init);
    const text = await response.text();
    let payload = null;
    try {
        payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
        payload = text;
    }
    return { status: response.status, headers: response.headers, payload };
}

async function startAndApprove(base) {
    const started = await jsonCall(base, '/api/connect/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    assert.equal(started.status, 200);
    assert.equal(typeof started.payload.request_ref, 'string');
    assert.equal(typeof started.payload.polling_secret, 'string');
    assert.equal(typeof started.payload.authorize_url, 'string');

    const pending = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: started.payload.polling_secret }),
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.payload.status, 'pending');

    const approved = await fetch(started.payload.authorize_url.replace(
        `${base}/portal/authorize`,
        `${base}/portal/authorize/approve`,
    ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_ref: started.payload.request_ref }),
    });
    assert.equal(approved.status, 200);

    const claimed = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: started.payload.polling_secret }),
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.payload.status, 'approved');
    assert.equal(claimed.payload.connect.username, 'mock-user');
    assert.match(claimed.payload.connect.login_credential, /^cred_/);
    assert.match(claimed.payload.connect.key, /^sk-mock-/);

    const again = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: started.payload.polling_secret }),
    });
    assert.equal(again.status, 404);
    return claimed.payload.connect;
}

test('mock: connect start -> pending -> approve -> exactly-one delivery', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());
    const connect = await startAndApprove(base);
    assert.equal(connect.username, 'mock-user');
});

test('mock: query face accepts the delivered credential and projects contract shapes', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());
    await startAndApprove(base);
    const credential = Array.from(gateway.state.credentials.values())[0].value;

    const models = await jsonCall(base, '/api/plugin/me/models', {
        headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(models.status, 200);
    assert.equal(models.payload.object, 'list');
    assert.ok(models.payload.data.some((item) => item.protocol_faces.includes('chat')));

    const keys = await jsonCall(base, '/api/plugin/me/keys', {
        headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(keys.status, 200);
    assert.equal(keys.payload.keys.length, 1);
    assert.equal(Object.hasOwn(keys.payload.keys[0], 'key'), false);

    const balance = await jsonCall(base, '/api/plugin/me/balance', {
        headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(balance.status, 200);
    assert.match(balance.payload.permanent_balance, /^\d+\.\d{6}$/);
    assert.equal(typeof balance.payload.penalty_input_threshold, 'string');
    assert.equal(typeof balance.payload.penalty_multiplier, 'string');

    const meKey = await jsonCall(base, '/api/plugin/me/key', {
        headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(meKey.status, 200);
    assert.equal(meKey.payload.key, gateway.state.key);
});

test('mock: logout revokes only the current credential; revoke-all revokes all', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());
    const connect = await startAndApprove(base);
    const firstCredential = Array.from(gateway.state.credentials.values())[0].value;

    const logout = await fetch(`${base}/api/plugin/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${firstCredential}` },
    });
    assert.equal(logout.status, 204);
    const afterLogout = await jsonCall(base, '/api/plugin/me', {
        headers: { authorization: `Bearer ${firstCredential}` },
    });
    assert.equal(afterLogout.status, 401);

    const second = await startAndApprove(base);
    assert.notEqual(second.login_credential, firstCredential);
    const credential = Array.from(gateway.state.credentials.values())
        .find((item) => !item.revoked).value;
    const revokeAll = await fetch(`${base}/api/portal/me/plugin-credentials/revoke-all`, {
        method: 'POST',
    });
    assert.equal(revokeAll.status, 204);
    const afterRevokeAll = await jsonCall(base, '/api/plugin/me', {
        headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(afterRevokeAll.status, 401);
});

test('mock: data plane answers sections/layers prompts and rejects a wrong key', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());
    const next = await jsonCall(base, '/api/connect/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const poll = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: next.payload.polling_secret }),
    });
    assert.equal(poll.payload.status, 'pending');
    const approved = await fetch(next.payload.authorize_url.replace(
        `${base}/portal/authorize`,
        `${base}/portal/authorize/approve`,
    ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_ref: next.payload.request_ref }),
    });
    assert.equal(approved.status, 200);
    const claimed = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: next.payload.polling_secret }),
    });
    const key = claimed.payload.connect.key;

    const sections = await jsonCall(base, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'mock-chat-a', messages: [{ role: 'user', content: '你是分节配置器' }] }),
    });
    assert.equal(sections.status, 200);
    const content = JSON.parse(sections.payload.choices[0].message.content);
    assert.ok(Array.isArray(content.sections));
    assert.ok(content.sections.length >= 2);

    const layers = await jsonCall(base, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'mock-chat-a', messages: [{ role: 'user', content: '你是分类器' }] }),
    });
    assert.equal(layers.status, 200);
    assert.equal(JSON.parse(layers.payload.choices[0].message.content).layers['1'], 'structural');

    const denied = await jsonCall(base, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-wrong' },
        body: JSON.stringify({ messages: [] }),
    });
    assert.equal(denied.status, 401);

    // The plugin accepts a /plan body up to 64KiB, but wraps it before forwarding.
    // The mock's data-plane limit must accept that slightly larger body.
    const huge = await jsonCall(base, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: 'mock-chat-a',
            messages: [{ role: 'user', content: 'x'.repeat(70000) }],
            max_tokens: 4096,
        }),
    });
    assert.equal(huge.status, 200);
    assert.equal(huge.payload.choices[0].message.content, 'MOCK_OK');
});

test('mock: cap=1 revokes the previous active credential on a new approval', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());
    const first = await startAndApprove(base);
    const firstCredential = Array.from(gateway.state.credentials.values())
        .find((item) => item.username === 'mock-user').value;
    const second = await startAndApprove(base);
    assert.notEqual(second.login_credential, first.login_credential);
    assert.equal(gateway.state.credentials.get(firstCredential).revoked, true);

    const oldMe = await jsonCall(base, '/api/plugin/me', {
        headers: { authorization: `Bearer ${firstCredential}` },
    });
    assert.equal(oldMe.status, 401);
    const newMe = await jsonCall(base, '/api/plugin/me', {
        headers: { authorization: `Bearer ${second.login_credential}` },
    });
    assert.equal(newMe.status, 200);
});

test('mock: approve/cancel follow the single-404 contract semantics', async (t) => {
    const { gateway, base } = await startGateway();
    t.after(() => gateway.close());

    const request = await jsonCall(base, '/api/connect/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const approve = () => fetch(request.payload.authorize_url.replace(
        `${base}/portal/authorize`,
        `${base}/portal/authorize/approve`,
    ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_ref: request.payload.request_ref }),
    });
    const cancel = () => fetch(request.payload.authorize_url.replace(
        `${base}/portal/authorize`,
        `${base}/portal/authorize/cancel`,
    ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_ref: request.payload.request_ref }),
    });

    assert.equal((await approve()).status, 200);
    assert.equal((await approve()).status, 404, 'second approve is no longer pending');
    assert.equal((await cancel()).status, 404, 'approved request cannot be cancelled');

    const other = await jsonCall(base, '/api/connect/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const cancelOther = () => fetch(other.payload.authorize_url.replace(
        `${base}/portal/authorize`,
        `${base}/portal/authorize/cancel`,
    ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_ref: other.payload.request_ref }),
    });
    assert.equal((await cancelOther()).status, 200);
    const afterCancel = await jsonCall(base, '/api/connect/requests/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ polling_secret: other.payload.polling_secret }),
    });
    assert.equal(afterCancel.status, 404);
    assert.equal((await cancelOther()).status, 404, 'repeat cancel is idempotent-404');
});
