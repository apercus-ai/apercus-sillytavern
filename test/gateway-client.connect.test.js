'use strict';

// server/gateway-client.js（v1.35 connect / plugin 面）全分支锁定：字面 URL、
// 严格解析、404→invalid、固定错误、无重试、无日志、超时/体积上限。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGatewayClient } = require('../server/gateway-client.js');

const START_URL = 'https://gw.apercus.ai/api/connect/requests';
const POLL_URL = 'https://gw.apercus.ai/api/connect/requests/poll';
const LOGOUT_URL = 'https://gw.apercus.ai/api/plugin/logout';
const ME_KEY_URL = 'https://gw.apercus.ai/api/plugin/me/key';

const START_PAYLOAD = {
    request_ref: 'ref_abc',
    polling_secret: 'secret_abc',
    authorize_url: 'https://gw.apercus.ai/portal/connect?request_ref=ref_abc',
    expires_at: '2026-11-23T00:15:00Z',
};

const APPROVED_PAYLOAD = {
    status: 'approved',
    connect: {
        login_credential: 'cred_abc',
        key: 'agw_key_abc',
        username: 'alice',
    },
};

function streamOf(text, chunkSize) {
    const bytes = Buffer.from(text, 'utf8');
    const size = chunkSize || bytes.length || 1;
    return new ReadableStream({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += size) {
                controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
            }
            controller.close();
        },
    });
}

function jsonResponse(payload, status) {
    return { status: status || 200, body: streamOf(JSON.stringify(payload)) };
}

function makeFetch(result) {
    const calls = [];
    async function fetchImpl(url, options) {
        calls.push({ url, options });
        return typeof result === 'function' ? result(url, options) : result;
    }
    fetchImpl.calls = calls;
    return fetchImpl;
}

function makeClient(fetchImpl, timeoutMs) {
    return createGatewayClient({ fetchImpl, timeoutMs });
}

async function assertRejectsWith(promise, code, message) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, message);
        return true;
    });
}

test('startConnect posts {} to the literal connect URL and returns camelCase fields', async () => {
    const fetchImpl = makeFetch(jsonResponse(START_PAYLOAD));
    const client = makeClient(fetchImpl);
    const started = await client.startConnect();
    assert.deepEqual(started, {
        requestRef: 'ref_abc',
        pollingSecret: 'secret_abc',
        authorizeUrl: START_PAYLOAD.authorize_url,
        expiresAt: '2026-11-23T00:15:00Z',
    });
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, START_URL);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.body, '{}');
    assert.deepEqual(call.options.headers, {
        accept: 'application/json',
        'content-type': 'application/json',
    });
    assert.ok(call.options.signal);
    assert.deepEqual(Object.keys(started), ['requestRef', 'pollingSecret', 'authorizeUrl', 'expiresAt']);
});

test('startConnect rejects incomplete shapes and non-whitelist authorize URLs', async () => {
    const badPayloads = [
        {},
        { ...START_PAYLOAD, request_ref: '' },
        { ...START_PAYLOAD, request_ref: 42 },
        { ...START_PAYLOAD, polling_secret: '' },
        { ...START_PAYLOAD, polling_secret: 42 },
        { ...START_PAYLOAD, expires_at: '' },
        { ...START_PAYLOAD, expires_at: 42 },
        { ...START_PAYLOAD, authorize_url: 'http://gw.apercus.ai/authorize' },
        { ...START_PAYLOAD, authorize_url: 'https://evil.example/authorize' },
        { ...START_PAYLOAD, authorize_url: 'https://api.apercus.ai/authorize' },
        { ...START_PAYLOAD, authorize_url: 'https://user:pass@gw.apercus.ai/authorize' },
        { ...START_PAYLOAD, authorize_url: 'https://gw.apercus.ai:8443/authorize' },
        { ...START_PAYLOAD, authorize_url: 42 },
    ];
    for (const payload of badPayloads) {
        const client = makeClient(makeFetch(jsonResponse(payload)));
        await assertRejectsWith(
            client.startConnect(),
            'connect_start_failed',
            '连接发起失败：网关不可用或响应无效，请稍后重试。',
        );
    }
});

test('startConnect maps non-200, bad JSON, network failures, and timeouts to the fixed error', async () => {
    const cases = [
        makeFetch({ status: 429, body: streamOf('{"error":"leak"}') }),
        makeFetch({ status: 500, body: streamOf('{"error":"leak"}') }),
        makeFetch({ status: 200, body: streamOf('{bad') }),
        makeFetch(async () => { throw new TypeError('fetch failed'); }),
    ];
    for (const fetchImpl of cases) {
        const client = makeClient(fetchImpl);
        await assertRejectsWith(
            client.startConnect(),
            'connect_start_failed',
            '连接发起失败：网关不可用或响应无效，请稍后重试。',
        );
        assert.equal(fetchImpl.calls.length, 1);
    }

    const slow = makeFetch((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    }));
    const client = makeClient(slow, 20);
    await assertRejectsWith(
        client.startConnect(),
        'connect_start_failed',
        '连接发起失败：网关不可用或响应无效，请稍后重试。',
    );
    assert.equal(slow.calls.length, 1);
});

