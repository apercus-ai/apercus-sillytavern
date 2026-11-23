'use strict';

// B3 key/模型选择 + 面板计量（stub 版）服务端行为：查询面 401 失效处理、限频、
// /apply-model 写 api_key_custom（fail-closed）、跨用户隔离、零日志。网关用
// 注入的 stub 客户端（fetchMe/fetchKeys/fetchModels/fetchBalance 全提供），
// 密钥库用内存 Map。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCore } = require('../server/core.js');

const LOGIN_CREDENTIAL = 'login_credential_should_never_leave';
const BINDING_KEY = 'agw_key_secret_value';
const CUSTOM_KEY_ARG = 'custom_source_arg_should_not_leak';

const MESSAGES = {
    notConnected: '尚未完成 Apercus 网关账户绑定。',
    loginInvalid: '登录已失效或已撤销，请重新连接 Apercus 网关。',
    customWriteFailed: '网关 key 未能写入酒馆 Custom 源，模型接入未应用。',
    applyInvalid: '请求体仅接受 model 非空字符串与 switchSource 布尔值。',
    rateLimited: '请求过于频繁，请稍后重试。',
};

function makeRes() {
    const headers = {};
    return {
        statusCode: 200,
        headers,
        body: '',
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        end(value) { this.body = value || ''; },
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

function makeGateway(overrides) {
    const options = overrides || {};
    const calls = { me: [], keys: [], models: [], balance: [], meKey: [] };
    const unauthorized = () => {
        const error = new Error('unauthorized');
        error.unauthorized = true;
        return error;
    };
    return {
        calls,
        client: {
            async startConnect() { return { requestRef: 'r', pollingSecret: 's', authorizeUrl: 'https://gw.apercus.ai/a', expiresAt: 'x' }; },
            async pollConnect() { return { status: 'pending' }; },
            async logout() { return { status: 'logged_out' }; },
            async fetchMe(credential) {
                calls.me.push(credential);
                if (options.meUnauthorized) throw unauthorized();
                return { username: 'alice' };
            },
            async fetchKeys(credential) {
                calls.keys.push(credential);
                if (options.keysUnauthorized) throw unauthorized();
                if (options.keysValue) return options.keysValue;
                return { keys: [{ id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled' }] };
            },
            async fetchMeKey(credential) {
                calls.meKey.push(credential);
                if (options.meKeyUnauthorized) throw unauthorized();
                return { key: 'new-key', username: 'alice' };
            },
            async fetchModels(credential) {
                calls.models.push(credential);
                if (options.modelsUnauthorized) throw unauthorized();
                return { items: [{ name: 'model-a', protocol_faces: ['chat'] }] };
            },
            async fetchBalance(credential) {
                calls.balance.push(credential);
                if (options.balanceUnauthorized) throw unauthorized();
                if (options.balanceValue) return options.balanceValue;
                return {
                    permanent_balance: '1.000000',
                    debt: '0.000000',
                    daily_quota: '5.000000',
                    daily_quota_used: '0.000000',
                    daily_quota_remaining: '5.000000',
                    quota_date: '2026-11-23',
                    needs_refresh: false,
                    observed_at: '2026-11-23T00:00:00Z',
                    penalty_input_threshold: '1000',
                    penalty_multiplier: '1000',
                };
            },
        },
    };
}

function buildCore(overrides) {
    const options = overrides || {};
    const store = options.store || new Map();
    const gateway = options.gateway || makeGateway();
    const writes = { custom: [], customClear: [], envelope: 0, clear: 0, refresh: 0 };
    let clock = options.now || 1000;
    let customWriteFails = options.customWriteFails === true;

    const core = createCore({
        readBinding: async (directories) => {
            if (options.readBindingThrows) throw new Error('read failed');
            return store.has(directories.root) ? { ...store.get(directories.root) } : null;
        },
        writeBinding: async () => { writes.envelope += 1; return true; },
        clearBinding: async (directories) => {
            writes.clear += 1;
            if (options.clearKeepsRecord !== true) store.delete(directories.root);
            if (typeof options.clearResult === 'function') return options.clearResult();
            return options.clearResult === undefined ? true : options.clearResult;
        },
        refreshKey: async () => {
            writes.refresh += 1;
            if (options.refreshDeferred) await options.refreshDeferred.promise;
            return true;
        },
        writeCustomSourceKey: options.noCustomWriter
            ? null
            : async (directories, key, writerOptions) => {
                writes.custom.push({ directories, key, options: writerOptions });
                if (options.customWriterDeferred) await options.customWriterDeferred.promise;
                if (options.customWriteThrows) throw new Error('kv write failed');
                if (options.customWriterConflict === true) return { ok: false, conflict: true };
                if (customWriteFails) {
                    customWriteFails = false;
                    return false;
                }
                return options.customWriterResult === undefined ? true : options.customWriterResult;
            },
        clearCustomSourceKey: options.noCustomClear
            ? null
            : async (directories, keys) => {
                writes.customClear.push({ directories, keys });
                if (options.customClearThrows) throw new Error('clear failed');
                return options.customClearResult === undefined ? true : options.customClearResult;
            },
        hasCustomSourceEntries: options.hasCustomSourceEntries === undefined
            ? async () => ({ known: true, present: false })
            : options.hasCustomSourceEntries,
        retryCustomSync: options.retryCustomSync,
        gatewayClient: gateway.client,
        fetchImpl: options.fetchImpl || (async () => ({ status: 200, body: new ReadableStream({ start(controller) { controller.close(); } }) })),
        now: () => clock,
        queryRateLimitPerMinute: options.queryRateLimitPerMinute || 1000,
        planRateLimitPerMinute: 1000,
        releaseRateLimitPerMinute: options.releaseRateLimitPerMinute,
        applyModelRateLimitPerMinute: Object.hasOwn(options, 'applyModelRateLimitPerMinute')
            ? options.applyModelRateLimitPerMinute
            : undefined,
    });

    return {
        core,
        store,
        gateway,
        writes,
        tick: (ms) => { clock += ms; },
    };
}

function makeAuthRecord(overrides) {
    const extra = overrides || {};
    const record = {
        loginCredential: extra.loginCredential || LOGIN_CREDENTIAL,
        key: extra.key || BINDING_KEY,
        username: extra.username || 'alice',
    };
    if (Array.isArray(extra.customKeys)) record.customKeys = extra.customKeys;
    return record;
}

function getReq(path, overrides) {
    const extra = overrides || {};
    return {
        method: 'GET',
        url: `/api/plugins/apercus-gateway${path}`,
        headers: { host: 'localhost:8000', ...(extra.headers || {}) },
        user: 'user' in extra ? extra.user : { directories: { root: extra.root || '/u/alice' } },
    };
}

function postReq(path, body, overrides) {
    const extra = overrides || {};
    return {
        method: 'POST',
        url: `/api/plugins/apercus-gateway${path}`,
        headers: { host: 'localhost:8000', origin: 'http://localhost:8000', ...(extra.headers || {}) },
        user: 'user' in extra ? extra.user : { directories: { root: extra.root || '/u/alice' } },
        body: 'body' in extra ? extra.body : body,
    };
}

function assertNoStore(result) {
    assert.equal(result.headers['cache-control'], 'no-store');
}

function deferred() {
    let resolve = null;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function flush(times) {
    for (let index = 0; index < (times || 4); index += 1) {
        await new Promise((done) => setImmediate(done));
    }
}

test('GET /keys: missing user 401, cross-site 403, no login 409, and success shape', async () => {
    const h = buildCore();
    const missing = await call(h.core.handlers.keys, getReq('/keys', { user: undefined }));
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, 'unauthorized');

    const crossSite = await call(h.core.handlers.keys, getReq('/keys', {
        headers: { origin: 'https://evil.example' },
    }));
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.json().error.code, 'origin_forbidden');

    const noLogin = await call(h.core.handlers.keys, getReq('/keys'));
    assert.equal(noLogin.statusCode, 409);
    assert.equal(noLogin.json().error.code, 'not_connected');
    assert.equal(noLogin.json().error.message, MESSAGES.notConnected);
    assertNoStore(noLogin);
    assert.equal(h.gateway.calls.keys.length, 0);

    h.store.set('/u/alice', makeAuthRecord());
    const ok = await call(h.core.handlers.keys, getReq('/keys'));
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), {
        keys: [{ id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled' }],
    });
    assert.deepEqual(h.gateway.calls.keys, [LOGIN_CREDENTIAL]);
    assert.equal(ok.body.includes(BINDING_KEY), false);
    assert.equal(ok.body.includes(LOGIN_CREDENTIAL), false);
    assertNoStore(ok);
});

test('query 401 clears the local login, reports invalid on /status, and stops later query calls', async () => {
    const h = buildCore({ gateway: makeGateway({ modelsUnauthorized: true }) });
    h.store.set('/u/alice', makeAuthRecord());
    const result = await call(h.core.handlers.models, getReq('/models'));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
    assert.equal(result.json().error.message, MESSAGES.loginInvalid);
    assert.equal(h.writes.clear, 1);
    assert.equal(h.store.has('/u/alice'), false);

    const status = await call(h.core.handlers.status, getReq('/status'));
    assert.equal(status.json().state, 'invalid');
    assert.equal(status.json().reason, 'login_invalidated');
    assert.equal(status.json().local_cleared, true);
    assert.equal(status.json().custom_cleared, true);

    // G4：login_invalidated 标记存在时查询面直接 409 login invalid，不再使用
    // 残留信封/调用上游，而不是退回通用的 not_connected 文案。
    const again = await call(h.core.handlers.keys, getReq('/keys'));
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.message, MESSAGES.loginInvalid);
    assert.equal(h.gateway.calls.keys.length, 0);
});

test('query 401 whose local clear fails still reports invalid and never re-authorizes (S5)', async () => {
    const h = buildCore({
        gateway: makeGateway({ modelsUnauthorized: true }),
        clearKeepsRecord: true,
        clearResult: { envelope: false, custom: false },
    });
    h.store.set('/u/alice', makeAuthRecord());
    const result = await call(h.core.handlers.models, getReq('/models'));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.message, MESSAGES.loginInvalid);
    assert.equal(h.store.has('/u/alice'), true);

    const status = await call(h.core.handlers.status, getReq('/status'));
    assert.equal(status.json().state, 'invalid');
    assert.equal(status.json().local_cleared, false);
    assert.equal(status.json().custom_cleared, false);
    assert.equal(Object.hasOwn(status.json(), 'username'), false);
});

test('query surface is limited by both login credential and user root (429 rate_limited)', async () => {
    const h = buildCore({ queryRateLimitPerMinute: 3 });
    h.store.set('/u/alice', makeAuthRecord());
    h.store.set('/u/bob', makeAuthRecord({ loginCredential: 'cred-bob', username: 'bob' }));
    for (let index = 0; index < 3; index += 1) {
        const result = await call(h.core.handlers.models, getReq('/models'));
        assert.equal(result.statusCode, 200, `call ${index}`);
    }
    const limited = await call(h.core.handlers.models, getReq('/models'));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.equal(limited.json().error.message, MESSAGES.rateLimited);
    assert.equal(h.gateway.calls.models.length, 3);

    // 同 root 的另一个查询也受限（root 桶），窗口过后恢复。
    const other = await call(h.core.handlers.balance, getReq('/balance'));
    assert.equal(other.statusCode, 429);
    h.tick(61 * 1000);
    const after = await call(h.core.handlers.keys, getReq('/keys'));
    assert.equal(after.statusCode, 200);

    // 同一登录凭据在另一个 root 下同样受限（凭据桶独立于 root）。
    const shared = buildCore({ queryRateLimitPerMinute: 3 });
    shared.store.set('/u/alice', makeAuthRecord());
    shared.store.set('/u/bob', makeAuthRecord({ username: 'bob' }));
    assert.equal((await call(shared.core.handlers.models, getReq('/models'))).statusCode, 200);
    assert.equal((await call(shared.core.handlers.models, getReq('/models'))).statusCode, 200);
    assert.equal((await call(shared.core.handlers.models, getReq('/models', { root: '/u/bob' }))).statusCode, 200);
    const credentialLimited = await call(shared.core.handlers.models, getReq('/models', { root: '/u/bob' }));
    assert.equal(credentialLimited.statusCode, 429);
    assert.equal(credentialLimited.json().error.code, 'rate_limited');
});

test('POST /apply-model writes api_key_custom only after validation and same-origin check', async () => {
    const h = buildCore();

    const noBinding = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }));
    assert.equal(noBinding.statusCode, 409);
    assert.equal(noBinding.json().error.code, 'not_connected');

    h.store.set('/u/alice', makeAuthRecord());

    const missingUser = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }, { user: undefined }));
    assert.equal(missingUser.statusCode, 401);
    assert.equal(h.writes.custom.length, 0);

    const crossSite = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }, {
        headers: { origin: 'https://evil.example' },
    }));
    assert.equal(crossSite.statusCode, 403);
    assert.equal(h.writes.custom.length, 0);

    const badBody = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a' }));
    assert.equal(badBody.statusCode, 422);
    assert.equal(badBody.json().error.message, MESSAGES.applyInvalid);
    assert.equal(h.writes.custom.length, 0);

    const ok = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }));
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { status: 'applied', model: 'model-a' });
    assert.deepEqual(h.writes.custom, [{
        directories: { root: '/u/alice' },
        key: BINDING_KEY,
        options: { expectedLoginCredential: LOGIN_CREDENTIAL },
    }]);
    assert.equal(h.writes.envelope, 0); // apply-model 不重写信封
    assert.equal(ok.body.includes(BINDING_KEY), false);
    assertNoStore(ok);
});

