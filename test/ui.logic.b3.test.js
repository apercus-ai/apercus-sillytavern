'use strict';

// B3 面板计量的纯逻辑：H/K 解析、色带、上下文视图、计数聚合、模型可选性与
// key 列表脱敏视图。全部函数无副作用。

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let L = null;

async function loadLogic() {
    if (!L) {
        L = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'logic.mjs')).href);
    }
    return L;
}

test('parsePenaltyIntegerString accepts non-negative integer strings up to MaxInt64', async () => {
    const { parsePenaltyIntegerString } = await loadLogic();
    assert.equal(parsePenaltyIntegerString('0'), '0');
    assert.equal(parsePenaltyIntegerString('1000'), '1000');
    assert.equal(parsePenaltyIntegerString('0005'), '0005');
    assert.equal(parsePenaltyIntegerString('9223372036854775807'), '9223372036854775807');
    assert.equal(parsePenaltyIntegerString('9223372036854775808'), null);
    for (const value of ['', '-1', '1.5', '1e3', ' 1', '1 ', 1000, null, undefined, {}, []]) {
        assert.equal(parsePenaltyIntegerString(value), null, String(value));
    }
});

test('parseBalance keeps base fields strict and degrades H/K to unknown', async () => {
    const { parseBalance, balanceRows } = await loadLogic();
    const base = {
        permanent_balance: '1.000000',
        debt: '0.000000',
        daily_quota: '5.000000',
        daily_quota_used: '2.500000',
        daily_quota_remaining: '2.500000',
        quota_date: '2026-11-12',
        needs_refresh: false,
        observed_at: '2026-11-12T00:00:00Z',
        penalty_input_threshold: '5000',
        penalty_multiplier: '1200',
    };
    const parsed = parseBalance(base);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.penalty_input_threshold, '5000');
    assert.equal(parsed.value.penalty_multiplier, '1200');
    const view = balanceRows(parsed.value);
    assert.deepEqual(view.penalty, { threshold: '5000', multiplier: '1200' });
    assert.equal(view.rows.length, 3);

    // v1.35 契约两字段必填，但 UI 口径是单字段降级为「未知」，不拒绝整包。
    for (const bad of [undefined, '', '-1', '1.5', 5000]) {
        const degraded = parseBalance({ ...base, penalty_input_threshold: bad, penalty_multiplier: bad });
        assert.equal(degraded.ok, true);
        assert.equal(degraded.value.penalty_input_threshold, null);
        assert.equal(degraded.value.penalty_multiplier, null);
        assert.deepEqual(balanceRows(degraded.value).penalty, { threshold: null, multiplier: null });
    }

    const invalidBase = [
        { ...base, permanent_balance: 1 },
        { ...base, debt: '1' },
        { ...base, daily_quota: '-1.000000' },
        { ...base, quota_date: '2026-02-30' },
        { ...base, needs_refresh: 'false' },
        { ...base, observed_at: 'not-a-date' },
        {},
    ];
    for (const payload of invalidBase) {
        assert.equal(parseBalance(payload).ok, false);
    }
});

test('penaltyBand uses exact BigInt math for string H and 90%/100% bands', async () => {
    const { penaltyBand } = await loadLogic();
    assert.equal(penaltyBand(0, '1000'), null);
    assert.equal(penaltyBand(-1, '1000'), null);
    assert.equal(penaltyBand(899, '1000'), 'ok');
    assert.equal(penaltyBand(900, '1000'), 'warn');
    assert.equal(penaltyBand(900, '999'), 'warn');
    assert.equal(penaltyBand(999, '1000'), 'warn');
    assert.equal(penaltyBand(1000, '1000'), 'danger');
    assert.equal(penaltyBand(1001, '1000'), 'danger');
    assert.equal(penaltyBand(1000, 1000), 'danger');
    assert.equal(penaltyBand(900, 1000), 'warn');
    assert.equal(penaltyBand(899, 1000), 'ok');
    // 超过 JS Number 精度的大 H：BigInt 比较不丢位。
    assert.equal(penaltyBand(9007199254740993, '9007199254740992'), 'danger');
    assert.equal(penaltyBand(1, '0'), null);
    for (const bad of [undefined, null, '', '-1', '1.5', 0, -1, 1.5]) {
        assert.equal(penaltyBand(100, bad), null, String(bad));
    }
});