test('startConnect cancels oversized response bodies instead of reading them', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(100 * 1024);
    const body = {
        getReader() {
            return {
                read: async () => ({ done: false, value: chunk }),
                cancel: async () => { cancelled = true; },
            };
        },
    };
    const client = makeClient(makeFetch({ status: 200, body }));
    await assertRejectsWith(
        client.startConnect(),
        'connect_start_failed',
        '连接发起失败：网关不可用或响应无效，请稍后重试。',
    );
    assert.equal(cancelled, true);
});

test('pollConnect posts the polling secret and parses pending/approved strictly', async () => {
    const fetchImpl = makeFetch(jsonResponse({ status: 'pending' }));
    const client = makeClient(fetchImpl);
    assert.deepEqual(await client.pollConnect('secret_abc'), { status: 'pending' });
    assert.equal(fetchImpl.calls[0].url, POLL_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'POST');
    assert.equal(fetchImpl.calls[0].options.body, JSON.stringify({ polling_secret: 'secret_abc' }));

    const approved = makeClient(makeFetch(jsonResponse(APPROVED_PAYLOAD)));
    const result = await approved.pollConnect('secret_abc');
    assert.deepEqual(result, {
        status: 'approved',
        connect: {
            loginCredential: 'cred_abc',
            key: 'agw_key_abc',
            username: 'alice',
        },
    });
});

test('pollConnect maps 404 to invalid and every other failure to the fixed error', async () => {
    const notFound = makeClient(makeFetch({ status: 404, body: streamOf('{"error":"nope"}') }));
    assert.deepEqual(await notFound.pollConnect('secret_abc'), { status: 'invalid' });
    assert.equal(notFound.url, undefined);

    const badPayloads = [
        {},
        { status: 'done' },
        { status: 'approved' },
        { status: 'approved', connect: { login_credential: '', key: 'k', username: 'u' } },
        { status: 'approved', connect: { login_credential: 'c', key: '', username: 'u' } },
        { status: 'approved', connect: { login_credential: 'c', key: 'k\nx', username: 'u' } },
        { status: 'approved', connect: { login_credential: 'c', key: 'k', username: '' } },
        { status: 'approved', connect: { login_credential: 'c', key: 'k', username: 42 } },
    ];
    for (const payload of badPayloads) {
        const client = makeClient(makeFetch(jsonResponse(payload)));
        await assertRejectsWith(
            client.pollConnect('secret_abc'),
            'connect_poll_failed',
            '连接状态查询失败：网关不可用或响应无效，请稍后重试。',
        );
    }

    for (const options of [
        { status: 401, body: streamOf('{"error":"leak"}') },
        { status: 500, body: streamOf('') },
        { status: 200, body: streamOf('{bad') },
    ]) {
        const client = makeClient(makeFetch(options));
        await assertRejectsWith(
            client.pollConnect('secret_abc'),
            'connect_poll_failed',
            '连接状态查询失败：网关不可用或响应无效，请稍后重试。',
        );
    }

    await assertRejectsWith(
        makeClient(makeFetch(jsonResponse({ status: 'pending' }))).pollConnect(''),
        'connect_poll_failed',
        '连接状态查询失败：网关不可用或响应无效，请稍后重试。',
    );
});

test('pollConnect never retries (polling itself is the retry mechanism)', async () => {
    const fetchImpl = makeFetch(async () => { throw new TypeError('fetch failed'); });
    const client = makeClient(fetchImpl);
    await assertRejectsWith(
        client.pollConnect('secret_abc'),
        'connect_poll_failed',
        '连接状态查询失败：网关不可用或响应无效，请稍后重试。',
    );
    assert.equal(fetchImpl.calls.length, 1);
});

