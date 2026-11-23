'use strict';

// B3 查询面（v1.35 /api/plugin/me/*）与 /status、/login、路由接线的行为锁定。
// createCore 使用真实 gateway-client（注入假 fetch），因此 URL、Bearer 与严格
// 解析都在真实客户端里检查；服务端只投影/转发。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createCore,
    PORTAL_ORIGIN,
    DATA_ORIGIN,
} = require('../server/core.js');

const ME_URL = `${PORTAL_ORIGIN}/api/plugin/me`;
const ME_KEY_URL = `${PORTAL_ORIGIN}/api/plugin/me/key`;
const KEYS_URL = `${PORTAL_ORIGIN}/api/plugin/me/keys`;
const MODELS_URL = `${PORTAL_ORIGIN}/api/plugin/me/models`;
const BALANCE_URL = `${PORTAL_ORIGIN}/api/plugin/me/balance`;

const STATUS_BASE = {
    authAvailable: false,
    connected: false,
    connect_pending: false,
    code: 'pass_binding_unavailable',
    message: '网关 Pass 账户绑定尚未开放：网关授权与交付契约未完成，登录暂不可用。',
    protocols: { chat: false, anthropic: false, responses: false },
    st_connection: { state: 'unknown' },
};

const MESSAGES = {
    forbidden: '未登录或会话无效。',
    notConnected: '尚未完成 Apercus 网关账户绑定。',
    upstream: '网关暂时不可用，请稍后重试。',
    timeout: '网关响应超时，请稍后重试。',
    invalid: '网关返回了无法识别的响应。',
    internal: '网关插件内部错误。',
    loginInvalid: '登录已失效或已撤销，请重新连接 Apercus 网关。',
};

function makeRes() {
    const headers = {};
    return {
        statusCode: 200,
        headers,
        body: '',
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        end(value) {
            this.body = value || '';
        },
    };
}

async function call(handler, req) {
    const res = makeRes();
    await handler(req, res);
    return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body,
        json: () => JSON.parse(res.body),
    };
}

function makeReq(directories, extra) {
    const opts = extra || {};
    const req = {
        method: 'GET',
        url: '/api/plugins/apercus-gateway/status',
        ...opts,
        headers: { host: 'localhost', ...(opts.headers || {}) },
    };
    req.user = { directories };
    return req;
}

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
    return {
        status: status || 200,
        body: streamOf(JSON.stringify(payload)),
    };
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

const VALID_MODELS = {
    object: 'list',
    data: [
        {
            id: 'gpt-test',
            object: 'model',
            protocol_faces: ['chat', 'anthropic'],
            modality: 'text',
            capabilities: '{"tools": true}',
            classification_name: 'standard',
            unknown_field: 'drop-me',
        },
        {
            id: 'image-test',
            object: 'model',
            protocol_faces: ['image'],
        },
    ],
};

const VALID_BALANCE = {
    permanent_balance: '1.000000',
    debt: '0.000000',
    daily_quota: '5.000000',
    daily_quota_used: '2.500000',
    daily_quota_remaining: '2.500000',
    quota_date: '2026-11-12',
    needs_refresh: false,
    observed_at: '2026-11-12T00:00:00Z',
    penalty_input_threshold: '1000',
    penalty_multiplier: '1000',
    wallet_balance: '1.000000',
    unknown_field: 'drop-me',
};