test('contextMeterView keeps unknown sides null and max=0 unratioed', async () => {
    const { contextMeterView } = await loadLogic();
    assert.deepEqual(contextMeterView(10, 100), { used: 10, max: 100, ratio: 0.1 });
    assert.deepEqual(contextMeterView(0, 100), { used: 0, max: 100, ratio: 0 });
    assert.deepEqual(contextMeterView(null, 100), { used: null, max: 100, ratio: null });
    assert.deepEqual(contextMeterView(10, null), { used: 10, max: null, ratio: null });
    assert.deepEqual(contextMeterView(10, 0), { used: 10, max: 0, ratio: null });
    assert.deepEqual(contextMeterView(-1, 100), { used: null, max: 100, ratio: null });
    assert.deepEqual(contextMeterView('10', 100), { used: null, max: 100, ratio: null });
});

test('joinMessageText only joins strings from the requested field', async () => {
    const { joinMessageText } = await loadLogic();
    assert.equal(joinMessageText([{ content: 'a' }, { content: 'b' }], 'content'), 'a\nb');
    assert.equal(joinMessageText([{ mes: 'one' }, { mes: '' }, { mes: 42 }, null], 'mes'), 'one');
    assert.equal(joinMessageText([], 'content'), null);
    assert.equal(joinMessageText(null, 'content'), null);
    assert.equal(joinMessageText([{ other: 'x' }], 'content'), null);
    assert.equal(joinMessageText([{ content: 'a' }], ''), null);
    assert.equal(joinMessageText('not-an-array', 'content'), null);
});

test('model choices: chat face selectable only when authorized, no defaults invented', async () => {
    const {
        normalizeModelChoice,
        classifyModelChoices,
        isModelSelectable,
    } = await loadLogic();

    const chat = { name: 'model-a', protocol_faces: ['chat', 'anthropic'], extra: 'drop' };
    const normalized = normalizeModelChoice(chat);
    assert.deepEqual(normalized, { name: 'model-a', protocol_faces: ['chat', 'anthropic'] });
    assert.equal(Object.hasOwn(normalized, 'extra'), false);
    assert.equal(isModelSelectable(chat, true), true);
    assert.equal(isModelSelectable(chat, false), false);
    assert.equal(isModelSelectable({ name: 'responses-only', protocol_faces: ['responses'] }, true), false);
    assert.equal(isModelSelectable({ name: 'x', protocol_faces: [] }, true), false);
    assert.equal(isModelSelectable({ name: '', protocol_faces: ['chat'] }, true), false);
    assert.equal(isModelSelectable(null, true), false);
    assert.equal(isModelSelectable({ name: 'x', protocol_faces: ['chat'], modality: 'audio' }, true), false);

    const catalog = classifyModelChoices({
        items: [
            chat,
            { name: 'image', protocol_faces: ['image'], modality: 'image' },
            { name: '', protocol_faces: ['chat'] },
            null,
        ],
    });
    assert.equal(catalog.ok, true);
    assert.equal(catalog.items.length, 2);
    assert.equal(catalog.invalidCount, 2);
    assert.equal(classifyModelChoices(null).ok, false);
    assert.equal(classifyModelChoices({}).ok, false);
    assert.equal(classifyModelChoices({ items: 'nope' }).ok, false);
});

test('promptBudgetFromSettings matches ST 1.17 context - max_tokens (U2)', async () => {
    const { promptBudgetFromSettings } = await loadLogic();
    assert.equal(promptBudgetFromSettings({ openai_max_context: 131072, openai_max_tokens: 4096 }), 126976);
    assert.equal(promptBudgetFromSettings({ openai_max_context: 8192, openai_max_tokens: 4096 }), 4096);
    assert.equal(promptBudgetFromSettings({ openai_max_context: 4096, openai_max_tokens: 4096 }), null);
    assert.equal(promptBudgetFromSettings({ openai_max_context: 4096, openai_max_tokens: 8192 }), null);
    for (const value of [null, {}, { openai_max_context: 4096 }, { openai_max_tokens: 100 },
        { openai_max_context: 0, openai_max_tokens: 0 },
        { openai_max_context: '4096', openai_max_tokens: 100 },
        { openai_max_context: 4096, openai_max_tokens: -1 },
        { openai_max_context: 4096.5, openai_max_tokens: 100 }]) {
        assert.equal(promptBudgetFromSettings(value), null, JSON.stringify(value));
    }
});