test('POST /apply-model maps fully-unwritten vs unknown/partial Custom writes (G1)', async () => {
    const cases = [
        // 明确完全未写 → custom_source_write_failed（UI 可安全回滚 URL）。
        { options: { noCustomWriter: true }, code: 'custom_source_write_failed' },
        {
            options: { customWriterResult: { ok: false, conflict: false, customWritten: false, envelopeWritten: false } },
            code: 'custom_source_write_failed',
        },
        // 归属已写/回滚失败/适配器只返回布尔 false（无法得知进度）→ partial。
        { options: { customWriteThrows: true }, code: 'custom_source_write_partial' },
        { options: { customWriterResult: false }, code: 'custom_source_write_partial' },
        {
            options: { customWriterResult: { ok: false, conflict: false, customWritten: false, envelopeWritten: true } },
            code: 'custom_source_write_partial',
        },
    ];
    for (const item of cases) {
        const h = buildCore(item.options);
        h.store.set('/u/alice', makeAuthRecord());
        const result = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
        assert.equal(result.statusCode, 502, JSON.stringify(item.options));
        assert.equal(result.json().error.code, item.code, JSON.stringify(item.options));
        if (item.code === 'custom_source_write_failed') {
            assert.equal(result.json().error.message, MESSAGES.customWriteFailed);
        }
        assert.equal(result.body.includes(BINDING_KEY), false);
        assertNoStore(result);
    }
});

