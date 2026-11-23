'use strict';

// POST /plan（B2 防截断分节）的行为锁定：身份、同源写闸、绑定、严格请求体、
// 固定上游目标与重试语义。helper 与 server-core.test.js 同款（假 req/res、
// makeFetch 录制型假 fetch），保持两文件独立、无共享运行时。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCore } = require('../server/core.js');

// 断言字面域名，不从被测模块导出的常量推导：常量被改动时测试必须先红。
const PLAN_URL = 'https://api.apercus.ai/v1/chat/completions';
const BINDING = 'agw_plan_binding';
const MODEL = 'model-a';
const PROMPT = '你是分节配置器。（测试用提示词）';

const MESSAGES = {
    forbidden: '未登录或会话无效。',
    origin: '跨源写请求被拒绝。',
    notConnected: '尚未完成 Apercus 网关账户绑定。',
    upstream: '网关暂时不可用，请稍后重试。',
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

function completionBody(text) {
    return JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] });
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

function buildCore(overrides) {
    const options = overrides || {};
    return createCore({
        readBinding: options.readBinding || (async () => BINDING),
        fetchImpl: options.fetchImpl
            || makeFetch({ status: 200, body: streamOf(completionBody('["开场","推进"]')) }),
        planTimeoutMs: options.planTimeoutMs,
        maxBytes: options.maxBytes,
        planRateLimitPerMinute: options.planRateLimitPerMinute,
        now: options.now,
    });
}

function planReq(overrides) {
    const extra = overrides || {};
    return {
        method: 'POST',
        url: '/api/plugins/apercus-gateway/plan',
        headers: { host: 'localhost:8000', origin: 'http://localhost:8000', ...(extra.headers || {}) },
        user: 'user' in extra ? extra.user : { directories: { root: '/u/alice' } },
        body: 'body' in extra ? extra.body : { model: MODEL, prompt: PROMPT },
    };
}

function assertNoStore(result) {
    assert.equal(result.headers['cache-control'], 'no-store');
}

test('plan: missing req.user is 401 unauthorized; malformed directories stay 403', async () => {
    const core = buildCore();
    const missing = await call(core.handlers.plan, planReq({ user: undefined }));
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, 'unauthorized');
    assert.equal(missing.json().error.message, MESSAGES.forbidden);
    assertNoStore(missing);

    const malformed = await call(core.handlers.plan, planReq({ user: {} }));
    assert.equal(malformed.statusCode, 403);
    assert.equal(malformed.json().error.code, 'forbidden');
});

test('plan: no Origin and no same-origin fetch metadata is 403 origin_forbidden', async () => {
    const core = buildCore();
    const result = await call(core.handlers.plan, planReq({ headers: { origin: undefined } }));
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error.code, 'origin_forbidden');
    assert.equal(result.json().error.message, MESSAGES.origin);
    assertNoStore(result);
});

test('plan: Sec-Fetch-Site same-origin passes the write gate without Origin', async () => {
    const core = buildCore({ readBinding: async () => null });
    const result = await call(core.handlers.plan, planReq({
        headers: { origin: undefined, 'sec-fetch-site': 'same-origin' },
    }));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
});

test('plan: forged cross-origin Origin is 403', async () => {
    const core = buildCore();
    const result = await call(core.handlers.plan, planReq({
        headers: { origin: 'https://evil.example' },
    }));
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error.code, 'origin_forbidden');
    assert.equal(result.json().error.message, MESSAGES.origin);
});

test('plan: scheme mismatch without X-Forwarded-Proto is 403; https proxy setup passes', async () => {
    const core = buildCore({ readBinding: async () => null });
    const mismatch = await call(core.handlers.plan, planReq({
        headers: { origin: 'https://localhost:8000' },
    }));
    assert.equal(mismatch.statusCode, 403);
    assert.equal(mismatch.json().error.code, 'origin_forbidden');

    const proxied = await call(core.handlers.plan, planReq({
        headers: { origin: 'https://localhost:8000', 'x-forwarded-proto': 'https' },
    }));
    assert.equal(proxied.statusCode, 409);
    assert.equal(proxied.json().error.code, 'not_connected');
});

test('plan: without a binding it is always 409 not_connected (fail-closed before B1)', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf(completionBody('X')) });
    const core = buildCore({ readBinding: async () => null, fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
    assert.equal(result.json().error.message, MESSAGES.notConnected);
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 0);
});