test('maxTokensFitsBudget refuses values that would leave a non-positive prompt budget (U3)', async () => {
    const { maxTokensFitsBudget } = await loadLogic();
    assert.equal(maxTokensFitsBudget(4400, 126976), true);
    assert.equal(maxTokensFitsBudget(4400, 4096), false);
    assert.equal(maxTokensFitsBudget(4096, 4096), false);
    assert.equal(maxTokensFitsBudget(4095, 4096), true);
    assert.equal(maxTokensFitsBudget(4400, null), false); // 预算未知：fail-closed
    assert.equal(maxTokensFitsBudget(4400, undefined), false);
    assert.equal(maxTokensFitsBudget(4400, 0), false);
    assert.equal(maxTokensFitsBudget(4400, -1), false);
    for (const floor of [0, -1, 1.5, '4400', null]) {
        assert.equal(maxTokensFitsBudget(floor, 126976), false, String(floor));
    }
});

test('stConnectionState follows ST onlineStatus: no_connection only disconnected, non-empty strings connected (S11/F7)', async () => {
    const { stConnectionState } = await loadLogic();
    assert.equal(stConnectionState('connected'), 'connected');
    // ST 1.17.0 script.js:4304: online_status !== 'no_connection' 即视为有后端连接；
    // 状态值常是模型名或提示文案，不能只认字面 'connected'。
    for (const value of ['OpenAI', 'Connected', 'connecting', 'disconnected', 'offline', 'connected ']) {
        assert.equal(stConnectionState(value), 'connected', value);
    }
    assert.equal(stConnectionState('no_connection'), 'disconnected');
    for (const value of [undefined, null, '', 1, {}, []]) {
        assert.equal(stConnectionState(value), 'unknown', String(value));
    }
});

test('keyListView renders masked rows and rejects plaintext-bearing payloads', async () => {
    const { keyListView } = await loadLogic();
    const view = keyListView({
        keys: [
            { id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled', note: 'drop' },
            { id: 'second', name: '备用', masked: '****9b1c', status: 'enabled' },
        ],
    });
    assert.equal(view.ok, true);
    assert.equal(view.currentId, 'default');
    assert.equal(view.keys[0].current, true);
    assert.equal(view.keys[1].current, false);
    assert.deepEqual(Object.keys(view.keys[0]).sort(), ['current', 'id', 'masked', 'name', 'status']);
    assert.equal(JSON.stringify(view).includes('note'), false);

    for (const plaintext of ['key', 'secret', 'plaintext']) {
        const rejected = keyListView({
            keys: [{ id: 'default', name: 'n', masked: 'm', status: 'enabled', [plaintext]: 'agw_leak' }],
        });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.reason, 'keys_plaintext_rejected');
    }
    for (const bad of [
        null,
        {},
        { keys: 'nope' },
        { keys: [null] },
        { keys: [{ id: '', name: 'n', masked: 'm', status: 'enabled' }] },
        { keys: [{ id: 'd', name: '', masked: 'm', status: 'enabled' }] },
        { keys: [{ id: 'd', name: 'n', masked: '', status: 'enabled' }] },
        { keys: [{ id: 'd', name: 'n', masked: 'm', status: '' }] },
        { keys: [{ id: 'd', name: 'n', masked: 'm', status: 'a\nb' }] },
    ]) {
        assert.equal(keyListView(bad).ok, false);
    }
});

test('shouldRollbackApplyModel only rolls back on definite server rejection (F10)', async () => {
    const { shouldRollbackApplyModel } = await loadLogic();
    for (const status of [400, 401, 403, 409, 422, 429]) {
        assert.equal(shouldRollbackApplyModel(status, 'whatever'), true, String(status));
    }
    assert.equal(shouldRollbackApplyModel(502, 'custom_source_write_failed'), true);
    // 网络不确定/超时（status 0）与其它 5xx：保留网关 URL。
    assert.equal(shouldRollbackApplyModel(0, 'timeout'), false);
    assert.equal(shouldRollbackApplyModel(0, 'network_error'), false);
    assert.equal(shouldRollbackApplyModel(500, 'internal_error'), false);
    assert.equal(shouldRollbackApplyModel(502, 'upstream_unavailable'), false);
    assert.equal(shouldRollbackApplyModel(null, 'custom_source_write_failed'), false);
});