test('apply-model validates the model string bounds and switchSource type', async () => {
    const h = buildCore();
    h.store.set('/u/alice', makeAuthRecord());
    for (const body of [
        { model: '', switchSource: true },
        { model: 'm'.repeat(513), switchSource: true },
        { model: 42, switchSource: true },
        { model: 'model-a', switchSource: 'true' },
        { model: 'model-a', switchSource: true, extra: 1 },
        ['model-a', true],
        null,
    ]) {
        const result = await call(h.core.handlers.applyModel, postReq('/apply-model', body));
        assert.equal(result.statusCode, 422);
        assert.equal(result.json().error.code, 'invalid_request');
        assert.equal(h.writes.custom.length, 0);
    }
});

test('apply-model is rate-limited per root (10/min by default, configurable) (S6)', async () => {
    const h = buildCore({ applyModelRateLimitPerMinute: 10 });
    h.store.set('/u/alice', makeAuthRecord());
    for (let index = 0; index < 10; index += 1) {
        const result = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
        assert.equal(result.statusCode, 200, String(index));
    }
    assert.equal(h.writes.custom.length, 10);

    const limited = await call(h.core.handlers.applyModel, postReq('/apply-model', undefined));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.equal(h.writes.custom.length, 10);

    h.tick(60 * 1000);
    const after = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
    assert.equal(after.statusCode, 200);
});

