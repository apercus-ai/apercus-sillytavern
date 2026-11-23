'use strict';

const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let L;

const PLUGIN_STATUS = {
    authAvailable: false,
    connected: false,
    code: 'pass_binding_unavailable',
    message: 'Pass 绑定接口尚未接通',
    protocols: { chat: false, anthropic: false, responses: false },
    state: 'not_connected',
    st_connection: { state: 'unknown' },
};

const BALANCE = {
    permanent_balance: '12.345678',
    debt: '0.000000',
    daily_quota: '3.000000',
    daily_quota_used: '0.500000',
    daily_quota_remaining: '2.500000',
    quota_date: '2026-11-12',
    needs_refresh: false,
    observed_at: '2026-11-12T03:04:05Z',
};

function model(overrides = {}) {
    return {
        name: 'model-a',
        protocol_faces: ['chat'],
        modality: 'text',
        capabilities: '{"streaming":true}',
        ...overrides,
    };
}

before(async () => {
    L = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'logic.mjs')));
});

test('protocol selection: chat wins when both faces are present', () => {
    const item = L.normalizeModelItem(model({ protocol_faces: ['anthropic', 'chat'] }));
    assert.deepEqual(L.faceForModel(item), { face: 'chat', disabled: false, reason: null });
});

test('protocol selection: anthropic is disabled because no verified adapter exists', () => {
    const withCaps = L.faceForModel(model({ protocol_faces: ['anthropic'], capabilities: '{"tools":true}' }));
    assert.deepEqual(withCaps, { face: 'anthropic', disabled: true, reason: 'anthropic_adapter_unavailable' });

    const withoutCaps = L.faceForModel(model({ protocol_faces: ['anthropic'], capabilities: '' }));
    assert.deepEqual(withoutCaps, { face: 'anthropic', disabled: true, reason: 'anthropic_adapter_unavailable' });
});

test('protocol selection: responses-only, unknown, and malformed faces stay disabled', () => {
    const responses = L.faceForModel(model({ protocol_faces: ['responses'] }));
    assert.equal(responses.disabled, true);
    assert.equal(responses.reason, 'responses_not_enabled');

    const none = L.faceForModel(model({ protocol_faces: [] }));
    assert.equal(none.reason, 'face_not_enabled');

    const image = L.faceForModel(model({ protocol_faces: ['image'] }));
    assert.equal(image.reason, 'face_not_enabled');

    const unknownFace = L.classifyCatalog({ items: [model({ protocol_faces: ['unknown_face'] })] });
    assert.equal(unknownFace.items.length, 0);
    assert.equal(unknownFace.invalidCount, 1);

    assert.equal(L.faceForModel(null).reason, 'invalid_entry');
});

test('catalog: invalid envelopes and invalid entries are not invented', () => {
    assert.equal(L.classifyCatalog(null).ok, false);
    assert.equal(L.classifyCatalog({}).ok, false);
    assert.equal(L.classifyCatalog({ items: 'nope' }).ok, false);

    const catalog = L.classifyCatalog({
        items: [
            model(),
            model({ name: '' }),
            model({ name: 42 }),
            model({ modality: 'audio' }),
            model({ capabilities: null }),
            'not-an-object',
        ],
    });
    assert.equal(catalog.ok, true);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.invalidCount, 5);
    assert.equal(catalog.items[0].name, 'model-a');
});

test('catalog: unknown fields are dropped and optional classification stays optional', () => {
    const catalog = L.classifyCatalog({
        items: [
            model({ classification_name: 'gallery', extra: 'must-not-survive' }),
            model({ name: 'model-b' }),
        ],
    });
    assert.equal(catalog.items[0].classification_name, 'gallery');
    assert.equal(Object.hasOwn(catalog.items[0], 'extra'), false);
    assert.equal(L.rowView(catalog.items[1], { ok: true, value: PLUGIN_STATUS }).classification, null);
});

test('remote strings remain data: HTML-looking model names are preserved unchanged', () => {
    const markup = '<b>model</b>';
    const normalized = L.normalizeModelItem(model({ name: markup }));
    assert.equal(normalized.name, markup);
    const view = L.rowView(normalized, { ok: true, value: PLUGIN_STATUS });
    assert.equal(view.name, markup);

    const withSpaces = L.normalizeModelItem(model({ name: '<img src=x onerror=alert(1)>' }));
    assert.equal(withSpaces.name, '<img src=x onerror=alert(1)>');
});

test('catalog: names follow the server limit, including spaces and 256-512 lengths', () => {
    const spaced = 'model with spaces';
    assert.equal(L.normalizeModelItem(model({ name: spaced })).name, spaced);

    for (const length of [256, 300, 512]) {
        const name = 'm'.repeat(length);
        assert.equal(L.normalizeModelItem(model({ name })).name, name);
    }
    assert.equal(L.normalizeModelItem(model({ name: 'm'.repeat(513) })), null);
});

