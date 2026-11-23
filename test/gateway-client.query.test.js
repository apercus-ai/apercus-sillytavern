'use strict';

// server/gateway-client.js 查询面（v1.35 plugin/me）全分支锁定：字面 URL、
// Bearer 登录凭据、严格解析、401 → unauthorized 标记、512KB 上限、无重试、零日志。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGatewayClient } = require('../server/gateway-client.js');

const ME_URL = 'https://gw.apercus.ai/api/plugin/me';
const KEYS_URL = 'https://gw.apercus.ai/api/plugin/me/keys';
const MODELS_URL = 'https://gw.apercus.ai/api/plugin/me/models';
const BALANCE_URL = 'https://gw.apercus.ai/api/plugin/me/balance';

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

async function assertRejectsFixed(promise, code) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code);
        if (code === 'plugin_me_fetch_failed') {
            assert.equal(error.message, '网关账户查询失败：网关不可用或响应无效。');
        }
        if (code === 'plugin_keys_fetch_failed') {
            assert.equal(error.message, '网关 key 列表查询失败：网关不可用或响应无效。');
        }
        if (code === 'plugin_models_fetch_failed') {
            assert.equal(error.message, '网关模型目录查询失败：网关不可用或响应无效。');
        }
        if (code === 'plugin_balance_fetch_failed') {
            assert.equal(error.message, '网关余额查询失败：网关不可用或响应无效。');
        }
        return true;
    });
}