test('apply-model default rate limit is 10 per minute without an injected override (S6)', async () => {
    const h = buildCore(); // 未传 applyModelRateLimitPerMinute → core 默认 10
    h.store.set('/u/alice', makeAuthRecord());
    for (let index = 0; index < 10; index += 1) {
        const result = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
        assert.equal(result.statusCode, 200, String(index));
    }
    const limited = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
});

test('apply-model rejects an unauthorized root before consuming rate budget or writing (S6)', async () => {
    const h = buildCore({ applyModelRateLimitPerMinute: 1 });
    for (let index = 0; index < 3; index += 1) {
        const result = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
        assert.equal(result.statusCode, 409, String(index));
        assert.equal(result.json().error.code, 'not_connected');
    }
    assert.equal(h.writes.custom.length, 0);

    // 未授权请求未消耗额度：授权后第一次仍可成功。
    h.store.set('/u/alice', makeAuthRecord());
    const ok = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
    assert.equal(ok.statusCode, 200);
});

test('users stay isolated on the query surface and apply-model writes the caller key', async () => {
    const h = buildCore();
    h.store.set('/u/alice', makeAuthRecord());
    h.store.set('/u/bob', makeAuthRecord({ loginCredential: 'cred-bob', key: 'key-bob', username: 'bob' }));

    const alice = await call(h.core.handlers.keys, getReq('/keys'));
    const bob = await call(h.core.handlers.keys, getReq('/keys', { root: '/u/bob' }));
    assert.deepEqual(h.gateway.calls.keys, [LOGIN_CREDENTIAL, 'cred-bob']);

    await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }, { root: '/u/bob' }));
    assert.deepEqual(h.writes.custom[0], {
        directories: { root: '/u/bob' },
        key: 'key-bob',
        options: { expectedLoginCredential: 'cred-bob' },
    });
});