test('status: contract booleans are strict and disconnected protocols are unusable', () => {
    const parsed = L.parseStatus(PLUGIN_STATUS);
    assert.equal(parsed.ok, true);
    assert.equal(L.canUseProtocol(parsed, 'chat'), false);
    assert.equal(L.canUseProtocol(parsed, 'anthropic'), false);
    assert.equal(L.canUseProtocol(parsed, 'responses'), false);
    assert.equal(L.canUseProtocol(parsed, null), false);

    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, protocols: { chat: false, anthropic: false } }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, connected: 'false' }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, authAvailable: null }).ok, false);
});

test('status v3: four states, optional username, and st_connection are strict', () => {
    const authorized = L.parseStatus({
        ...PLUGIN_STATUS,
        state: 'authorized',
        username: 'alice',
        st_connection: { state: 'unknown' },
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.value.state, 'authorized');
    assert.equal(authorized.value.username, 'alice');
    assert.equal(L.isAuthorized(authorized), true);

    for (const state of ['not_connected', 'pending', 'invalid']) {
        const parsed = L.parseStatus({ ...PLUGIN_STATUS, state });
        assert.equal(parsed.ok, true, state);
        assert.equal(L.isAuthorized(parsed), false, state);
    }

    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'connected' }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: undefined }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'authorized', username: 42 }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'invalid', reason: '' }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, st_connection: null }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, st_connection: { state: 'yes' } }).ok, false);
    // W1：connect_pending 可缺省（旧服务端=false），存在时必须是布尔。
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS }).value.connect_pending, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'authorized', connect_pending: true }).value.connect_pending, true);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, connect_pending: 'true' }).ok, false);
    // W10：local_cleared 同口径，可缺省；只在 invalid/login_invalidated 时有意义。
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS }).value.local_cleared, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'invalid', local_cleared: true }).value.local_cleared, true);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, local_cleared: 'yes' }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS }).value.custom_cleared, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, state: 'invalid', custom_cleared: true }).value.custom_cleared, true);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, custom_cleared: 'yes' }).ok, false);
    assert.equal(L.parseStatus({ ...PLUGIN_STATUS, connected: false, authAvailable: false }).ok, true);
    assert.equal(L.isAuthorized({ ok: false }), false);
});

test('connect status parser accepts exactly four states and a valid username', () => {
    for (const status of ['connecting', 'pending', 'authorized', 'invalid']) {
        const parsed = L.parseConnectStatus({ status });
        assert.equal(parsed.ok, true, status);
        assert.equal(parsed.value.status, status);
        assert.equal(parsed.value.username, null);
    }
    const withName = L.parseConnectStatus({ status: 'authorized', username: 'alice' });
    assert.equal(withName.ok, true);
    assert.equal(withName.value.username, 'alice');

    assert.equal(L.parseConnectStatus({ status: 'bound' }).ok, false);
    assert.equal(L.parseConnectStatus({ status: 'authorized', username: '' }).ok, false);
    assert.equal(L.parseConnectStatus({ status: 'authorized', username: 7 }).ok, false);
    assert.equal(L.parseConnectStatus(null).ok, false);
});

test('gateway authorize URLs require https, the fixed host, no credentials, and the default port', () => {
    assert.equal(L.isGatewayAuthorizeUrl('https://gw.apercus.ai/portal/connect?request_ref=x'), true);
    assert.equal(L.isGatewayAuthorizeUrl('https://gw.apercus.ai:443/authorize'), true);
    for (const url of [
        'http://gw.apercus.ai/authorize',
        'https://api.apercus.ai/authorize',
        'https://gw.apercus.ai.evil.example/authorize',
        'https://evil.example/gw.apercus.ai',
        'https://user:pass@gw.apercus.ai/authorize',
        'https://gw.apercus.ai:8443/authorize',
        'not a url',
        '',
    ]) {
        assert.equal(L.isGatewayAuthorizeUrl(url), false, url);
    }
});

test('balance: needs_refresh is highlighted and never merged into a single usable number', () => {
    const parsed = L.parseBalance({ ...BALANCE, needs_refresh: true });
    assert.equal(parsed.ok, true);
    const view = L.balanceRows(parsed.value);
    assert.equal(view.warning !== null, true);
    assert.deepEqual(view.rows.map(row => row.key), ['daily_quota_remaining', 'permanent_balance', 'debt']);
    assert.equal(view.rows[0].value, '2.500000');
    assert.equal(view.rows[1].value, '12.345678');
    assert.equal(view.rows[2].value, '0.000000');
    assert.equal(view.rows.some(row => row.label.includes('合计') || row.label.includes('总')), false);

    const fresh = L.balanceRows(L.parseBalance(BALANCE).value);
    assert.equal(fresh.warning, null);
    assert.equal(fresh.rows[0].value, BALANCE.daily_quota_remaining);
});