test('isNonGatewayCustomUrl strictly matches the gateway target (G3/F11/I1)', async () => {
    const { isNonGatewayCustomUrl } = await loadLogic();
    // 只有 https + api.apercus.ai + 默认端口 + 无 userinfo 才算网关。
    assert.equal(isNonGatewayCustomUrl('https://api.apercus.ai/v1'), false);
    assert.equal(isNonGatewayCustomUrl('https://api.apercus.ai:443/v1'), false);
    // http / 非默认端口 / userinfo 都视为非网关 → 触发清理。
    assert.equal(isNonGatewayCustomUrl('http://api.apercus.ai/v1'), true);
    assert.equal(isNonGatewayCustomUrl('https://api.apercus.ai:8443/v1'), true);
    assert.equal(isNonGatewayCustomUrl('https://user:pass@api.apercus.ai/v1'), true);
    assert.equal(isNonGatewayCustomUrl('https://api.apercus.ai.evil.example/v1'), true);
    assert.equal(isNonGatewayCustomUrl('http://third.example/v1'), true);
    assert.equal(isNonGatewayCustomUrl('https://user:pass@third.example/v1'), true);
    for (const value of ['', null, undefined]) {
        assert.equal(isNonGatewayCustomUrl(value), false, String(value));
    }
    // J3：已定义非空但无法被 URL 解析的字符串（相对/畸形形态）无法证明是
    // 网关目标 → 按非网关 fail-safe 触发清理，而不是静默跳过。
    for (const value of ['not a url', '//attacker.example/v1', '\\\\host', '///host']) {
        assert.equal(isNonGatewayCustomUrl(value), true, JSON.stringify(value));
    }
    // I1：已定义且非 string 的 custom_url 无法证明是网关 → 一律按非网关触发清理。
    for (const value of [
        42,
        0,
        true,
        ['https://api.apercus.ai/v1'],
        { url: 'https://api.apercus.ai/v1' },
        ['https://third.example/v1'],
    ]) {
        assert.equal(isNonGatewayCustomUrl(value), true, String(value));
    }
});

test('H1: pendingPresetCustomUrl follows ST preset application semantics', async () => {
    const { pendingPresetCustomUrl } = await loadLogic();
    const current = 'https://api.apercus.ai/v1';
    const map = { custom_url: ['#custom_api_url_text', 'custom_url', false, true] };
    // 绑定连接（默认 true）且预设含 custom_url → 即将应用该 URL。
    assert.equal(pendingPresetCustomUrl({
        preset: { custom_url: 'https://third.example/v1' },
        settings: { bind_preset_to_connection: true },
        settingsToUpdate: map,
    }, current), 'https://third.example/v1');
    // 未绑定连接：连接类字段不应用 → 保持当前 URL。
    assert.equal(pendingPresetCustomUrl({
        preset: { custom_url: 'https://third.example/v1' },
        settings: { bind_preset_to_connection: false },
        settingsToUpdate: map,
    }, current), current);
    // settingsToUpdate 明确不含 custom_url → 不应用。
    assert.equal(pendingPresetCustomUrl({
        preset: { custom_url: 'https://third.example/v1' },
        settings: { bind_preset_to_connection: true },
        settingsToUpdate: { temperature: [] },
    }, current), current);
    // 预设没有 custom_url / 非法 payload → 保持当前 URL。
    assert.equal(pendingPresetCustomUrl({ preset: {}, settings: {} }, current), current);
    assert.equal(pendingPresetCustomUrl(null, current), current);
    // I1：已定义非空的非字符串值返回原值（不再回退 currentUrl 丢掉攻击面）。
    const arrayUrl = ['https://third.example/v1'];
    const objectUrl = { url: 'https://third.example/v1' };
    assert.equal(pendingPresetCustomUrl({ preset: { custom_url: 42 } }, current), 42);
    assert.equal(pendingPresetCustomUrl({ preset: { custom_url: arrayUrl } }, current), arrayUrl);
    assert.equal(pendingPresetCustomUrl({ preset: { custom_url: objectUrl } }, current), objectUrl);
    // 仍尊重 bind_preset_to_connection=false（ST 不会应用该字段）。
    assert.equal(pendingPresetCustomUrl({
        preset: { custom_url: arrayUrl },
        settings: { bind_preset_to_connection: false },
    }, current), current);
    // 显式空值（'' / null / undefined）仍回退 currentUrl。
    for (const empty of ['', null, undefined]) {
        assert.equal(pendingPresetCustomUrl({ preset: { custom_url: empty } }, current), current);
    }
});