test('B3 routes never write to the console or leak credentials', async () => {
    const recorded = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => recorded.push({ method, args });
    }
    try {
        const h = buildCore();
        h.store.set('/u/alice', makeAuthRecord());
        await call(h.core.handlers.keys, getReq('/keys'));
        await call(h.core.handlers.models, getReq('/models'));
        await call(h.core.handlers.balance, getReq('/balance'));
        await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }));
        assert.equal(recorded.length, 0);
    } finally {
        for (const method of methods) {
            console[method] = originals[method];
        }
    }
});

test('denied query results never serialize the caller key or credential', async () => {
    const h = buildCore({ gateway: makeGateway({ balanceUnauthorized: true }) });
    h.store.set('/u/alice', makeAuthRecord());
    const result = await call(h.core.handlers.balance, getReq('/balance'));
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.includes(BINDING_KEY), false);
    assert.equal(result.body.includes(LOGIN_CREDENTIAL), false);
    assert.equal(result.body.includes(CUSTOM_KEY_ARG), false);
});

test('plan data-key 401 with query-plane 401 clears login and returns 409 login invalid', async () => {
    const h = buildCore({
        gateway: makeGateway({ meKeyUnauthorized: true }),
        fetchImpl: async () => ({ status: 401, body: new ReadableStream({ start(controller) { controller.close(); } }) }),
    });
    h.store.set('/u/alice', makeAuthRecord());
    const result = await call(h.core.handlers.plan, postReq('/plan', { model: 'model-a', prompt: 'prompt' }));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
    assert.equal(result.json().error.message, MESSAGES.loginInvalid);
    assert.equal(h.writes.clear, 1);
    assert.equal(h.store.has('/u/alice'), false);
    assert.equal(h.gateway.calls.meKey.length, 1);
});

// ===== F3：apply-model 写前复核账号未变 =====

test('H5: apply-model conflicts are 409 only when provably fully unwritten; unknown/written states are 502 partial', async () => {
    // 适配器只报 conflict、不带写入进度 → 结果未知，不得让 UI 回滚 URL。
    const unknown = buildCore({ customWriterConflict: true });
    unknown.store.set('/u/alice', makeAuthRecord());
    const unknownResult = await call(unknown.core.handlers.applyModel,
        postReq('/apply-model', { model: 'model-a', switchSource: false }));
    assert.equal(unknownResult.statusCode, 502);
    assert.equal(unknownResult.json().error.code, 'custom_source_write_partial');
    assert.equal(unknownResult.body.includes(BINDING_KEY), false);

    // 冲突时已知任一写入（true 或未知边界）→ 同样必须是 502 partial。
    for (const result of [
        { ok: false, conflict: true, customWritten: true, envelopeWritten: false },
        { ok: false, conflict: true, customWritten: false, envelopeWritten: true },
        { ok: false, conflict: true, customWritten: true, envelopeWritten: true },
    ]) {
        const h = buildCore({ customWriterResult: result });
        h.store.set('/u/alice', makeAuthRecord());
        const partial = await call(h.core.handlers.applyModel,
            postReq('/apply-model', { model: 'model-a', switchSource: false }));
        assert.equal(partial.statusCode, 502, JSON.stringify(result));
        assert.equal(partial.json().error.code, 'custom_source_write_partial', JSON.stringify(result));
    }

    // 适配器明确报告“完全未写”的冲突（写入前 credential/key 复核失败）→ 409。
    const unwritten = buildCore({
        customWriterResult: {
            ok: false, conflict: true, customWritten: false, envelopeWritten: false,
        },
    });
    unwritten.store.set('/u/alice', makeAuthRecord());
    const conflict = await call(unwritten.core.handlers.applyModel,
        postReq('/apply-model', { model: 'model-a', switchSource: false }));
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'not_connected');
    assert.equal(conflict.json().error.message, '登录状态已变更，本次操作已取消，请重试。');
    assert.equal(unwritten.writes.custom.length, 1);
    assert.equal(conflict.body.includes(BINDING_KEY), false);
});