const VALID_KEYS = {
    keys: [
        { id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled', unknown_field: 'drop-me' },
    ],
};

function buildCore(overrides) {
    const options = overrides || {};
    return createCore({
        readBinding: options.readBinding || (async () => null),
        fetchImpl: options.fetchImpl || makeFetch(jsonResponse(VALID_MODELS)),
        connectTimeoutMs: options.connectTimeoutMs,
        maxBytes: options.maxBytes,
    });
}

function assertNoStore(result) {
    assert.equal(result.headers['cache-control'], 'no-store');
}

test('status v3: a stored binding reports authorized without claiming connected', async () => {
    const fetchImpl = makeFetch(jsonResponse({ key: 'agw_test_binding', username: 'alice' }));
    const core = createCore({
        readBinding: async () => ({
            loginCredential: 'cred_test',
            key: 'agw_test_binding',
            username: 'alice',
        }),
        fetchImpl,
    });
    const result = await call(core.handlers.status, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
        ...STATUS_BASE,
        code: 'authorized',
        message: '已授权（已授权不等于已连接）。',
        state: 'authorized',
        username: 'alice',
    });
    assert.equal(result.json().connected, false);
    assertNoStore(result);
    // S10/F9 启动探活：首次授权态 status 异步打一次 /api/plugin/me/key（响应不阻塞）。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, ME_KEY_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
});

test('status v3: no binding, no session reports not_connected', async () => {
    const core = createCore({
        readBinding: async () => null,
        fetchImpl: makeFetch(jsonResponse(VALID_MODELS)),
    });
    const result = await call(core.handlers.status, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { ...STATUS_BASE, state: 'not_connected' });
    assertNoStore(result);
});

test('query endpoints require req.user (401) and well-formed directories (403)', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_MODELS));
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
    });
    for (const name of ['keys', 'models', 'balance']) {
        const result = await call(core.handlers[name], { method: 'GET', url: '/', headers: { host: 'localhost' }, user: undefined });
        assert.equal(result.statusCode, 401, `${name} missing user`);
        assert.equal(result.json().error.code, 'unauthorized', name);
        assertNoStore(result);

        for (const user of [{}, { directories: {} }, { directories: { root: 123 } }, { directories: { root: '' } }]) {
            const bad = await call(core.handlers[name], { method: 'GET', url: '/', headers: { host: 'localhost' }, user });
            assert.equal(bad.statusCode, 403, `${name} malformed directories`);
            assert.equal(bad.json().error.code, 'forbidden', name);
        }
    }
    assert.equal(fetchImpl.calls.length, 0);
});

test('status and login: missing req.user is 401, malformed directories stay 403', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_MODELS));
    const core = createCore({
        readBinding: async () => null,
        fetchImpl,
    });
    for (const name of ['status', 'login']) {
        // spec B1：全部路由缺 req.user → 401。
        const missing = await call(core.handlers[name], { method: 'GET', url: '/', headers: { host: 'localhost' }, user: undefined });
        assert.equal(missing.statusCode, 401, name);
        assert.equal(missing.json().error.code, 'unauthorized', name);
        assertNoStore(missing);

        for (const user of [{}, { directories: {} }, { directories: { root: 123 } }, { directories: { root: '' } }]) {
            const result = await call(core.handlers[name], { method: 'GET', url: '/', headers: { host: 'localhost' }, user });
            assert.equal(result.statusCode, 403, name);
            assert.equal(result.json().error.code, 'forbidden', name);
            assert.equal(result.json().error.message, MESSAGES.forbidden, name);
            assertNoStore(result);
        }
    }
    assert.equal(fetchImpl.calls.length, 0);
});

test('login is always 501 pass_binding_unavailable', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_BALANCE));
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.login, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 501);
    assert.deepEqual(result.json(), {
        error: { code: 'pass_binding_unavailable', message: STATUS_BASE.message },
    });
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 0);
});

test('keys, models and balance return 409 not_connected without a binding', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_MODELS));
    const seenDirectories = [];
    const core = createCore({
        readBinding: async (directories) => {
            seenDirectories.push(directories);
            return null;
        },
        fetchImpl,
    });
    const dirs = { root: '/u/alice' };
    for (const name of ['keys', 'models', 'balance']) {
        const result = await call(core.handlers[name], makeReq(dirs));
        assert.equal(result.statusCode, 409, name);
        assert.equal(result.json().error.code, 'not_connected', name);
        assert.equal(result.json().error.message, MESSAGES.notConnected, name);
        assertNoStore(result);
    }
    assert.deepEqual(seenDirectories, [dirs, dirs, dirs]);
    assert.equal(fetchImpl.calls.length, 0);
});