test('plan: unknown fields and wrong types are 422 invalid_request', async () => {
    const cases = [
        { model: MODEL, prompt: PROMPT, extra: 1 },
        { prompt: PROMPT },
        { model: MODEL },
        { model: 42, prompt: PROMPT },
        { model: MODEL, prompt: 42 },
        { model: '', prompt: PROMPT },
        { model: MODEL, prompt: '' },
        {},
    ];
    for (const body of cases) {
        const core = buildCore();
        const result = await call(core.handlers.plan, planReq({ body }));
        assert.equal(result.statusCode, 422, JSON.stringify(body));
        assert.equal(result.json().error.code, 'invalid_request', JSON.stringify(body));
        assertNoStore(result);
    }
});

test('plan: unparsed or malformed raw bodies are 422, never guessed', async () => {
    const core = buildCore();
    const badJson = await call(core.handlers.plan, planReq({ body: '{not json' }));
    assert.equal(badJson.statusCode, 422);
    assert.equal(badJson.json().error.code, 'invalid_request');

    const absent = await call(core.handlers.plan, planReq({ body: undefined }));
    assert.equal(absent.statusCode, 422);
    assert.equal(absent.json().error.code, 'invalid_request');
});

test('plan: success path posts the fixed shape to the fixed data-plane URL and returns only {text}', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf(completionBody('SPLIT_TEXT')) });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq({
        headers: { authorization: 'Bearer client-supplied' },
    }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { text: 'SPLIT_TEXT' });
    assert.deepEqual(Object.keys(result.json()), ['text']);
    assert.equal(result.body.includes(BINDING), false);
    assert.equal(result.body.includes(PROMPT), false);
    assertNoStore(result);

    assert.equal(fetchImpl.calls.length, 1);
    const sent = fetchImpl.calls[0];
    assert.equal(sent.url, PLAN_URL);
    assert.equal(sent.options.method, 'POST');
    assert.equal(sent.options.redirect, 'error');
    assert.ok(sent.options.signal);
    assert.deepEqual(sent.options.headers, {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${BINDING}`,
    });
    const body = JSON.parse(sent.options.body);
    assert.deepEqual(body, {
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0.2,
        max_tokens: 4096,
    });
    assert.equal(Object.hasOwn(body, 'tools'), false);
    assert.equal(Object.hasOwn(body, 'tool_choice'), false);
    assert.equal(Object.hasOwn(body, 'functions'), false);
});

test('plan: model/prompt length bounds are 422; exact bounds pass', async () => {
    // 工厂式假 fetch：每次调用返回全新响应对象（流只能消费一次，复用对象会 502）。
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl });
    const longModel = await call(core.handlers.plan, planReq({ body: { model: 'm'.repeat(513), prompt: PROMPT } }));
    assert.equal(longModel.statusCode, 422);
    assert.equal(longModel.json().error.code, 'invalid_request');

    const maxModel = await call(core.handlers.plan, planReq({ body: { model: 'm'.repeat(512), prompt: PROMPT } }));
    assert.equal(maxModel.statusCode, 200);

    const longPrompt = await call(core.handlers.plan, planReq({ body: { model: MODEL, prompt: 'p'.repeat(32769) } }));
    assert.equal(longPrompt.statusCode, 422);

    const maxPrompt = await call(core.handlers.plan, planReq({ body: { model: MODEL, prompt: 'p'.repeat(32768) } }));
    assert.equal(maxPrompt.statusCode, 200);
});

test('plan: upstream 5xx retries exactly once', async () => {
    const fetchImpl = makeFetch({ status: 500, body: streamOf('boom') });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(fetchImpl.calls.length, 2);
});

test('plan: 5xx then success recovers on the retry', async () => {
    let attempt = 0;
    const fetchImpl = makeFetch(() => {
        attempt += 1;
        return attempt === 1
            ? { status: 503, body: streamOf('x') }
            : { status: 200, body: streamOf(completionBody('OK')) };
    });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { text: 'OK' });
    assert.equal(fetchImpl.calls.length, 2);
});

test('plan: 4xx does not retry and maps to the fixed upstream error without echoing status or body', async () => {
    const fetchImpl = makeFetch({ status: 400, body: streamOf('{"error":"leak"}') });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(result.json().error.message, MESSAGES.upstream);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(result.body.includes('leak'), false);
    assert.equal(result.body.includes('400'), false);
    assertNoStore(result);
});

test('plan: network errors retry exactly once', async () => {
    const fetchImpl = makeFetch(async () => {
        throw new TypeError('fetch failed');
    });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(fetchImpl.calls.length, 2);
});

test('plan: timeout retries once then maps to 504', async () => {
    const fetchImpl = makeFetch((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    }));
    const core = buildCore({ fetchImpl, planTimeoutMs: 25 });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 504);
    assert.equal(result.json().error.code, 'upstream_timeout');
    assert.equal(fetchImpl.calls.length, 2);
});

test('plan: 200 with malformed body or shape fails closed without retry', async () => {
    const badJson = makeFetch({ status: 200, body: streamOf('{not json') });
    const coreBad = buildCore({ fetchImpl: badJson });
    const resultBad = await call(coreBad.handlers.plan, planReq());
    assert.equal(resultBad.statusCode, 502);
    assert.equal(resultBad.json().error.code, 'upstream_invalid_response');
    assert.equal(badJson.calls.length, 1);

    const badShape = makeFetch({ status: 200, body: streamOf(JSON.stringify({ choices: [] })) });
    const coreShape = buildCore({ fetchImpl: badShape });
    const resultShape = await call(coreShape.handlers.plan, planReq());
    assert.equal(resultShape.statusCode, 502);
    assert.equal(resultShape.json().error.code, 'upstream_invalid_response');
    assert.equal(badShape.calls.length, 1);
});

test('plan: per-request directories pick the binding; other users stay not_connected', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf(completionBody('X')) });
    const core = createCore({
        readBinding: async (directories) => (directories.root === '/u/alice' ? BINDING : null),
        fetchImpl,
    });
    const alice = await call(core.handlers.plan, planReq());
    assert.equal(alice.statusCode, 200);
    assert.equal(fetchImpl.calls[0].options.headers.authorization, `Bearer ${BINDING}`);

    const bob = await call(core.handlers.plan, planReq({ user: { directories: { root: '/u/bob' } } }));
    assert.equal(bob.statusCode, 409);
    assert.equal(fetchImpl.calls.length, 1);
});

test('plan: nothing about the request, response, or binding reaches the console', async () => {
    const recorded = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => recorded.push({ method, args });
    }
    try {
        const ok = makeFetch({ status: 200, body: streamOf(completionBody('TEXT')) });
        await call(buildCore({ fetchImpl: ok }).handlers.plan, planReq());

        const failing = makeFetch({ status: 500, body: streamOf('boom') });
        await call(buildCore({ fetchImpl: failing }).handlers.plan, planReq());

        assert.equal(recorded.length, 0);
    } finally {
        for (const method of methods) {
            console[method] = originals[method];
        }
    }
});

// ===== readPlanBody 流式回退分支（评审 nit：原为零覆盖路径）=====

const { EventEmitter } = require('node:events');

function makeStreamReq(chunks, options) {
    const opts = options || {};
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/plugins/apercus-gateway/plan';
    req.headers = { host: 'localhost:8000', origin: 'http://localhost:8000' };
    req.user = { directories: { root: '/u/alice' } };
    req.readableEnded = false;
    req.body = undefined;
    setImmediate(() => {
        if (opts.abort) {
            req.emit('aborted');
            return;
        }
        for (const chunk of chunks) {
            if (opts.oversize) continue; // 只累计长度，不进 data 也行——直接发大数据
            req.emit('data', chunk);
        }
        if (opts.abortAfterData) {
            req.emit('aborted');
            return;
        }
        req.emit(opts.endError ? 'error' : 'end');
    });
    return req;
}

test('plan: streamed raw bodies are parsed and gated exactly like pre-parsed ones', async () => {
    const core = buildCore({ fetchImpl: makeFetch({ status: 200, body: streamOf(completionBody('STREAM')) }) });
    const ok = await call(core.handlers.plan, makeStreamReq([Buffer.from(JSON.stringify({ model: MODEL, prompt: PROMPT }), 'utf8')]));
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { text: 'STREAM' });

    const badJson = await call(core.handlers.plan, makeStreamReq([Buffer.from('{not json', 'utf8')]));
    assert.equal(badJson.statusCode, 422);
    assert.equal(badJson.json().error.code, 'invalid_request');

    const unknownField = await call(core.handlers.plan, makeStreamReq([Buffer.from(JSON.stringify({ model: MODEL, prompt: PROMPT, extra: 1 }), 'utf8')]));
    assert.equal(unknownField.statusCode, 422);
});

test('plan: oversized streamed bodies and aborted streams fail closed', async () => {
    // 字段字符长度合法（22000 < 32768），但 UTF-8 字节超过 PLAN_MAX_BYTES
    //（64KiB）：必须由体积闸拒绝，且上游零调用。
    const fetchImpl = makeFetch({ status: 200, body: streamOf(completionBody('X')) });
    const big = buildCore({ fetchImpl });
    const validButOversize = JSON.stringify({ model: MODEL, prompt: '汉'.repeat(22000) });
    const oversize = await call(big.handlers.plan, makeStreamReq([Buffer.from(validButOversize, 'utf8')]));
    assert.equal(oversize.statusCode, 422);
    assert.equal(oversize.json().error.code, 'invalid_request');
    assert.equal(fetchImpl.calls.length, 0);

    const aborted = await call(buildCore().handlers.plan, makeStreamReq([], { abort: true }));
    assert.equal(aborted.statusCode, 422);
    assert.equal(aborted.json().error.code, 'invalid_request');

    const abortedAfterData = await call(buildCore().handlers.plan, makeStreamReq([Buffer.from('{"model":"m","prompt":"p"}')], { abortAfterData: true }));
    assert.equal(abortedAfterData.statusCode, 422);
});

test('plan: upstream 401 becomes binding_invalidated without retry or body leakage', async () => {
    const fetchImpl = makeFetch({ status: 401, body: streamOf('{"error":"secret-leak"}') });
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq());
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'binding_invalidated');
    assert.equal(result.json().error.message, '绑定凭据失效（key 已重置或登录已撤销），请重新连接网关。');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(result.body.includes('secret-leak'), false);
    assert.equal(result.body.includes('401'), false);
});

// ===== 体积闸（评审 F）：Content-Length / 已解析对象 / 字符串 body =====

test('plan: Content-Length over PLAN_MAX_BYTES is 422 before reading body or upstream', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl });
    const result = await call(core.handlers.plan, planReq({
        headers: { 'content-length': String(64 * 1024 + 1) },
    }));
    assert.equal(result.statusCode, 422);
    assert.equal(result.json().error.code, 'invalid_request');
    assert.equal(fetchImpl.calls.length, 0);
});

test('plan: parsed object and string body over PLAN_MAX_BYTES are 422 before upstream', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl });
    const cjkPrompt = '汉'.repeat(22000); // 字符数合法，UTF-8 字节 > 64KiB。
    const parsed = await call(core.handlers.plan, planReq({
        body: { model: MODEL, prompt: cjkPrompt },
    }));
    assert.equal(parsed.statusCode, 422);
    assert.equal(parsed.json().error.code, 'invalid_request');

    const asString = await call(core.handlers.plan, planReq({
        body: JSON.stringify({ model: MODEL, prompt: cjkPrompt }),
    }));
    assert.equal(asString.statusCode, 422);
    assert.equal(asString.json().error.code, 'invalid_request');
    assert.equal(fetchImpl.calls.length, 0);
});

test('plan: 16000-char CJK summary fits inside the 64KiB body budget (S7)', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl });
    const summary = '节'.repeat(16000); // 48KB UTF-8，加固定提示词仍 < 64KiB。
    const fits = await call(core.handlers.plan, planReq({
        body: { model: MODEL, prompt: summary },
    }));
    assert.equal(fits.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 1);

    // 64KiB 字节边界：ASCII 会先撞 32768 字符上限，故用 CJK 填到字节边界。
    const overhead = Buffer.byteLength(JSON.stringify({ model: MODEL, prompt: '' }));
    const count = Math.floor((64 * 1024 - overhead) / 3);
    const boundary = '汉'.repeat(count);
    const atLimit = await call(core.handlers.plan, planReq({
        body: { model: MODEL, prompt: boundary },
    }));
    assert.equal(atLimit.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 2);

    const overLimit = await call(core.handlers.plan, planReq({
        body: { model: MODEL, prompt: `${boundary}汉` },
    }));
    assert.equal(overLimit.statusCode, 422);
    assert.equal(overLimit.json().error.code, 'invalid_request');
    assert.equal(fetchImpl.calls.length, 2);
});

// ===== 每用户限频（评审 E）=====

test('plan: per-user fixed-window limit rejects the 7th request with 429 before reading the body', async () => {
    let clock = 1000;
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl, planRateLimitPerMinute: 6, now: () => clock });
    for (let index = 0; index < 6; index += 1) {
        const ok = await call(core.handlers.plan, planReq());
        assert.equal(ok.statusCode, 200, String(index));
    }
    assert.equal(fetchImpl.calls.length, 6);

    const limited = await call(core.handlers.plan, planReq({ body: undefined }));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.equal(limited.json().error.message, '请求过于频繁，请稍后重试。');
    assertNoStore(limited);
    assert.equal(fetchImpl.calls.length, 6);
});

test('plan: rate limit is per user and resets after the window', async () => {
    let clock = 1000;
    const fetchImpl = makeFetch(() => ({ status: 200, body: streamOf(completionBody('X')) }));
    const core = buildCore({ fetchImpl, planRateLimitPerMinute: 2, now: () => clock });
    assert.equal((await call(core.handlers.plan, planReq())).statusCode, 200);
    assert.equal((await call(core.handlers.plan, planReq())).statusCode, 200);
    assert.equal((await call(core.handlers.plan, planReq())).statusCode, 429);

    const bob = await call(core.handlers.plan, planReq({ user: { directories: { root: '/u/bob' } } }));
    assert.equal(bob.statusCode, 200);

    clock += 60000;
    const aliceAfterWindow = await call(core.handlers.plan, planReq());
    assert.equal(aliceAfterWindow.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 4);
});