// ===== F11：POST /release-custom-key =====

test('release-custom-key clears plugin-owned Custom keys using the envelope union; idempotent without a binding', async () => {
    const h = buildCore();
    // 无绑定：允许幂等清理，返回 cleared true，不触碰任何 key。
    const noBinding = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(noBinding.statusCode, 200);
    assert.deepEqual(noBinding.json(), { cleared: true });
    assert.equal(h.writes.customClear.length, 0);

    h.store.set('/u/alice', makeAuthRecord({ key: 'current-key', customKeys: ['old-a', 'old-b'] }));
    const result = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { cleared: true });
    assert.deepEqual(h.writes.customClear, [{
        directories: { root: '/u/alice' },
        keys: ['current-key', 'old-a', 'old-b'],
    }]);
    assertNoStore(result);

    // 清理失败 → 200 {cleared:false}（不把残留报成成功）。
    const failing = buildCore({ customClearResult: false });
    failing.store.set('/u/alice', makeAuthRecord({ key: 'current-key' }));
    const failed = await call(failing.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(failed.statusCode, 200);
    assert.deepEqual(failed.json(), { cleared: false });

    // 清理异常也 fail-closed 到 cleared:false。
    const throwing = buildCore({ customClearThrows: true });
    throwing.store.set('/u/alice', makeAuthRecord());
    const thrown = await call(throwing.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.deepEqual(thrown.json(), { cleared: false });

    // 无清理适配器：有归属 key 时不能假装清干净。
    const missing = buildCore({ noCustomClear: true });
    missing.store.set('/u/alice', makeAuthRecord());
    const cannot = await call(missing.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.deepEqual(cannot.json(), { cleared: false });
});

test('release-custom-key does not claim cleared when the envelope is gone but Custom entries remain', async () => {
    const h = buildCore({
        hasCustomSourceEntries: async () => ({ known: true, present: true }),
    });
    const result = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { cleared: false, reason: 'read_failed' });
    assert.equal(h.writes.customClear.length, 0);
});

test('W10: a later uncertain logout downgrades a stale custom_cleared:true marker', async () => {
    let clearResult = { envelope: true, custom: true };
    const h = buildCore({
        gateway: makeGateway({ modelsUnauthorized: true }),
        clearResult: () => clearResult,
    });
    h.store.set('/u/alice', makeAuthRecord());
    const invalidated = await call(h.core.handlers.models, getReq('/models'));
    assert.equal(invalidated.statusCode, 409);
    const afterInvalidate = await call(h.core.handlers.status, getReq('/status'));
    assert.equal(afterInvalidate.json().state, 'invalid');
    assert.equal(afterInvalidate.json().custom_cleared, true);

    clearResult = { envelope: true, custom: true, customUncertain: true };
    const logout = await call(h.core.handlers.logout, postReq('/logout', {}));
    assert.equal(logout.statusCode, 200);
    assert.equal(logout.json().custom_cleared, false);
    const afterLogout = await call(h.core.handlers.status, getReq('/status'));
    assert.equal(afterLogout.json().state, 'invalid');
    assert.equal(afterLogout.json().custom_cleared, false);
});

test('release-custom-key requires user, same-origin, and is rate-limited', async () => {
    const h = buildCore({ releaseRateLimitPerMinute: 2 });
    const missing = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}, { user: undefined }));
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, 'unauthorized');

    const crossSite = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}, {
        headers: { origin: 'https://evil.example' },
    }));
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.json().error.code, 'origin_forbidden');

    assert.equal((await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}))).statusCode, 200);
    assert.equal((await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}))).statusCode, 200);
    const limited = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    h.tick(60 * 1000);
    assert.equal((await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}))).statusCode, 200);

    // J2：默认限频放宽到 30 次/分——阻塞型清理不做客户端节流，快速连续切换
    // 预设/生成会重复请求，幂等清理不应被较早的 10/分门槛挡住。
    const defaults = buildCore();
    for (let index = 0; index < 30; index += 1) {
        assert.equal(
            (await call(defaults.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}))).statusCode,
            200,
        );
    }
    assert.equal(
        (await call(defaults.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}))).statusCode,
        429,
    );

    // Host 闸同样先于身份。
    const badHost = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}, {
        headers: { host: 'attacker.example' },
        user: undefined,
    }));
    assert.equal(badHost.statusCode, 403);
    assert.equal(badHost.json().error.code, 'host_not_allowed');
});