test('a legacy key-only record cannot use the query plane (no login credential)', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_MODELS));
    const core = createCore({
        readBinding: async () => 'agw_legacy_key',
        fetchImpl,
    });
    for (const name of ['keys', 'models', 'balance']) {
        const result = await call(core.handlers[name], makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 409, name);
        assert.equal(result.json().error.code, 'not_connected', name);
    }
    assert.equal(fetchImpl.calls.length, 0);
});

test('per-request directories isolate users and send the login credential as Bearer', async () => {
    const fetchImpl = makeFetch((url) => {
        if (url === MODELS_URL) return jsonResponse(VALID_MODELS);
        if (url === KEYS_URL) return jsonResponse(VALID_KEYS);
        throw new Error(`unexpected url ${url}`);
    });
    const core = createCore({
        readBinding: async (directories) => {
            if (directories.root === '/u/alice') {
                return { loginCredential: 'cred_alice', key: 'agw_alice', username: 'alice' };
            }
            if (directories.root === '/u/bob') {
                return { loginCredential: 'cred_bob', key: 'agw_bob', username: 'bob' };
            }
            return null;
        },
        fetchImpl,
    });

    const alice = await call(core.handlers.models, makeReq({ root: '/u/alice' }, {
        headers: { 'x-user-id': 'bob', authorization: 'Bearer client-supplied' },
    }));
    const bob = await call(core.handlers.keys, makeReq({ root: '/u/bob' }));
    const nobody = await call(core.handlers.balance, makeReq({ root: '/u/charlie' }));

    assert.equal(alice.statusCode, 200);
    assert.equal(bob.statusCode, 200);
    assert.equal(nobody.statusCode, 409);
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer cred_alice');
    assert.equal(fetchImpl.calls[1].options.headers.authorization, 'Bearer cred_bob');
    assert.equal(JSON.stringify(alice.body).includes('cred_alice'), false);
    assert.equal(JSON.stringify(alice.body).includes('agw_alice'), false);
    assert.equal(JSON.stringify(bob.body).includes('cred_bob'), false);
});

test('binding reader failures are treated as not connected', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_MODELS));
    const core = createCore({
        readBinding: async () => {
            throw new Error('secrets file unreadable');
        },
        fetchImpl,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
    assert.equal(JSON.stringify(result.body).includes('secrets file unreadable'), false);
});

test('models, keys and balance use the fixed gateway query URLs', async () => {
    const fetchImpl = makeFetch((url) => {
        if (url === MODELS_URL) return jsonResponse(VALID_MODELS);
        if (url === KEYS_URL) return jsonResponse(VALID_KEYS);
        if (url === BALANCE_URL) return jsonResponse(VALID_BALANCE);
        if (url === ME_URL) return jsonResponse({ username: 'alice' });
        throw new Error(`unexpected url ${url}`);
    });
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred_alice', key: 'agw_alice', username: 'alice' }),
        fetchImpl,
    });
    const hostile = {
        method: 'GET',
        headers: {
            host: 'localhost',
            'x-apercus-url': 'https://evil.example/catalog',
            authorization: 'Bearer client-supplied',
        },
        query: { url: 'https://evil.example/catalog', user_id: '42' },
        body: { url: 'https://evil.example/catalog' },
    };
    const models = await call(core.handlers.models, makeReq({ root: '/u/alice' }, hostile));
    const keys = await call(core.handlers.keys, makeReq({ root: '/u/alice' }, hostile));
    const balance = await call(core.handlers.balance, makeReq({ root: '/u/alice' }, hostile));
    assert.equal(models.statusCode, 200);
    assert.equal(keys.statusCode, 200);
    assert.equal(balance.statusCode, 200);
    assert.deepEqual(fetchImpl.calls.map((item) => item.url), [MODELS_URL, KEYS_URL, BALANCE_URL]);
    for (const recorded of fetchImpl.calls) {
        assert.deepEqual(recorded.options.headers, {
            accept: 'application/json',
            authorization: 'Bearer cred_alice',
        });
        assert.equal(recorded.options.method, 'GET');
        assert.equal(recorded.options.redirect, 'error');
        assert.ok(recorded.options.signal);
    }
});