test('logout sends no body/content-type; 204 succeeds and 401 counts as already revoked (H12)', async () => {
    const fetchImpl = makeFetch({ status: 204 });
    const client = makeClient(fetchImpl);
    assert.deepEqual(await client.logout('cred_abc'), { status: 'logged_out' });
    assert.equal(fetchImpl.calls[0].url, LOGOUT_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'POST');
    assert.equal(fetchImpl.calls[0].options.redirect, 'error');
    // v1.35 connect-0.5：204 无 body；非空体/未知字段 → 422。故只带 accept 与
    // authorization，不发送 body、不发送 content-type。
    assert.deepEqual(fetchImpl.calls[0].options.headers, {
        accept: 'application/json',
        authorization: 'Bearer cred_abc',
    });
    assert.equal(Object.hasOwn(fetchImpl.calls[0].options, 'body'), false);
    assert.ok(fetchImpl.calls[0].options.signal);

    // 严格网关：非空体或 content-type 一律 422；本请求必须通过并拿到 204。
    const strictFetch = makeFetch((url, options) => {
        const hasBody = Object.hasOwn(options, 'body') && options.body !== undefined;
        const hasContentType = Object.hasOwn(options.headers || {}, 'content-type');
        return hasBody || hasContentType ? { status: 422 } : { status: 204 };
    });
    assert.deepEqual(await makeClient(strictFetch).logout('cred_abc'), { status: 'logged_out' });
    assert.equal(Object.hasOwn(strictFetch.calls[0].options, 'body'), false);
    assert.equal(strictFetch.calls[0].options.headers['content-type'], undefined);

    // H12：网关 401 = 该登录凭据已失效/已撤销，等价于远端撤销成功。
    const revoked = makeClient(makeFetch({ status: 401 }));
    assert.deepEqual(await revoked.logout('cred_abc'), { ok: true, alreadyRevoked: true });

    for (const status of [200, 400, 500]) {
        const failing = makeClient(makeFetch({ status }));
        await assertRejectsWith(
            failing.logout('cred_abc'),
            'plugin_logout_failed',
            '退出登录请求失败：网关不可用或响应无效。',
        );
    }
    await assertRejectsWith(
        makeClient(makeFetch({ status: 204 })).logout(''),
        'plugin_logout_failed',
        '退出登录请求失败：网关不可用或响应无效。',
    );
    await assertRejectsWith(
        makeClient(makeFetch(async () => { throw new TypeError('fetch failed'); })).logout('cred_abc'),
        'plugin_logout_failed',
        '退出登录请求失败：网关不可用或响应无效。',
    );
});

test('fetchMeKey GETs the literal URL with Bearer and validates key/username strictly', async () => {
    const fetchImpl = makeFetch(jsonResponse({ key: 'agw_new_key', username: 'alice' }));
    const client = makeClient(fetchImpl);
    assert.deepEqual(await client.fetchMeKey('cred_abc'), { key: 'agw_new_key', username: 'alice' });
    assert.equal(fetchImpl.calls[0].url, ME_KEY_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.deepEqual(fetchImpl.calls[0].options.headers, {
        accept: 'application/json',
        authorization: 'Bearer cred_abc',
    });

    for (const payload of [
        {},
        { key: '', username: 'alice' },
        { key: 'a\nb', username: 'alice' },
        { key: 'k', username: '' },
        { key: 'k', username: 42 },
        { key: 42, username: 'alice' },
        { nope: true },
    ]) {
        await assertRejectsWith(
            makeClient(makeFetch(jsonResponse(payload))).fetchMeKey('cred_abc'),
            'plugin_key_fetch_failed',
            '网关 key 刷新失败：网关不可用或响应无效。',
        );
    }
    for (const options of [{ status: 401 }, { status: 500 }, { status: 200, body: streamOf('{bad') }]) {
        await assertRejectsWith(
            makeClient(makeFetch(options)).fetchMeKey('cred_abc'),
            'plugin_key_fetch_failed',
            '网关 key 刷新失败：网关不可用或响应无效。',
        );
    }
    await assertRejectsWith(
        makeClient(makeFetch(jsonResponse({ key: 'k', username: 'u' }))).fetchMeKey(''),
        'plugin_key_fetch_failed',
        '网关 key 刷新失败：网关不可用或响应无效。',
    );
});

test('the client never logs URLs, bodies, or credential values', async () => {
    const recorded = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => recorded.push({ method, args });
    }
    try {
        const client = makeClient(makeFetch((url) => {
            if (url === START_URL) return jsonResponse(START_PAYLOAD);
            if (url === POLL_URL) return jsonResponse(APPROVED_PAYLOAD);
            if (url === ME_KEY_URL) return jsonResponse({ key: 'agw_key', username: 'alice' });
            return { status: 204 };
        }));
        await client.startConnect();
        await client.pollConnect('secret_abc');
        await client.logout('cred_abc');
        await client.fetchMeKey('cred_abc');

        const failing = makeClient(makeFetch({ status: 500, body: streamOf('leak') }));
        await assert.rejects(failing.startConnect());
        await assert.rejects(failing.pollConnect('secret_abc'));
        await assert.rejects(failing.logout('cred_abc'));
        await assert.rejects(failing.fetchMeKey('cred_abc'));

        assert.equal(recorded.length, 0);
    } finally {
        for (const method of methods) {
            console[method] = originals[method];
        }
    }
});