// ===== G4：login_invalidated 强制拒绝 =====

test('G4: login_invalidated denies plan/apply/query without touching residual keys', async () => {
    let upstreamCalls = 0;
    const h = buildCore({
        clearKeepsRecord: true,
        clearResult: { envelope: false, custom: false },
        fetchImpl: async () => {
            upstreamCalls += 1;
            return {
                status: 401,
                body: new ReadableStream({ start(controller) { controller.close(); } }),
            };
        },
    });
    h.store.set('/u/alice', makeAuthRecord());
    // logout 本地清理失败 → 502 + 持久 login_invalidated（残信封仍在）。
    const logout = await call(h.core.handlers.logout, postReq('/logout', {}));
    assert.equal(logout.statusCode, 502);
    assert.equal(logout.json().error.code, 'logout_local_clear_failed');
    const status = await call(h.core.handlers.status, getReq('/status'));
    assert.equal(status.json().state, 'invalid');
    assert.equal(status.json().reason, 'login_invalidated');

    // /plan：标记存在 → 409，且在解析请求体/调用上游之前拒绝。
    const plan = await call(h.core.handlers.plan, postReq('/plan', { model: 'model-a', prompt: 'prompt' }));
    assert.equal(plan.statusCode, 409);
    assert.equal(plan.json().error.code, 'not_connected');
    assert.equal(plan.json().error.message, MESSAGES.loginInvalid);
    assert.equal(upstreamCalls, 0);

    // 查询面：不读取残信封、不打上游。
    for (const name of ['keys', 'models', 'balance']) {
        const result = await call(h.core.handlers[name], getReq(`/${name}`));
        assert.equal(result.statusCode, 409, name);
        assert.equal(result.json().error.message, MESSAGES.loginInvalid, name);
    }
    assert.equal(h.gateway.calls.keys.length, 0);
    assert.equal(h.gateway.calls.models.length, 0);
    assert.equal(h.gateway.calls.balance.length, 0);

    // /apply-model：拒绝，不写 Custom。
    const apply = await call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: true }));
    assert.equal(apply.statusCode, 409);
    assert.equal(apply.json().error.message, MESSAGES.loginInvalid);
    assert.equal(h.writes.custom.length, 0);

    // /release-custom-key 与 /logout 重试仍可用。
    const release = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(release.statusCode, 200);
    assert.equal(release.json().cleared, true);
    assert.equal(h.writes.customClear.length, 1);
    const retry = await call(h.core.handlers.logout, postReq('/logout', {}));
    assert.equal(retry.statusCode, 502);
});

// ===== G8：release 读取失败不伪装成功 =====

test('G8: release-custom-key reports read_failed instead of cleared:true when the envelope cannot be read', async () => {
    const h = buildCore({ readBindingThrows: true });
    const result = await call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { cleared: false, reason: 'read_failed' });
    assert.equal(h.writes.customClear.length, 0);
    assertNoStore(result);
});

// ===== G9：写串行化 =====