test('model projection maps id to name, drops unknown fields, keeps optional catalog fields', async () => {
    const core = buildCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    const payload = result.json();
    assert.deepEqual(payload.items[0], {
        name: 'gpt-test',
        protocol_faces: ['chat', 'anthropic'],
        modality: 'text',
        capabilities: '{"tools": true}',
        classification_name: 'standard',
    });
    assert.deepEqual(payload.items[1], {
        name: 'image-test',
        protocol_faces: ['image'],
    });
    assert.equal(Object.hasOwn(payload.items[0], 'id'), false);
    assert.equal(Object.hasOwn(payload.items[0], 'unknown_field'), false);
    assert.equal(Object.hasOwn(payload.items[1], 'classification_name'), false);
    assertNoStore(result);
});

test('model projection rejects unknown faces, bad modalities and malformed entries', async () => {
    const cases = [
        { object: 'list', data: [{ id: 'x', protocol_faces: ['openai-write'] }] },
        { object: 'list', data: [{ id: 'x', protocol_faces: ['chat'], modality: 'audio' }] },
        { object: 'list', data: [{ id: '', protocol_faces: ['chat'] }] },
        { object: 'list', data: [null] },
        { object: 'list', data: 'not-an-array' },
        { object: 'models', data: [] },
        { nope: true },
    ];
    for (const payload of cases) {
        const fetchImpl = makeFetch(jsonResponse(payload));
        const core = createCore({
            readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
            fetchImpl,
        });
        const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 502);
        assert.equal(result.json().error.code, 'upstream_invalid_response');
        assert.equal(result.json().error.message, MESSAGES.invalid);
        assertNoStore(result);
    }
});

test('keys only returns the four contract fields and never a plaintext key', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_KEYS));
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'agw_secret_key', username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.keys, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
        keys: [{ id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled' }],
    });
    assert.equal(result.body.includes('agw_secret_key'), false);
    assert.equal(result.body.includes('unknown_field'), false);
    assertNoStore(result);
});

test('balance returns the full query snapshot including required H/K', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_BALANCE));
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
        permanent_balance: '1.000000',
        debt: '0.000000',
        daily_quota: '5.000000',
        daily_quota_used: '2.500000',
        daily_quota_remaining: '2.500000',
        quota_date: '2026-11-12',
        needs_refresh: false,
        observed_at: '2026-11-12T00:00:00Z',
        penalty_input_threshold: '1000',
        penalty_multiplier: '1000',
    });
    assert.equal(Object.hasOwn(result.json(), 'wallet_balance'), false);
    assert.equal(Object.hasOwn(result.json(), 'unknown_field'), false);
    assertNoStore(result);
});

test('balance rejects wrong types and bad decimals; invalid H/K degrade instead of 502', async () => {
    const cases = [
        { ...VALID_BALANCE, permanent_balance: 1 },
        { ...VALID_BALANCE, debt: '1' },
        { ...VALID_BALANCE, daily_quota: '-1.000000' },
        { ...VALID_BALANCE, quota_date: '2026-02-30' },
        { ...VALID_BALANCE, needs_refresh: 'false' },
        { ...VALID_BALANCE, observed_at: 'not-a-date' },
        { ...VALID_BALANCE, penalty_input_threshold: undefined },
        { ...VALID_BALANCE, penalty_multiplier: undefined },
        { ...VALID_BALANCE, penalty_input_threshold: 1000 },
        {},
    ];
    for (const payload of cases) {
        const fetchImpl = makeFetch(jsonResponse(payload));
        const core = createCore({
            readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
            fetchImpl,
        });
        const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 502);
        assert.equal(result.json().error.code, 'upstream_invalid_response');
        assert.equal(result.body.includes('0.000000'), false);
        assertNoStore(result);
    }
});