test('balance: invalid or non-fixed decimals are rejected instead of coerced', () => {
    assert.equal(L.isBalanceDecimal('1'), false);
    assert.equal(L.isBalanceDecimal('-1.000000'), false);
    assert.equal(L.isBalanceDecimal('1.2'), false);
    assert.equal(L.isBalanceDecimal(1.2), false);
    assert.equal(L.isBalanceDecimal('1.000000'), true);

    assert.equal(L.parseBalance({ ...BALANCE, debt: '1' }).ok, false);
    assert.equal(L.parseBalance({ ...BALANCE, daily_quota_remaining: undefined }).ok, false);
    assert.equal(L.parseBalance({ ...BALANCE, needs_refresh: 'false' }).ok, false);
    assert.equal(L.parseBalance({ ...BALANCE, observed_at: '2026-11-12 03:04:05' }).ok, false);
    assert.equal(L.parseBalance({ ...BALANCE, quota_date: '2026-13-40' }).ok, false);
});

test('row view: current server state (all protocols false) disables every row', () => {
    const offline = L.parseStatus(PLUGIN_STATUS);
    const chat = L.rowView(model(), offline);
    assert.equal(chat.disabled, true);
    assert.equal(chat.reason, 'protocol_not_connected');

    const anthropic = L.rowView(model({ protocol_faces: ['anthropic'] }), offline);
    assert.equal(anthropic.disabled, true);
    assert.equal(anthropic.reason, 'anthropic_adapter_unavailable');

    const responses = L.rowView(model({ protocol_faces: ['responses'] }), offline);
    assert.equal(responses.disabled, true);
    assert.equal(responses.reason, 'responses_not_enabled');
});

test('row view: a live chat protocol still reports no adapter, not a fake connection', () => {
    const live = L.parseStatus({
        ...PLUGIN_STATUS,
        connected: true,
        protocols: { chat: true, anthropic: true, responses: true },
    });
    const chat = L.rowView(model(), live);
    assert.equal(chat.disabled, true);
    assert.equal(chat.reason, 'adapter_unavailable');

    const both = L.rowView(model({ protocol_faces: ['anthropic', 'chat'] }), live);
    assert.equal(both.face, 'chat');
    assert.equal(both.disabled, true);
    assert.equal(both.reason, 'adapter_unavailable');

    const anthropic = L.rowView(model({ protocol_faces: ['anthropic'] }), live);
    assert.equal(anthropic.disabled, true);
    assert.equal(anthropic.reason, 'anthropic_adapter_unavailable');
});

test('row view: unusable status wins and no catalog row can become enabled', () => {
    const view = L.rowView(model(), { ok: false, reason: 'status_invalid' });
    assert.equal(view.disabled, true);
    assert.equal(view.reason, 'status_unavailable');

    const catalog = L.classifyCatalog({
        items: [
            model(),
            model({ name: 'model-anthropic', protocol_faces: ['anthropic'] }),
            model({ name: 'model-responses', protocol_faces: ['responses'] }),
        ],
    });
    for (const item of catalog.items) {
        assert.equal(L.rowView(item, { ok: true, value: PLUGIN_STATUS }).disabled, true);
    }
});

test('UI source keeps remote data as text and persists no credentials', () => {
    const uiSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.js'), 'utf8');
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(uiSource), false);
    assert.equal(/localStorage|sessionStorage/.test(uiSource), false);
    assert.match(uiSource, /\.textContent/);
    assert.match(uiSource, /ctx\.getRequestHeaders/);
    assert.equal(/Authorization|Bearer/.test(uiSource), false);
    assert.equal(/credentials\s*:/.test(uiSource), false);
    // B3 文案可以提到服务端写入 api_key_custom，但 UI 自身绝不写 secret 或 key。
    assert.equal(/api_key_custom\s*=/.test(uiSource), false);
    assert.equal(/settings\.api_key/.test(uiSource), false);
    assert.equal(/writeSecret|readSecret/.test(uiSource), false);
});

test('version declarations only claim source-checked SillyTavern 1.17.0 (U9)', () => {
    for (const file of ['index.js', 'logic.mjs']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'ui', file), 'utf8');
        assert.equal(source.includes('1.16.0'), false, file);
        assert.match(source, /1\.17\.0/, file);
        assert.equal(/已验收|验收通过|supports 1\.19|支持 1\.19/.test(source), false, file);
    }
});