test('fetchMe GETs the literal URL with Bearer and validates username', async () => {
    const fetchImpl = makeFetch(jsonResponse({ username: 'alice' }));
    const client = makeClient(fetchImpl);
    assert.deepEqual(await client.fetchMe('cred_abc'), { username: 'alice' });
    assert.equal(fetchImpl.calls[0].url, ME_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.deepEqual(fetchImpl.calls[0].options.headers, {
        accept: 'application/json',
        authorization: 'Bearer cred_abc',
    });
    for (const payload of [{}, { username: '' }, { username: 42 }, { username: 'a\nb' }, null]) {
        await assertRejectsFixed(makeClient(makeFetch(jsonResponse(payload))).fetchMe('cred_abc'), 'plugin_me_fetch_failed');
    }
});

test('fetchKeys returns only {id,name,masked,status} and rejects plaintext key fields', async () => {
    const payload = {
        keys: [{
            id: 'default',
            name: '默认 key',
            masked: '****7x2a',
            status: 'enabled',
            ignored: 'drop-me',
        }],
    };
    const fetchImpl = makeFetch(jsonResponse(payload));
    const client = makeClient(fetchImpl);
    const result = await client.fetchKeys('cred_abc');
    assert.deepEqual(result, {
        keys: [{ id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled' }],
    });
    assert.equal(fetchImpl.calls[0].url, KEYS_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.equal(JSON.stringify(result).includes('drop-me'), false);

    for (const plaintext of ['key', 'secret', 'plaintext']) {
        await assertRejectsFixed(
            makeClient(makeFetch(jsonResponse({
                keys: [{ id: 'default', name: '默认 key', masked: '****', status: 'enabled', [plaintext]: 'agw_leak' }],
            }))).fetchKeys('cred_abc'),
            'plugin_keys_fetch_failed',
        );
    }

    for (const bad of [
        {},
        { keys: 'nope' },
        { keys: [null] },
        { keys: [{ id: '', name: 'n', masked: 'm', status: 'enabled' }] },
        { keys: [{ id: 'd', name: '', masked: 'm', status: 'enabled' }] },
        { keys: [{ id: 'd', name: 'n', masked: '', status: 'enabled' }] },
        { keys: [{ id: 'd', name: 'n', masked: 'm', status: '' }] },
        { keys: [{ id: 'd', name: 'n', masked: 'm', status: 'enabled\nx' }] },
        { keys: new Array(101).fill({ id: 'd', name: 'n', masked: 'm', status: 'enabled' }) },
    ]) {
        await assertRejectsFixed(makeClient(makeFetch(jsonResponse(bad))).fetchKeys('cred_abc'), 'plugin_keys_fetch_failed');
    }
});

test('fetchModels projects data[].id to name and keeps optional catalog fields', async () => {
    const payload = {
        object: 'list',
        data: [
            { id: 'model-a', object: 'model', protocol_faces: ['chat', 'anthropic'], modality: 'text', capabilities: '{"x":1}', classification_name: 'std' },
            { id: 'model-b', object: 'model', protocol_faces: ['image'], ignored: true },
        ],
    };
    const fetchImpl = makeFetch(jsonResponse(payload));
    const client = makeClient(fetchImpl);
    const result = await client.fetchModels('cred_abc');
    assert.deepEqual(result, {
        items: [
            { name: 'model-a', protocol_faces: ['chat', 'anthropic'], modality: 'text', capabilities: '{"x":1}', classification_name: 'std' },
            { name: 'model-b', protocol_faces: ['image'] },
        ],
    });
    assert.equal(fetchImpl.calls[0].url, MODELS_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.equal(JSON.stringify(result).includes('ignored'), false);

    const bad = [
        { object: 'models', data: [] },
        { object: 'list', data: 'nope' },
        { object: 'list', data: [null] },
        { object: 'list', data: [{ id: '', protocol_faces: ['chat'] }] },
        { object: 'list', data: [{ id: 'x', protocol_faces: ['unknown'] }] },
        { object: 'list', data: [{ id: 'x', protocol_faces: ['chat'], modality: 'audio' }] },
        { object: 'list', data: [{ id: 'x', protocol_faces: ['chat'], capabilities: 42 }] },
        { object: 'list', data: [{ id: 'x', protocol_faces: ['chat'], classification_name: '' }] },
        { object: 'list', data: new Array(501).fill({ id: 'x', protocol_faces: ['chat'] }) },
    ];
    for (const payloadBad of bad) {
        await assertRejectsFixed(makeClient(makeFetch(jsonResponse(payloadBad))).fetchModels('cred_abc'), 'plugin_models_fetch_failed');
    }
});

test('fetchBalance requires H/K to be strings but does not reject invalid values (S9 degradation)', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_BALANCE));
    const client = makeClient(fetchImpl);
    const result = await client.fetchBalance('cred_abc');
    assert.deepEqual(result, VALID_BALANCE);
    assert.equal(fetchImpl.calls[0].url, BALANCE_URL);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');

    // 非 let-gal 数值字段仍严格；H/K 只要“存在且为 string”就放行，非法值
    // 原样透传（UI parsePenaltyIntegerString → null → “未知”）。
    const strictCases = [
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
    for (const payload of strictCases) {
        await assertRejectsFixed(makeClient(makeFetch(jsonResponse(payload))).fetchBalance('cred_abc'), 'plugin_balance_fetch_failed');
    }

    const degraded = {
        ...VALID_BALANCE,
        penalty_input_threshold: '1.5',
        penalty_multiplier: '-1',
    };
    const degradedResult = await makeClient(makeFetch(jsonResponse(degraded))).fetchBalance('cred_abc');
    assert.equal(degradedResult.penalty_input_threshold, '1.5');
    assert.equal(degradedResult.penalty_multiplier, '-1');
    assert.equal(degradedResult.permanent_balance, '1.000000');

    for (const value of ['', '1e3', '9223372036854775808']) {
        const resultValue = await makeClient(makeFetch(jsonResponse({
            ...VALID_BALANCE,
            penalty_input_threshold: value,
        }))).fetchBalance('cred_abc');
        assert.equal(resultValue.penalty_input_threshold, value);
    }
});

test('query 401 raises unauthorized (login invalid), other statuses stay unchecked', async () => {
    for (const method of ['fetchMe', 'fetchKeys', 'fetchModels', 'fetchBalance']) {
        const client = makeClient(makeFetch({ status: 401, body: streamOf('{"error":"leak"}') }));
        await assert.rejects(client[method]('cred_abc'), (error) => {
            assert.equal(error.unauthorized, true);
            assert.equal(error.body, undefined);
            return true;
        });
    }
    for (const method of ['fetchMe', 'fetchKeys', 'fetchModels', 'fetchBalance']) {
        for (const status of [403, 429, 500, 503]) {
            const client = makeClient(makeFetch({ status, body: streamOf('{"error":"leak"}') }));
            await assert.rejects(client[method]('cred_abc'), (error) => {
                assert.equal(error.unauthorized, false);
                assert.equal(error.invalidShape, false);
                return true;
            });
        }
    }
    for (const method of ['fetchMe', 'fetchKeys', 'fetchModels', 'fetchBalance']) {
        await assertRejectsFixed(makeClient(makeFetch(jsonResponse({})))[method](''), method === 'fetchMe'
            ? 'plugin_me_fetch_failed'
            : method === 'fetchKeys'
                ? 'plugin_keys_fetch_failed'
                : method === 'fetchModels'
                    ? 'plugin_models_fetch_failed'
                    : 'plugin_balance_fetch_failed');
    }
});

test('bad JSON and oversized bodies fail closed without reading the whole body', async () => {
    for (const method of ['fetchMe', 'fetchKeys', 'fetchModels', 'fetchBalance']) {
        const client = makeClient(makeFetch({ status: 200, body: streamOf('{bad') }));
        await assert.rejects(client[method]('cred_abc'), (error) => {
            assert.equal(error.invalidShape, true);
            return true;
        });
    }

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
    await assertRejectsFixed(client.fetchKeys('cred_abc'), 'plugin_keys_fetch_failed');
    assert.equal(cancelled, true);
});

test('network failures and timeouts are fixed errors and never retried', async () => {
    for (const method of ['fetchMe', 'fetchKeys', 'fetchModels', 'fetchBalance']) {
        const fetchImpl = makeFetch(async () => { throw new TypeError('fetch failed'); });
        const client = makeClient(fetchImpl);
        await assert.rejects(client[method]('cred_abc'), (error) => {
            assert.equal(error.invalidShape, false);
            assert.equal(error.unauthorized, false);
            return true;
        });
        assert.equal(fetchImpl.calls.length, 1);
    }

    const slow = makeFetch((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    }));
    const client = makeClient(slow, 20);
    await assertRejectsFixed(client.fetchBalance('cred_abc'), 'plugin_balance_fetch_failed');
    assert.equal(slow.calls.length, 1);
});

test('the query client never logs URLs, bodies, or credential values', async () => {
    const recorded = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => recorded.push({ method, args });
    }
    try {
        const fetchImpl = makeFetch((url) => {
            if (url === ME_URL) return jsonResponse({ username: 'alice' });
            if (url === KEYS_URL) return jsonResponse({ keys: [{ id: 'd', name: 'n', masked: 'm', status: 'enabled' }] });
            if (url === MODELS_URL) return jsonResponse({ object: 'list', data: [{ id: 'm', protocol_faces: ['chat'] }] });
            if (url === BALANCE_URL) return jsonResponse(VALID_BALANCE);
            return { status: 500 };
        });
        const client = makeClient(fetchImpl);
        await client.fetchMe('cred_abc');
        await client.fetchKeys('cred_abc');
        await client.fetchModels('cred_abc');
        await client.fetchBalance('cred_abc');

        const failing = makeClient(makeFetch({ status: 500, body: streamOf('leak') }));
        await assert.rejects(failing.fetchMe('cred_abc'));
        await assert.rejects(failing.fetchKeys('cred_abc'));
        await assert.rejects(failing.fetchModels('cred_abc'));
        await assert.rejects(failing.fetchBalance('cred_abc'));
        assert.equal(recorded.length, 0);
    } finally {
        for (const method of methods) {
            console[method] = originals[method];
        }
    }
});

test('fetchMeKey 401 is marked unauthorized for the plan refresh distinction', async () => {
    const client = makeClient(makeFetch({ status: 401, body: streamOf('{"error":"leak"}') }));
    await assert.rejects(client.fetchMeKey('cred_abc'), (error) => {
        assert.equal(error.code, 'plugin_key_fetch_failed');
        assert.equal(error.unauthorized, true);
        assert.equal(error.body, undefined);
        return true;
    });
    const ok = makeClient(makeFetch(jsonResponse({ key: 'k', username: 'alice' })));
    assert.deepEqual(await ok.fetchMeKey('cred_abc'), { key: 'k', username: 'alice' });
});