test('balance returns invalid H/K strings untouched for the UI to render as unknown (S9)', async () => {
    for (const value of ['1.5', '-1', '1e3', '', '9223372036854775808']) {
        const payload = {
            ...VALID_BALANCE,
            penalty_input_threshold: value,
            penalty_multiplier: value,
        };
        const fetchImpl = makeFetch(jsonResponse(payload));
        const core = createCore({
            readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
            fetchImpl,
        });
        const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 200, value);
        assert.equal(result.json().permanent_balance, '1.000000');
        assert.equal(result.json().penalty_input_threshold, value);
        assert.equal(result.json().penalty_multiplier, value);
        assertNoStore(result);
    }
});

test('query 401 clears the login and returns 409 not_connected (login invalid)', async () => {
    const clearCalls = [];
    const store = { '/u/alice': { loginCredential: 'cred', key: 'key', username: 'alice' } };
    const fetchImpl = makeFetch({ status: 401, body: streamOf('{"error":"leak"}') });
    const core = createCore({
        readBinding: async (directories) => (store[directories.root] ? { ...store[directories.root] } : null),
        clearBinding: async (directories) => {
            clearCalls.push(directories);
            delete store[directories.root];
            return true;
        },
        fetchImpl,
    });
    for (const name of ['keys', 'models', 'balance']) {
        store['/u/alice'] = { loginCredential: 'cred', key: 'key', username: 'alice' };
        const result = await call(core.handlers[name], makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 409, name);
        assert.equal(result.json().error.code, 'not_connected', name);
        assert.equal(result.json().error.message, MESSAGES.loginInvalid, name);
        assert.equal(result.body.includes('cred'), false, name);
        assertNoStore(result);
    }
    // G4：第一次 401 已设置持久 login_invalidated；后续查询在读取残信封前
    // 直接 409（不再触发新一轮 clear/上游调用）。
    assert.equal(clearCalls.length, 1);
    const status = await call(core.handlers.status, makeReq({ root: '/u/alice' }));
    assert.equal(status.json().state, 'invalid');
    assert.equal(status.json().reason, 'login_invalidated');
    // I9：invalid 状态的 legacy code/message 与 state 一致，不再固定
    // pass_binding_unavailable。
    assert.equal(status.json().code, 'login_invalidated');
    assert.equal(status.json().message, MESSAGES.loginInvalid);
});

test('upstream 5xx becomes a fixed 502 without body or credential leakage', async () => {
    const leaked = 'agw_secret_should_never_leave_upstream';
    const fetchImpl = makeFetch({
        status: 500,
        body: streamOf(JSON.stringify({ error: leaked })),
    });
    const core = createCore({
        readBinding: async () => ({ loginCredential: leaked, key: leaked, username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(result.json().error.message, MESSAGES.upstream);
    assert.equal(result.body.includes(leaked), false);
    assert.equal(result.body.includes('500'), false);
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 1);
});

test('redirects fail closed because fetch uses redirect:error', async () => {
    const fetchImpl = async () => {
        throw new TypeError('unexpected redirect');
    };
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(JSON.stringify(result.body).includes('redirect'), false);
});

test('invalid upstream JSON fails closed', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf('{not json') });
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_invalid_response');
});