test('G9/H5: logout waits for an in-flight apply; the stale apply returns 502 partial and is not reported applied', async () => {
    const gate = deferred();
    const h = buildCore({ customWriterDeferred: gate });
    h.store.set('/u/alice', makeAuthRecord());
    const applyPromise = call(h.core.handlers.applyModel, postReq('/apply-model', { model: 'model-a', switchSource: false }));
    await flush();
    assert.equal(h.writes.custom.length, 1, 'apply holds the root lock inside the adapter write');

    const logoutPromise = call(h.core.handlers.logout, postReq('/logout', {}));
    await flush();
    gate.resolve();
    const apply = await applyPromise;
    await logoutPromise;

    // 适配器已经写过 Custom（customWritten:true 由 stub 返回 true 归一化），
    // 期间 logout bump 世代：写后冲突不得报 409（那会让 UI 回滚并谎称未写）。
    assert.equal(apply.statusCode, 502);
    assert.equal(apply.json().error.code, 'custom_source_write_partial');
    assert.equal(apply.json().status, undefined);
    assert.equal(h.store.has('/u/alice'), false);
});

test('G9: logout racing a plan key refresh cancels the refresh (no stale write survives)', async () => {
    const gate = deferred();
    const h = buildCore({
        refreshDeferred: gate,
        fetchImpl: async () => ({
            status: 401,
            body: new ReadableStream({ start(controller) { controller.close(); } }),
        }),
    });
    h.store.set('/u/alice', makeAuthRecord());
    const planPromise = call(h.core.handlers.plan, postReq('/plan', { model: 'model-a', prompt: 'prompt' }));
    await flush();
    assert.equal(h.writes.refresh, 1, 'plan refresh is inside the root lock');

    const logoutPromise = call(h.core.handlers.logout, postReq('/logout', {}));
    await flush();
    gate.resolve();
    const plan = await planPromise;
    await logoutPromise;

    assert.equal(plan.statusCode, 409);
    assert.equal(plan.json().error.code, 'not_connected');
    assert.equal(h.store.has('/u/alice'), false);
});

// ===== H3：Custom 同步自愈（/status 探活） =====

test('H3: authorized /status checks the Custom sync pending state on every probe', async () => {
    const calls = [];
    const h = buildCore({
        retryCustomSync: async (directories) => {
            calls.push(directories.root);
            return { pending: false, synced: true };
        },
    });
    h.store.set('/u/alice', makeAuthRecord());
    await call(h.core.handlers.status, getReq('/status'));
    await flush();
    await call(h.core.handlers.status, getReq('/status'));
    await flush();
    assert.deepEqual(calls, ['/u/alice', '/u/alice']);

    // login_invalidated（清理失败留下的残信封）：/status 报 invalid，不再触发
    // Custom 同步自愈（不得把残信封当可用登录）。
    const invalidCalls = [];
    const failing = buildCore({
        clearResult: { envelope: false, custom: false },
        clearKeepsRecord: true,
        retryCustomSync: async () => {
            invalidCalls.push(true);
            return { pending: false, synced: false };
        },
    });
    failing.store.set('/u/alice', makeAuthRecord());
    assert.equal((await call(failing.core.handlers.logout, postReq('/logout', {}))).statusCode, 502);
    await call(failing.core.handlers.status, getReq('/status'));
    await flush();
    assert.equal(invalidCalls.length, 0);
});

// ===== H8：release 入锁 =====

test('H8: release-custom-key read+clear is serialized with an in-flight apply write', async () => {
    const gate = deferred();
    const h = buildCore({ customWriterDeferred: gate });
    h.store.set('/u/alice', makeAuthRecord());
    const applyPromise = call(h.core.handlers.applyModel,
        postReq('/apply-model', { model: 'model-a', switchSource: false }));
    await flush();
    assert.equal(h.writes.custom.length, 1, 'apply holds the root lock in the adapter write');

    const releasePromise = call(h.core.handlers.releaseCustomKey, postReq('/release-custom-key', {}));
    await flush();
    assert.equal(h.writes.customClear.length, 0, 'release waits for the apply lock');

    gate.resolve();
    const apply = await applyPromise;
    const release = await releasePromise;
    assert.equal(apply.statusCode, 200);
    assert.equal(release.statusCode, 200);
    assert.deepEqual(release.json(), { cleared: true });
    assert.equal(h.writes.customClear.length, 1);
    assert.deepEqual(h.writes.customClear[0].keys, [BINDING_KEY]);
});