test('timeout aborts the upstream request and returns a fixed 502', async () => {
    const fetchImpl = (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    });
    const core = createCore({
        readBinding: async () => ({ loginCredential: 'cred', key: 'key', username: 'alice' }),
        fetchImpl,
        connectTimeoutMs: 25,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assertNoStore(result);
});

test('registerRoutes wires the exact fixed paths and methods', () => {
    const calls = [];
    const core = buildCore();
    core.registerRoutes({
        get(path, handler) {
            calls.push({ method: 'GET', path, handler });
        },
        post(path, handler) {
            calls.push({ method: 'POST', path, handler });
        },
    });
    assert.deepEqual(calls.map((item) => `${item.method} ${item.path}`), [
        'GET /status',
        'GET /keys',
        'GET /models',
        'GET /balance',
        'POST /login',
        'POST /plan',
        'POST /apply-model',
        'POST /connect',
        'GET /connect/status',
        'POST /logout',
        'POST /release-custom-key',
    ]);
});

test('F1 host allowlist: default loopback hosts pass, attacker hosts are 403 host_not_allowed', async () => {
    const core = buildCore();
    const handlers = ['status', 'keys', 'models', 'balance', 'login', 'plan',
        'applyModel', 'connect', 'connectStatus', 'logout', 'releaseCustomKey'];
    // 所有路由（含 GET）在身份校验之前先过 Host 闸：attacker.example 一律 403。
    for (const name of handlers) {
        const result = await call(core.handlers[name], {
            method: name === 'status' || name === 'keys' || name === 'models'
                || name === 'balance' || name === 'connectStatus' ? 'GET' : 'POST',
            url: '/',
            headers: { host: 'attacker.example', origin: 'https://attacker.example' },
            user: { directories: { root: '/u/alice' } },
            body: {},
        });
        assert.equal(result.statusCode, 403, name);
        assert.equal(result.json().error.code, 'host_not_allowed', name);
        assert.equal(result.json().error.message, '请求 Host 不在允许列表。', name);
        assertNoStore(result);
    }

    // loopback 四态（大小写/端口/IPv6 方括号）都通过 Host 闸。
    for (const host of ['localhost', 'localhost:8000', '127.0.0.1:3000', '[::1]:8000', 'LOCALHOST:8000']) {
        const result = await call(core.handlers.status, {
            method: 'GET',
            headers: { host },
            user: { directories: { root: '/u/alice' } },
        });
        assert.equal(result.statusCode, 200, host);
        assert.equal(result.json().state, 'not_connected', host);
    }

    // 缺失/畸形 Host 同样 fail-closed（HTTP/1.1 正常请求必有 Host）。
    for (const host of [undefined, '', 'a:b:c', '[::1', 'localhost:abc']) {
        const result = await call(core.handlers.status, {
            method: 'GET',
            headers: host === undefined ? {} : { host },
            user: { directories: { root: '/u/alice' } },
        });
        assert.equal(result.statusCode, 403, String(host));
        assert.equal(result.json().error.code, 'host_not_allowed', String(host));
    }
});

test('DATA_ORIGIN stays the data-plane constant used by /plan only', () => {
    assert.equal(DATA_ORIGIN, 'https://api.apercus.ai');
});

test('F1 host allowlist: configured exact hosts pass alongside loopback; bad config throws', async () => {
    const core = createCore({
        readBinding: async () => null,
        fetchImpl: makeFetch(jsonResponse(VALID_MODELS)),
        allowedHosts: ['st.example.com', 'proxy.example.com:8443'],
    });
    for (const host of ['st.example.com', 'proxy.example.com:8443', 'localhost:8000']) {
        const result = await call(core.handlers.status, {
            method: 'GET',
            headers: { host },
            user: { directories: { root: '/u/alice' } },
        });
        assert.equal(result.statusCode, 200, host);
    }
    const denied = await call(core.handlers.status, {
        method: 'GET',
        headers: { host: 'other.example.com' },
        user: { directories: { root: '/u/alice' } },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'host_not_allowed');

    for (const allowedHosts of ['not-an-array', [''], [42], ['a b']]) {
        assert.throws(() => createCore({
            readBinding: async () => null,
            fetchImpl: makeFetch(jsonResponse(VALID_MODELS)),
            allowedHosts,
        }), TypeError, JSON.stringify(allowedHosts));
    }
});
