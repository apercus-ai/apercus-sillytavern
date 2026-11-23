'use strict';

// ui/index.js 的轻量集成测试（评审 J）：不引入 jsdom，用纯对象 DOM/ctx/fetch
// stub 驱动真实模块。ui/index.js 是 ESM 且依赖 ST 的 extensions.js，测试在
// 导入前把两处 import 替换为：全局 stub getContext + 绝对路径 logic.mjs，
// 再通过 data: URL 动态导入；模块末尾追加内部函数导出（仅测试用）。
//
// 覆盖：活动设置优先级、两次调用顺序、F1 自动重分层、三道闸与旧键清理、
// 守卫首次 toast、max_tokens 一键应用、生成失败无回退名单。

const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROUTE = '/api/plugins/apercus-gateway';
const SECTIONS_TEXT = '{"sections":["开场","收束"]}';
const LAYERS_TEXT = '{"layers":{"0":"structural","1":"content","2":"structural"}}';

let mod = null;
let ctx = null;
let toastr = null;
let planCalls = [];
let planQueue = [];
let applyCalls = [];
let releaseCalls = [];
let queryFixtures = null;
let saveCount = 0;
let saveEvents = [];
let saveFail = false;
let statusCalls = 0;
let keysCalls = 0;
let modelsCalls = 0;
let balanceCalls = 0;
let connectStatusCalls = 0;
let connectStatusQueue = [];
let fetchEvents = [];
let openCalls = [];
let orderLog = [];
let logoutCalls = 0;
let selectedName = 'Preset A';
let savedPreset = null;
let defaultNativeSave = null;

// ---------- 最小 DOM stub ----------

function makeClassList(el) {
    return {
        add(...names) { for (const name of names) el._classes.add(name); },
        remove(...names) { for (const name of names) el._classes.delete(name); },
        contains(name) { return el._classes.has(name); },
        toggle(name, force) {
            const next = force === undefined ? !el._classes.has(name) : !!force;
            if (next) el._classes.add(name); else el._classes.delete(name);
            return next;
        },
    };
}

function makeElement(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        _classes: new Set(),
        children: [],
        listeners: Object.create(null),
        attributes: Object.create(null),
        parentElement: null,
        className: '',
        textContent: '',
        id: '',
        title: '',
        type: '',
        value: '',
        checked: false,
        hidden: false,
        disabled: false,
        open: false,
        style: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
        append(...nodes) { for (const node of nodes) this.appendChild(node); },
        appendChild(node) { this.children.push(node); node.parentElement = this; return node; },
        removeChild(node) {
            const index = this.children.indexOf(node);
            if (index >= 0) this.children.splice(index, 1);
            node.parentElement = null;
            return node;
        },
        insertBefore(node, reference) {
            const index = reference ? this.children.indexOf(reference) : -1;
            this.children.splice(index < 0 ? this.children.length : index, 0, node);
            node.parentElement = this;
            return node;
        },
        get firstChild() { return this.children[0] || null; },
        addEventListener(type, handler) {
            if (!this.listeners[type]) this.listeners[type] = [];
            this.listeners[type].push(handler);
        },
        removeEventListener() {},
        click() { for (const handler of this.listeners.click || []) handler({ target: this }); },
        querySelector() { return null; },
        scrollIntoView() {},
        focus() {},
        showModal() { this.open = true; },
        close() { this.open = false; },
    };
    el.classList = makeClassList(el);
    return el;
}

function installDom() {
    const body = makeElement('body');
    const settingsRoot = makeElement('div');
    // ST 原生 Custom 面板的两个展示控件（W5 同步目标）。
    const nativeInputs = {
        custom_api_url_text: makeElement('input'),
        custom_model_id: makeElement('input'),
    };
    const documentStub = {
        readyState: 'loading',
        body,
        nativeInputs,
        createElement(tag) { return makeElement(tag); },
        getElementById(id) {
            if (id === 'extensions_settings' || id === 'extensions_settings2') return settingsRoot;
            if (Object.hasOwn(nativeInputs, id)) return nativeInputs[id];
            return null;
        },
        querySelector() { return null; },
        addEventListener() {},
    };
    globalThis.document = documentStub;
    return documentStub;
}

function installWindow() {
    toastr = {
        info(message, title, options) { toastr.messages.push({ kind: 'info', message, title, options }); },
        success(message, title, options) { toastr.messages.push({ kind: 'success', message, title, options }); },
        warning(message, title, options) { toastr.messages.push({ kind: 'warning', message, title, options }); },
        error(message, title, options) { toastr.messages.push({ kind: 'error', message, title, options }); },
        messages: [],
    };
    globalThis.window = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: (handler, ms) => {
            const id = setInterval(handler, ms);
            if (typeof id.unref === 'function') id.unref();
            return id;
        },
        clearInterval: globalThis.clearInterval,
        addEventListener() {},
        open(url) {
            openCalls.push(url);
            return {
                opener: null,
                location: { href: '' },
                close() { this.closed = true; },
            };
        },
        toastr,
    };
}

// ---------- fetch / ctx stubs ----------

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

function statusPayload() {
    return {
        authAvailable: false,
        connected: false,
        code: 'authorized',
        message: '已授权（已授权不等于已连接）。',
        protocols: { chat: false, anthropic: false, responses: false },
        state: 'authorized',
        username: 'alice',
        connect_pending: false,
        st_connection: { state: 'unknown' },
    };
}

function defaultQueryFixtures() {
    return {
        status: statusPayload(),
        keys: {
            keys: [{ id: 'default', name: '默认 key', masked: '****7x2a', status: 'enabled' }],
        },
        models: {
            items: [
                { name: 'model-a', protocol_faces: ['chat'] },
                { name: 'model-b', protocol_faces: ['responses'] },
            ],
        },
        balance: {
            permanent_balance: '1.000000',
            debt: '0.000000',
            daily_quota: '5.000000',
            daily_quota_used: '2.500000',
            daily_quota_remaining: '2.500000',
            quota_date: '2026-11-23',
            needs_refresh: false,
            observed_at: '2026-11-23T00:00:00Z',
            penalty_input_threshold: '1000',
            penalty_multiplier: '1000',
        },
        apply: { status: 'applied', model: 'model-a' },
        applyStatus: 200,
        logout: { status: 'logged_out', remote_revoked: true, local_cleared: true },
        logoutStatus: 200,
        connect: { status: 'pending', authorize_url: 'https://gw.apercus.ai/portal/connect' },
        connectStatusValue: { status: 'pending' },
    };
}

function jsonError(status, code, message) {
    return jsonResponse(status, { error: { code, message } });
}

async function fetchImpl(url, options) {
    const target = String(url);
    if (target === `${ROUTE}/status`) {
        statusCalls += 1;
        fetchEvents.push('/status');
        return jsonResponse(200, queryFixtures.status || statusPayload());
    }
    if (target === `${ROUTE}/connect`) {
        orderLog.push('/connect');
        fetchEvents.push('/connect');
        return jsonResponse(queryFixtures.connectStatus === undefined ? 200 : queryFixtures.connectStatus,
            queryFixtures.connect || { status: 'pending', authorize_url: 'https://gw.apercus.ai/portal/connect' });
    }
    if (target === `${ROUTE}/connect/status`) {
        connectStatusCalls += 1;
        fetchEvents.push('/connect/status');
        const next = connectStatusQueue.shift();
        if (next) return jsonResponse(200, next);
        return jsonResponse(200, queryFixtures.connectStatusValue || { status: 'pending' });
    }
    if (target === `${ROUTE}/keys`) {
        keysCalls += 1;
        fetchEvents.push('/keys');
        if (queryFixtures.keysDeferred) {
            const deferred = queryFixtures.keysDeferred.shift();
            if (deferred) {
                await deferred.promise;
                return jsonResponse(200, deferred.value);
            }
        }
        return jsonResponse(200, queryFixtures.keys);
    }
    if (target === `${ROUTE}/models`) {
        modelsCalls += 1;
        fetchEvents.push('/models');
        return jsonResponse(200, queryFixtures.models);
    }
    if (target === `${ROUTE}/balance`) {
        balanceCalls += 1;
        fetchEvents.push('/balance');
        if (queryFixtures.balanceError) {
            return jsonError(queryFixtures.balanceError.status || 502, queryFixtures.balanceError.code || 'upstream_unavailable', queryFixtures.balanceError.message || '额度失败');
        }
        return jsonResponse(200, queryFixtures.balance);
    }
    if (target === `${ROUTE}/apply-model`) {
        orderLog.push('/apply-model');
        if (queryFixtures.applyNetworkError) {
            throw new TypeError('network down');
        }
        applyCalls.push(JSON.parse(options.body));
        // I3：测试可在响应前挂起（模拟“等待服务端期间用户切预设”）。
        // W4：多次 apply 需要各自闸门时用队列，先发者可以后回。
        if (queryFixtures.applyGateQueue && queryFixtures.applyGateQueue.length > 0) {
            await queryFixtures.applyGateQueue.shift().promise;
        } else if (queryFixtures.applyDeferred) await queryFixtures.applyDeferred;
        return jsonResponse(queryFixtures.applyStatus, queryFixtures.apply);
    }
    if (target === `${ROUTE}/release-custom-key`) {
        orderLog.push('/release-start');
        if (queryFixtures.releaseDeferred) await queryFixtures.releaseDeferred;
        releaseCalls.push(JSON.parse(options.body));
        orderLog.push('/release-done');
        return jsonResponse(queryFixtures.releaseStatus || 200, queryFixtures.release || { cleared: true });
    }
    if (target === `${ROUTE}/logout`) {
        logoutCalls += 1;
        return jsonResponse(queryFixtures.logoutStatus, queryFixtures.logout);
    }
    if (target === `${ROUTE}/plan`) {
        planCalls.push(JSON.parse(options.body));
        const next = planQueue.shift();
        if (!next) {
            return jsonResponse(500, { error: { code: 'no_plan_script', message: '测试未预置 plan 响应' } });
        }
        if (next.fail) {
            return jsonResponse(next.status || 502, {
                error: { code: next.code || 'upstream_unavailable', message: next.message || '失败' },
            });
        }
        return jsonResponse(200, { text: next.text });
    }
    throw new Error(`unexpected fetch: ${target}`);
}

function makePreset() {
    return {
        prompts: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'main-content' },
            { identifier: 'style', name: 'Style', role: 'system', content: 'style-content' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
        ],
        prompt_order: [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'style', enabled: true },
                { identifier: 'chatHistory', enabled: true },
            ],
        }],
    };
}

function makeSettings() {
    return {
        chat_completion_source: 'custom',
        custom_url: 'https://api.apercus.ai/v1',
        custom_model: 'model-a',
        openai_max_tokens: 100,
        custom_include_body: '',
        ...makePreset(),
    };
}

function makeCtx() {
    const listeners = Object.create(null);
    const context = {
        event_types: {
            PRESET_CHANGED: 'preset_changed',
            OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            GENERATE_AFTER_DATA: 'generate_after_data',
            ONLINE_STATUS_CHANGED: 'online_status_changed',
            SETTINGS_UPDATED: 'settings_updated',
        },
        eventSource: {
            on(event, handler) {
                if (!listeners[event]) listeners[event] = [];
                listeners[event].push(handler);
            },
        },
        chatCompletionSettings: makeSettings(),
        extensionSettings: {},
        chat: [],
        maxContext: 4096,
        getTokenCountAsync: async (text) => (typeof text === 'string' ? text.length : 0),
        getPresetManager() {
            return {
                getSelectedPresetName() { return selectedName; },
                getCompletionPresetByName() { return savedPreset; },
            };
        },
        getRequestHeaders() { return { 'X-Test': '1' }; },
        saveSettingsDebounced() { saveCount += 1; },
        _listeners: listeners,
    };
    return context;
}

// ---------- 模块载入 ----------

let moduleInstance = 0;

async function loadUiModule() {
    moduleInstance += 1;
    const source = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.js'), 'utf8');
    const logicUrl = pathToFileURL(path.join(__dirname, '..', 'ui', 'logic.mjs')).href;
    const importLine = "import { getContext } from '../../../extensions.js';";
    const logicLine = "import * as L from './logic.mjs';";
    const saveLine = "import { saveSettings as nativeSaveSettings } from '../../../../script.js';";
    assert.equal(source.includes(importLine), true, 'getContext import line changed');
    assert.equal(source.includes(logicLine), true, 'logic import line changed');
    assert.equal(source.includes(saveLine), true, 'script.js saveSettings import line changed');
    const transformed = source
        .replace(importLine, 'const getContext = () => globalThis.__AG_TEST_GET_CONTEXT__();')
        .replace(saveLine, 'const nativeSaveSettings = globalThis.__AG_TEST_NATIVE_SAVE_SETTINGS__;')
        .replace(logicLine, `import * as L from ${JSON.stringify(logicUrl)};`)
        + '\nexport { init, injectAntitrunc, onChatCompletionSettingsReady, evaluateAntitrunc, '
        + 'generateSections, applySuggestedMaxTokens, onAntitruncToggleChange, onPresetChanged, '
        + 'readSelectedPreset, resetAntitruncView, antitrunc, state, els, '
        + 'refreshKeys, refreshModels, refreshBalance, renderKeys, renderModels, renderBalance, '
        + 'renderContextMeter, estimateContextMeter, onGenerateAfterData, openModelDialog, '
        + 'applyModelSelection, modelDialog, modelDialogLine, modelDialogSourceLine, '
        + 'modelDialogConfirm, modelDialogCancel, renderStatus, doLogout, doConnect, '
        + 'readContextLimit, switchToCustomSource, refreshStatus, persistSettings, '
        + 'cleanupCustomKey, stopStatusRefresh, stopConnectPolling, openPanel, '
        + 'pollConnectOnce, cleanupTimers };\n'
        // data: URL 模块缓存按 URL 缓存；追加实例注释让每次加载都是新模块。
        + `\n// test-instance-${moduleInstance}\n`;
    const url = `data:text/javascript;base64,${Buffer.from(transformed, 'utf8').toString('base64')}`;
    return import(url);
}

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
    for (let index = 0; index < 6; index += 1) {
        await tick();
    }
}

// ---------- 测试辅助 ----------

function resetAll() {
    mod.stopStatusRefresh();
    mod.stopConnectPolling();
    ctx.chatCompletionSettings = makeSettings();
    ctx.extensionSettings = {};
    ctx.chat = [];
    ctx.maxContext = 4096;
    selectedName = 'Preset A';
    savedPreset = makeSettings();
    planCalls = [];
    planQueue = [];
    applyCalls = [];
    releaseCalls = [];
    queryFixtures = defaultQueryFixtures();
    saveCount = 0;
    saveEvents = [];
    saveFail = false;
    statusCalls = 0;
    keysCalls = 0;
    modelsCalls = 0;
    balanceCalls = 0;
    connectStatusCalls = 0;
    connectStatusQueue = [];
    fetchEvents = [];
    openCalls = [];
    orderLog = [];
    logoutCalls = 0;
    toastr.messages.length = 0;
    delete ctx.onlineStatus;
    // I7：恢复原生 saveSettings 绑定（个别测试会临时置 null 加载降级实例）。
    globalThis.__AG_TEST_NATIVE_SAVE_SETTINGS__ = defaultNativeSave;
    delete queryFixtures.applyDeferred;
    delete queryFixtures.applyGateQueue;
    delete queryFixtures.saveGate;
    mod.state.keys = null;
    mod.state.keysError = null;
    mod.state.models = null;
    mod.state.modelsError = null;
    mod.state.balance = null;
    mod.state.balanceError = null;
    mod.state.contextMeter = { used: null, max: null };
    mod.state.authIdentity = null;
    mod.state.connectPending = false;
    mod.state.connectError = null;
    mod.state.connectStatus = null;
    // 递增而非归零：让上一测试遗留的在途请求成为旧世代。
    mod.state.authGeneration += 1;
    mod.state.wasAuthorized = false;
    mod.antitrunc.enabled = false;
    mod.antitrunc.lastInjectedBody = null;
    mod.antitrunc.guardBlocked = false;
    mod.antitrunc.guardReason = null;
    mod.antitrunc.guardToastShown = false;
    mod.antitrunc.generationFailed = false;
    mod.antitrunc.floorToastValue = null;
    mod.antitrunc.customKeyPresent = null;
    mod.antitrunc.cleanupInFlight = false;
    mod.antitrunc.cleanupPromise = null;
    mod.antitrunc.cleanupAttemptUrl = null;
    mod.antitrunc.cleanupAttemptAt = 0;
    mod.els.antitruncToggle.checked = false;
    mod.els.antitruncNote.hidden = true;
    mod.els.antitruncNote.textContent = '';
    mod.resetAntitruncView();
}

async function enableAntitrunc() {
    mod.els.antitruncToggle.checked = true;
    mod.onAntitruncToggleChange();
    await settle();
}

async function generate() {
    planQueue.push({ text: SECTIONS_TEXT });
    planQueue.push({ text: LAYERS_TEXT });
    await mod.generateSections();
    await settle();
}

function makeGenerateData(overrides) {
    return {
        model: 'model-a',
        chat_completion_source: 'custom',
        custom_url: ctx.chatCompletionSettings.custom_url,
        messages: [{ role: 'user', content: 'hi' }],
        custom_include_body: '',
        max_tokens: 10000,
        ...(overrides || {}),
    };
}

async function inject(data) {
    const result = mod.onChatCompletionSettingsReady(data);
    if (result && typeof result.then === 'function') await result;
    await settle();
    return data;
}

function cachedEntries() {
    const ns = ctx.extensionSettings.apercusGateway;
    return ns && ns.sectionsCache ? ns.sectionsCache : null;
}

function lastToast(kind) {
    const filtered = toastr.messages.filter((item) => item.kind === kind);
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

before(async () => {
    installDom();
    installWindow();
    globalThis.fetch = fetchImpl;
    ctx = makeCtx();
    queryFixtures = defaultQueryFixtures();
    globalThis.__AG_TEST_GET_CONTEXT__ = () => ctx;
    // ST 1.17.0 saveSettings 的真实成功信号：await 的 SETTINGS_UPDATED 事件。
    const nativeSave = async () => {
        saveEvents.push('save');
        orderLog.push('/save-settings');
        saveCount += 1;
        if (queryFixtures.saveGate) await queryFixtures.saveGate;
        if (saveFail) return; // 模拟真实的静默失败：不 emit SETTINGS_UPDATED。
        for (const handler of ctx._listeners.settings_updated || []) handler();
    };
    // I7：模块加载时把该函数捕获为 `nativeSaveSettings`；置 null 可模拟
    // “无 saveSettings 的降级宿主”（新加载的模块实例走 debounce 路径）。
    globalThis.__AG_TEST_NATIVE_SAVE_SETTINGS__ = nativeSave;
    defaultNativeSave = nativeSave;
    mod = await loadUiModule();
    mod.init();
    await settle();
    assert.equal(mod.state.status && mod.state.status.ok, true);
});

test('panel is mounted as an ST inline-drawer with a collapsible header', () => {
    assert.ok(mod.els.drawer);
    assert.ok(mod.els.drawer.className.includes('inline-drawer'));
    assert.ok(mod.els.headerToggle.className.includes('inline-drawer-toggle'));
    assert.equal(mod.els.headerToggle.getAttribute('aria-expanded'), 'false');
    assert.ok(mod.els.drawerIcon.className.includes('inline-drawer-icon'));
    assert.ok(mod.els.panel.className.includes('inline-drawer-content'));
    assert.equal(mod.els.panel.parentElement, mod.els.drawer);
    assert.equal(mod.els.drawer.children[0], mod.els.headerToggle);
});

// ---------- A：活动设置优先 ----------

test('readSelectedPreset prefers live chatCompletionSettings over the saved preset copy', () => {
    resetAll();
    const active = ctx.chatCompletionSettings;
    assert.notEqual(savedPreset, active);
    const selected = mod.readSelectedPreset();
    assert.equal(selected.name, 'Preset A');
    assert.equal(selected.presetJson, active);

    // 活动设置形态不符 → 回退 getCompletionPresetByName 的保存副本。
    ctx.chatCompletionSettings = { custom_model: 'model-a' };
    const fallback = mod.readSelectedPreset();
    assert.equal(fallback.presetJson, savedPreset);
});

// ---------- 两次调用顺序 + 缓存 ----------

test('generation runs call one (sections) then call two (layers) and stores the preset cache', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();

    assert.equal(planCalls.length, 2);
    assert.ok(planCalls[0].prompt.startsWith('你是分节配置器。'));
    assert.ok(planCalls[0].prompt.includes('main-content'));
    assert.ok(planCalls[0].prompt.includes('"sections"'));
    assert.ok(planCalls[1].prompt.startsWith('你是分类器。'));
    assert.ok(planCalls[1].prompt.includes('[0] Main：main-content'));
    assert.ok(planCalls[1].prompt.includes('[2] Chat History：'));
    assert.equal(planCalls[0].model, 'model-a');
    assert.equal(planCalls[1].model, 'model-a');

    assert.deepEqual(mod.antitrunc.sections, ['开场', '收束']);
    assert.equal(mod.antitrunc.cacheHit, true);
    assert.equal(mod.antitrunc.fingerprintExpired, false);

    const cache = cachedEntries();
    const keys = Object.keys(cache);
    assert.equal(keys.length, 1);
    const entry = cache[keys[0]];
    assert.deepEqual(entry.sections, ['开场', '收束']);
    assert.equal(entry.presetName, 'Preset A');
    assert.equal(entry.layeredFingerprint, mod.antitrunc.layeredFingerprint);
    assert.equal(typeof entry.lastUsedAt, 'number');
});

// ---------- F1：内容层自动重分层、结构层转过期 ----------

test('F1: content-layer edits rerun call two without changing sections; structural edits expire', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    const structuralBefore = mod.antitrunc.structuralFingerprint;
    const sectionsBefore = mod.antitrunc.sections.slice();
    planCalls = [];

    // 纯文风（content 层）改动 → 只重跑调用二，名单仍有效。
    const style = ctx.chatCompletionSettings.prompts.find((item) => item.identifier === 'style');
    style.content = 'style-content-edited';
    planQueue.push({ text: LAYERS_TEXT });
    await mod.evaluateAntitrunc({ allowLayerRerun: true });
    await settle();

    assert.equal(planCalls.length, 1);
    assert.ok(planCalls[0].prompt.startsWith('你是分类器。'));
    assert.equal(planCalls[0].prompt.includes('你是分节配置器。'), false);
    assert.equal(mod.antitrunc.structuralFingerprint, structuralBefore);
    assert.deepEqual(mod.antitrunc.sections, sectionsBefore);
    assert.equal(mod.antitrunc.cacheHit, true);
    planCalls = [];

    // 结构层条目改动 → 指纹变化、面板转“过期”、注入暂停。
    const main = ctx.chatCompletionSettings.prompts.find((item) => item.identifier === 'main');
    main.content = 'main-content-edited';
    planQueue.push({ text: LAYERS_TEXT });
    await mod.evaluateAntitrunc({ allowLayerRerun: true });
    await settle();

    assert.equal(planCalls.length, 1);
    assert.notEqual(mod.antitrunc.structuralFingerprint, structuralBefore);
    assert.equal(mod.antitrunc.cacheHit, false);
    assert.equal(mod.antitrunc.fingerprintExpired, true);
});

test('cache-hit race: a preset edit during evaluation is treated as expired, not valid', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    planCalls = [];

    // evaluateAntitrunc 同步读入 entries 后在指纹哈希处让出；此时改活动设置，
    // 命中缓存的分支必须用“当前预设”复核，不能把旧指纹当成有效。
    const pending = mod.evaluateAntitrunc({ allowLayerRerun: false });
    const style = ctx.chatCompletionSettings.prompts.find((item) => item.identifier === 'style');
    style.content = 'raced-style-edit';
    await pending;
    await settle();

    assert.equal(planCalls.length, 0);
    assert.equal(mod.antitrunc.cacheHit, false);
    assert.equal(mod.antitrunc.fingerprintExpired, true);
});

test('cache-hit branch rejects an entry whose structural key does not match current content', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    const cache = cachedEntries();
    const key = Object.keys(cache)[0];
    cache['wrong-structural-key'] = cache[key];
    delete cache[key];
    planCalls = [];

    await mod.evaluateAntitrunc({ allowLayerRerun: false });
    await settle();

    assert.equal(planCalls.length, 0);
    assert.equal(mod.antitrunc.cacheHit, false);
    assert.equal(mod.antitrunc.fingerprintExpired, true);
});

test('repeated structural edits keep only the newest 3 cache entries for the preset', async () => {
    resetAll();
    await enableAntitrunc();
    const structuralKeys = [];
    for (let index = 0; index < 4; index += 1) {
        const main = ctx.chatCompletionSettings.prompts.find((item) => item.identifier === 'main');
        main.content = `main-structural-edit-${index}`;
        planQueue.push({ text: SECTIONS_TEXT });
        planQueue.push({ text: LAYERS_TEXT });
        await mod.generateSections();
        await settle();
        structuralKeys.push(mod.antitrunc.structuralFingerprint);
    }
    const cache = cachedEntries();
    assert.equal(Object.keys(cache).length, 3);
    assert.equal(Object.hasOwn(cache, structuralKeys[0]), false);
    assert.equal(Object.hasOwn(cache, structuralKeys[1]), true);
    assert.equal(Object.hasOwn(cache, structuralKeys[3]), true);
});

test('expired cache: stale injected keys are cleaned before the injection is skipped', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    const injected = await inject(makeGenerateData());
    const body = injected.custom_include_body;
    assert.equal(typeof body, 'string');
    assert.ok(body.length > 0);

    // 结构层改动 → 缓存失效；携带上次 body 的生成应清理旧键并保持不注入。
    const main = ctx.chatCompletionSettings.prompts.find((item) => item.identifier === 'main');
    main.content = 'main-expired-edit';
    const data = await inject(makeGenerateData({ custom_include_body: body }));
    assert.equal(data.custom_include_body, '');
    assert.equal(mod.antitrunc.lastInjectedBody, null);
    assert.ok(mod.els.antitruncNote.textContent.includes('未生成或已过期'));
});

test('reordering prompt_order alone changes both fingerprints and expires the cache (U5)', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    const layeredBefore = mod.antitrunc.layeredFingerprint;
    const structuralBefore = mod.antitrunc.structuralFingerprint;
    assert.equal(typeof layeredBefore, 'string');
    assert.equal(typeof structuralBefore, 'string');
    planCalls = [];

    // 只拖动执行顺序，prompts 内容/启用状态完全不变。
    const order = ctx.chatCompletionSettings.prompt_order[0].order;
    ctx.chatCompletionSettings.prompt_order[0].order = [order[1], order[0], order[2]];
    planQueue.push({ text: LAYERS_TEXT });
    await mod.evaluateAntitrunc({ allowLayerRerun: true });
    await settle();

    assert.equal(planCalls.length, 1);
    assert.ok(planCalls[0].prompt.startsWith('你是分类器。'));
    assert.notEqual(mod.antitrunc.layeredFingerprint, layeredBefore);
    assert.notEqual(mod.antitrunc.structuralFingerprint, structuralBefore);
    assert.equal(mod.antitrunc.cacheHit, false);
    assert.equal(mod.antitrunc.fingerprintExpired, true);
    assert.ok(mod.els.antitruncState.textContent.includes('过期'));
});

// ---------- 守卫 + 清理 + toast ----------

test('injection writes both keys, cleans stale keys on toggle-off, and never touches user-edited bodies', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();

    const first = await inject(makeGenerateData());
    const firstBody = first.custom_include_body;
    const parsed = JSON.parse(firstBody);
    assert.equal(parsed.apercus_antitrunc, true);
    assert.deepEqual(parsed.apercus_antitrunc_sections, ['开场', '收束']);
    assert.equal(mod.antitrunc.lastInjectedBody, firstBody);

    // 开关关闭 + 当前 body 仍是插件上次写入的完整字符串 → 清空两键。
    mod.els.antitruncToggle.checked = false;
    mod.onAntitruncToggleChange();
    await settle();
    const off = await inject(makeGenerateData({ custom_include_body: firstBody }));
    assert.equal(off.custom_include_body, '');
    assert.equal(mod.antitrunc.lastInjectedBody, null);

    // 重新注入后，非网关目标也执行清理（早退路径）。
    mod.els.antitruncToggle.checked = true;
    mod.onAntitruncToggleChange();
    await settle();
    const second = await inject(makeGenerateData());
    const originalUrl = ctx.chatCompletionSettings.custom_url;
    ctx.chatCompletionSettings.custom_url = 'https://evil.example/v1';
    const nonGateway = await inject(makeGenerateData({
        custom_url: 'https://evil.example/v1',
        custom_include_body: second.custom_include_body,
    }));
    assert.equal(nonGateway.custom_include_body, '');
    assert.equal(mod.antitrunc.lastInjectedBody, null);
    ctx.chatCompletionSettings.custom_url = originalUrl;

    // 重新注入后，守卫触发同样先清理旧键。
    const third = await inject(makeGenerateData());
    const guarded = await inject(makeGenerateData({
        custom_include_body: third.custom_include_body,
        tools: [],
    }));
    assert.equal(guarded.custom_include_body, '');
    assert.equal(mod.antitrunc.guardReason, 'antitrunc_guard_tools');

    // 重新注入后，用户改过其他字段的 body 不匹配旧键 → 不触碰。
    await inject(makeGenerateData()); // 清除守卫态并写入新的 lastInjectedBody
    const fourth = await inject(makeGenerateData());
    const userEdited = JSON.stringify({
        temperature: 0.9,
        apercus_antitrunc: true,
        apercus_antitrunc_sections: ['开场', '收束'],
    });
    mod.els.antitruncToggle.checked = false;
    mod.onAntitruncToggleChange();
    await settle();
    const untouched = await inject(makeGenerateData({ custom_include_body: userEdited }));
    assert.equal(untouched.custom_include_body, userEdited);
    assert.equal(mod.antitrunc.lastInjectedBody, fourth.custom_include_body);
});

test('user-owned same-name keys with different values win over injection (U6)', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    await inject(makeGenerateData());

    const userBody = JSON.stringify({
        temperature: 0.9,
        apercus_antitrunc: true,
        apercus_antitrunc_sections: ['用户自己写的'],
    });
    const data = await inject(makeGenerateData({ custom_include_body: userBody }));
    assert.equal(data.custom_include_body, userBody);
    assert.equal(mod.els.antitruncNote.hidden, false);
    assert.ok(mod.els.antitruncNote.textContent.includes('用户内容优先'));
    assert.ok(mod.els.antitruncNote.textContent.includes('未注入'));
});

test('three gates: no injection when disconnected, non-gateway target, guard, or missing cache', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();

    // 非网关目标：安静跳过，body 不变。
    const originalUrl = ctx.chatCompletionSettings.custom_url;
    ctx.chatCompletionSettings.custom_url = 'https://evil.example/v1';
    const nonGateway = await inject(makeGenerateData({ custom_url: 'https://evil.example/v1' }));
    assert.equal(nonGateway.custom_include_body, '');
    ctx.chatCompletionSettings.custom_url = originalUrl;

    // 守卫：tools 触发，不写入，状态条按 reason 显示 tools。
    const guarded = await inject(makeGenerateData({ tools: [{ type: 'function' }] }));
    assert.equal(guarded.custom_include_body, '');
    assert.equal(mod.antitrunc.guardBlocked, true);
    assert.equal(mod.antitrunc.guardReason, 'antitrunc_guard_tools');
    assert.ok(mod.els.antitruncState.textContent.includes('tools'));
    assert.equal(mod.els.antitruncState.textContent.includes('函数调用开启'), false);

    // 守卫解除后，清单失效（无缓存）→ 不注入，也不写默认名单。
    ctx.extensionSettings = {};
    mod.resetAntitruncView();
    const missing = await inject(makeGenerateData());
    assert.equal(missing.custom_include_body, '');
    assert.equal(mod.els.antitruncNote.hidden, false);
    assert.ok(mod.els.antitruncNote.textContent.includes('未生成或已过期'));
    assert.equal(cachedEntries(), null);
});

test('gate: disconnected status disables injection and still cleans stale keys', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();
    const injected = await inject(makeGenerateData());
    const body = injected.custom_include_body;
    assert.ok(body.length > 0);

    const savedStatus = mod.state.status;
    mod.state.status = {
        ok: true,
        value: {
            authAvailable: false,
            connected: false,
            code: 'pass_binding_unavailable',
            message: '未连接',
            protocols: { chat: false, anthropic: false, responses: false },
            state: 'not_connected',
            st_connection: { state: 'unknown' },
        },
    };
    const data = await inject(makeGenerateData({ custom_include_body: body }));
    assert.equal(data.custom_include_body, '');
    assert.equal(mod.antitrunc.enabled, false);

    mod.state.status = savedStatus;
    mod.els.antitruncToggle.checked = true;
    mod.onAntitruncToggleChange();
    await settle();
    assert.equal(mod.antitrunc.enabled, true);
});

test('first guard toast is reason-specific and only shown once until guards clear', async () => {
    resetAll();
    await enableAntitrunc();
    await generate();

    await inject(makeGenerateData({ tools: [] }));
    await inject(makeGenerateData({ tools: [] }));
    let guardToasts = toastr.messages.filter((item) => item.kind === 'warning'
        && item.message.includes('tools（工具）'));
    assert.equal(guardToasts.length, 1);
    assert.equal(mod.antitrunc.guardToastShown, true);

    // 守卫通过 → 重置首次标记；再次触发再次 toast。
    await inject(makeGenerateData());
    assert.equal(mod.antitrunc.guardBlocked, false);
    await inject(makeGenerateData({ functions: [] }));
    guardToasts = toastr.messages.filter((item) => item.kind === 'warning'
        && item.message.includes('functions（函数）'));
    assert.equal(guardToasts.length, 1);
});

test('max_tokens below the section floor offers and applies the suggested value within budget (U3)', async () => {
    resetAll();
    ctx.chatCompletionSettings.openai_max_context = 8192;
    ctx.chatCompletionSettings.openai_max_tokens = 100;
    await enableAntitrunc();
    await generate();

    await inject(makeGenerateData({ max_tokens: 100 }));
    const floor = 2 * 1200 + 2000;
    assert.equal(mod.antitrunc.suggestedMaxTokens, floor);
    assert.equal(mod.els.antitruncSuggest.hidden, false);
    assert.equal(mod.readContextLimit(), 8192 - 100);

    const before = saveCount;
    mod.applySuggestedMaxTokens();
    await settle();
    assert.equal(ctx.chatCompletionSettings.openai_max_tokens, floor);
    assert.ok(saveCount > before);
    assert.equal(mod.antitrunc.suggestedMaxTokens, null);
    assert.equal(lastToast('success').message, `已应用建议值 max_tokens=${floor}。`);
});

test('suggested max_tokens is not applied when floor >= available budget (U3 default 4096)', async () => {
    resetAll();
    // 默认输出预算 4096：可用提示预算 8192-4096=4096，地板 4400 >= 预算。
    ctx.chatCompletionSettings.openai_max_context = 8192;
    ctx.chatCompletionSettings.openai_max_tokens = 4096;
    await enableAntitrunc();
    await generate();

    await inject(makeGenerateData({ max_tokens: 100 }));
    const floor = 2 * 1200 + 2000; // 4400 >= 4096 预算
    assert.equal(mod.antitrunc.suggestedMaxTokens, floor);
    assert.equal(mod.readContextLimit(), 4096);
    const beforeTokens = ctx.chatCompletionSettings.openai_max_tokens;
    const beforeSave = saveCount;
    mod.applySuggestedMaxTokens();
    await settle();
    assert.equal(ctx.chatCompletionSettings.openai_max_tokens, beforeTokens);
    assert.equal(saveCount, beforeSave);
    assert.ok(lastToast('warning').message.includes('不小于可用预算'));
    assert.ok(lastToast('warning').message.includes('未应用'));
});

// ---------- 生成失败：无回退名单 ----------

test('generation failure keeps injection closed and writes no fallback list', async () => {
    resetAll();
    await enableAntitrunc();
    planQueue.push({ fail: true, status: 502, code: 'upstream_unavailable', message: '上游失败' });
    await mod.generateSections();
    await settle();

    assert.equal(planCalls.length, 1);
    assert.equal(mod.antitrunc.generationFailed, true);
    assert.equal(cachedEntries(), null);

    const data = await inject(makeGenerateData());
    assert.equal(data.custom_include_body, '');
    assert.ok(mod.els.antitruncNote.textContent.includes('生成失败'));
    assert.equal(JSON.stringify(ctx.extensionSettings).includes('apercus_antitrunc'), false);
});

// ---------- B3：key 列表 / 模型选择 / 余额阈值 / 上下文计量 ----------

function textOf(node) {
    if (!node) return '';
    let text = typeof node.textContent === 'string' ? node.textContent : '';
    for (const child of node.children || []) text += ` ${textOf(child)}`;
    return text;
}

function findByText(root, text) {
    if (!root) return null;
    if (typeof root.textContent === 'string' && root.textContent.includes(text)) return root;
    for (const child of root.children || []) {
        const found = findByText(child, text);
        if (found) return found;
    }
    return null;
}

function modelRow(name) {
    for (const row of mod.els.modelsList.children) {
        if (textOf(row).includes(name)) return row;
    }
    return null;
}

test('key list renders name/masked/status and fails closed instead of echoing a plaintext key', async () => {
    resetAll();
    queryFixtures.keys = {
        keys: [{
            id: 'default',
            name: '默认 key',
            masked: '****7x2a',
            status: 'enabled',
            key: 'agw_plaintext_should_never_render',
        }],
    };
    await mod.refreshKeys();
    await settle();
    assert.equal(mod.state.keys, null);
    assert.ok(mod.state.keysError.includes('keys_plaintext_rejected'));
    assert.ok(mod.els.keysNote.textContent.includes('keys_plaintext_rejected'));
    assert.equal(textOf(mod.els.keysList).includes('agw_plaintext_should_never_render'), false);

    queryFixtures.keys = defaultQueryFixtures().keys;
    await mod.refreshKeys();
    await settle();
    assert.equal(mod.state.keys && mod.state.keys.ok, true);
    const text = textOf(mod.els.keysList);
    assert.ok(text.includes('默认 key'));
    assert.ok(text.includes('****7x2a'));
    assert.ok(text.includes('启用'));
    assert.ok(text.includes('当前 key'));
    assert.equal(text.includes('agw_plaintext_should_never_render'), false);
});

test('model confirm dialog: cancel writes nothing, confirm calls apply-model then writes four settings', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    await mod.refreshModels();
    await settle();

    const row = modelRow('model-a');
    assert.ok(row);
    assert.equal(row.getAttribute('role'), 'button');
    const beforeSave = saveCount;

    row.click();
    assert.equal(mod.modelDialog.open, true);
    assert.ok(mod.modelDialogLine.textContent.includes('model-a'));
    assert.ok(mod.modelDialogSourceLine.textContent.includes('将切换对话补全源为 Custom'));

    mod.modelDialogCancel.click();
    assert.equal(mod.modelDialog.open, false);
    assert.equal(applyCalls.length, 0);
    assert.equal(saveCount, beforeSave);
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai');

    row.click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.deepEqual(applyCalls, [{ model: 'model-a', switchSource: true }]);
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'custom');
    assert.ok(saveCount > beforeSave);
    assert.equal(mod.modelDialog.open, false);
    assert.equal(textOf(mod.els.modelsList).includes('当前模型'), true);
});

test('already-custom source never asks to switch and never rewrites the source', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    await mod.refreshModels();
    await settle();

    const row = modelRow('model-a');
    row.click();
    assert.ok(mod.modelDialogSourceLine.textContent.includes('已是 Custom'));
    assert.equal(mod.modelDialogSourceLine.textContent.includes('将切换'), false);
    mod.modelDialogConfirm.click();
    await settle();

    assert.deepEqual(applyCalls, [{ model: 'model-a', switchSource: false }]);
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'custom');
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
});

test('confirm switches the source through the ST native entry when jQuery is available (U1)', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    const calls = [];
    const previousJQuery = globalThis.window.jQuery;
    globalThis.window.jQuery = (selector) => {
        calls.push({ selector, val: null, triggered: false });
        const handle = {
            val(value) {
                calls[calls.length - 1].val = value;
                return handle;
            },
            trigger(event) {
                calls[calls.length - 1].triggered = event;
                return handle;
            },
        };
        return handle;
    };
    try {
        await mod.refreshModels();
        await settle();
        modelRow('model-a').click();
        mod.modelDialogConfirm.click();
        await settle();
    } finally {
        globalThis.window.jQuery = previousJQuery;
    }

    assert.deepEqual(applyCalls, [{ model: 'model-a', switchSource: true }]);
    const sourceCalls = calls.filter((call) => call.selector === '#chat_completion_source');
    assert.deepEqual(sourceCalls, [{
        selector: '#chat_completion_source',
        val: 'custom',
        triggered: 'change',
    }]);
    // G6：切源前后都同步原生 #model_custom_select。
    const modelSelectCalls = calls.filter((call) => call.selector === '#model_custom_select');
    assert.equal(modelSelectCalls.length, 2);
    for (const call of modelSelectCalls) {
        assert.equal(call.val, 'model-a');
        assert.equal(call.triggered, 'change');
    }
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    // 原生入口负责改 chat_completion_source；测试 stub 不模拟 ST 处理器，
    // 但插件没有在确认前偷偷切换 source。
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai');
});

test('non-chat model rows stay disabled and cannot open the confirm dialog', async () => {
    resetAll();
    await mod.refreshModels();
    await settle();
    const row = modelRow('model-b');
    assert.ok(row);
    assert.equal(row.getAttribute('role'), null);
    assert.ok(textOf(row).includes('未适配协议面'));
    assert.equal(textOf(row).includes('可连接'), false);
    row.click();
    assert.equal(mod.modelDialog.open, false);
    assert.equal(applyCalls.length, 0);
});

test('apply-model failure rolls custom_url/custom_model back and keeps the source unchanged', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    queryFixtures.applyStatus = 502;
    queryFixtures.apply = { error: { code: 'custom_source_write_failed', message: '写失败' } };
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(applyCalls.length, 1);
    // U1：已先写入插件值（并保存），失败后回滚到原值并再次保存。
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://user.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai');
    assert.ok(saveCount >= 2);
    assert.ok(lastToast('error').message.includes('模型接入失败'));
    assert.ok(lastToast('error').message.includes('已回滚'));
});

test('invalid H/K strings keep balance rows visible and render H/K as unknown (S9)', async () => {
    resetAll();
    queryFixtures.balance = {
        ...defaultQueryFixtures().balance,
        penalty_input_threshold: '1.5',
        penalty_multiplier: '-1',
    };
    await mod.refreshBalance();
    await settle();
    assert.equal(mod.state.balance !== null, true);
    assert.equal(mod.state.balance.permanent_balance, '1.000000');
    const rows = mod.els.balanceList.children.map((row) => textOf(row));
    assert.ok(rows.some((line) => line.includes('大输入惩罚阈值 H') && line.includes('未知')));
    assert.ok(rows.some((line) => line.includes('倍率 K') && line.includes('未知')));
    assert.ok(mod.els.balanceNote.textContent.includes('每日') === false);
});

test('balance shows H/K rows, unknown values, and a non-zero-free failure note', async () => {
    resetAll();
    queryFixtures.balance = {
        ...defaultQueryFixtures().balance,
        penalty_input_threshold: undefined,
        penalty_multiplier: undefined,
    };
    await mod.refreshBalance();
    await settle();
    assert.equal(mod.state.balance && mod.state.balance.permanent_balance, '1.000000');
    const rows = mod.els.balanceList.children.map((row) => textOf(row));
    assert.ok(rows.some((line) => line.includes('大输入惩罚阈值 H') && line.includes('未知')));
    assert.ok(rows.some((line) => line.includes('倍率 K') && line.includes('未知')));

    queryFixtures.balanceError = { status: 502, code: 'upstream_unavailable', message: '网关暂时不可用' };
    await mod.refreshBalance();
    await settle();
    assert.equal(mod.state.balance, null);
    assert.ok(mod.els.balanceNote.textContent.startsWith('暂时无法获取额度'));
    assert.equal(textOf(mod.els.balanceList).includes('0.000000'), false);
    assert.equal(mod.state.status.value.state, 'authorized');
});

test('context meter colors at 90% and 100% of H and never blocks on dry runs', async () => {
    resetAll();
    queryFixtures.balance = { ...defaultQueryFixtures().balance, penalty_input_threshold: '1000' };
    await mod.refreshBalance();
    await settle();
    ctx.maxContext = 4096;

    await mod.onGenerateAfterData({ messages: [{ content: 'x'.repeat(500) }] }, false);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('已用 500'));
    assert.ok(mod.els.meterLine.className.includes('ag-meter-ok'));

    await mod.onGenerateAfterData({ messages: [{ content: 'y'.repeat(900) }] }, false);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('已用 900'));
    assert.ok(mod.els.meterLine.className.includes('ag-meter-warn'));

    await mod.onGenerateAfterData({ messages: [{ content: 'z'.repeat(1000) }] }, false);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('已用 1000'));
    assert.ok(mod.els.meterLine.className.includes('ag-meter-danger'));

    // dryRun 不更新计量。
    await mod.onGenerateAfterData({ messages: [{ content: 'w'.repeat(2000) }] }, true);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('已用 1000'));

    // H 未知 → 不着色。
    mod.state.balance = { ...mod.state.balance, penalty_input_threshold: null };
    mod.renderContextMeter();
    assert.equal(mod.els.meterLine.className, 'ag-meter');
});

test('B2 plan model only comes from custom_model; missing model disables generation (U7)', async () => {
    resetAll();
    await enableAntitrunc();
    delete ctx.chatCompletionSettings.custom_model;
    mod.renderStatus();
    assert.equal(mod.els.antitruncButton.disabled, true);
    assert.ok(mod.els.antitruncCost.textContent.includes('未选择模型'));
    assert.equal(mod.antitrunc.sections, null);

    await mod.generateSections();
    await settle();
    assert.equal(planCalls.length, 0);
    assert.ok(lastToast('warning').message.includes('尚未选择模型'));
});

test('context meter uses openai_max_context - openai_max_tokens as the budget (U2)', async () => {
    resetAll();
    ctx.chatCompletionSettings.openai_max_context = 131072;
    ctx.chatCompletionSettings.openai_max_tokens = 4096;
    assert.equal(mod.readContextLimit(), 126976);

    await mod.onGenerateAfterData({ messages: [{ content: 'x'.repeat(1000) }] }, false);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('已用 1000'));
    assert.ok(mod.els.meterLine.textContent.includes('预算 126976'));
    assert.ok(mod.els.meterLine.textContent.includes('上限') === false);

    // 文本源/无 chat 设置：回退 maxContext。
    delete ctx.chatCompletionSettings.openai_max_context;
    ctx.maxContext = 4096;
    assert.equal(mod.readContextLimit(), 4096);

    // getMaxPromptTokens 存在时优先于 settings 口径与 maxContext。
    ctx.getMaxPromptTokens = () => 5000;
    assert.equal(mod.readContextLimit(), 5000);
    delete ctx.getMaxPromptTokens;

    // 文本补全源也按同一口径：oai_settings 两值齐全就用差值（F7 删除了旧的
    // textgenerationwebui 特判分支）。
    ctx.chatCompletionSettings.chat_completion_source = 'textgenerationwebui';
    ctx.chatCompletionSettings.openai_max_context = 131072;
    ctx.chatCompletionSettings.openai_max_tokens = 4096;
    assert.equal(mod.readContextLimit(), 126976);

    // 两值不全 → 回退 maxContext（两值不齐全时不猜预算）。
    delete ctx.chatCompletionSettings.openai_max_tokens;
    ctx.maxContext = 4096;
    assert.equal(mod.readContextLimit(), 4096);

    await mod.onGenerateAfterData({ messages: [{ content: 'y'.repeat(500) }] }, false);
    await settle();
    assert.ok(mod.els.meterLine.textContent.includes('预算 4096'));
});

test('status line reads ctx.onlineStatus without ever inventing connected (S11)', () => {
    resetAll();
    ctx.onlineStatus = 'connected';
    mod.renderStatus();
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：已连接'));

    ctx.onlineStatus = 'no_connection';
    mod.renderStatus();
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：未连接'));
    assert.equal(mod.els.statusLine.textContent.includes('酒馆连接：已连接'), false);

    delete ctx.onlineStatus;
    mod.renderStatus();
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：未知'));
});

test('logout with remote_revoked=false tells the user the remote credential may still work (S2)', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.state.status.value.state, 'authorized');

    queryFixtures.logout = { status: 'logged_out', remote_revoked: false, local_cleared: true };
    queryFixtures.status = { ...statusPayload(), state: 'not_connected' };
    delete queryFixtures.status.username;
    await mod.doLogout();
    await settle();
    assert.ok(mod.state.status.value.state === 'not_connected');
    assert.ok(mod.els.loginNote.textContent.includes('远端凭据可能仍有效'));
    assert.ok(mod.els.loginNote.textContent.includes('退出所有酒馆插件'));
    assert.equal(mod.els.logoutButton.hidden, true);
});

test('logout local-clear failure surfaces the 502 and never re-renders authorized (S2)', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.state.status.value.state, 'authorized');

    queryFixtures.logoutStatus = 502;
    queryFixtures.logout = {
        error: { code: 'logout_local_clear_failed', message: '退出登录时本地凭据清理失败' },
    };
    queryFixtures.status = { ...statusPayload(), state: 'invalid', reason: 'connect_request_invalid' };
    delete queryFixtures.status.username;
    await mod.doLogout();
    await settle();

    assert.equal(mod.state.status.value.state, 'invalid');
    assert.equal(mod.state.status.value.state === 'authorized', false);
    assert.ok(mod.els.loginNote.textContent.includes('本地凭据未清理干净'));
    assert.ok(mod.els.loginNote.textContent.includes('退出所有酒馆插件'));
    assert.equal(mod.els.logoutButton.hidden, true);
});

test('unauthorized state disables query buttons and hides query sections behind gate notes', () => {
    resetAll();
    mod.state.status = {
        ok: true,
        value: {
            authAvailable: false,
            connected: false,
            code: 'pass_binding_unavailable',
            message: '未连接',
            protocols: { chat: false, anthropic: false, responses: false },
            state: 'not_connected',
            st_connection: { state: 'unknown' },
        },
    };
    mod.renderStatus();
    assert.equal(mod.els.keysButton.disabled, true);
    assert.equal(mod.els.modelsButton.disabled, true);
    assert.equal(mod.els.balanceButton.disabled, true);
    assert.equal(mod.els.keysNote.textContent, '登录后可用。');
    assert.equal(mod.els.modelsNote.textContent, '登录后可用。');
    assert.equal(mod.els.balanceNote.textContent, '登录后可用。');
    assert.equal(mod.els.meterLine.textContent, '登录后可用。');
});

// ===== F7：onlineStatus 事件与预算口径 =====

test('ONLINE_STATUS_CHANGED refreshes the status line without inventing connected (F7)', () => {
    resetAll();
    mod.state.status = {
        ok: true,
        value: {
            authAvailable: false,
            connected: false,
            code: 'pass_binding_unavailable',
            message: '状态',
            protocols: { chat: false, anthropic: false, responses: false },
            state: 'authorized',
            st_connection: { state: 'unknown' },
        },
    };
    ctx.onlineStatus = 'no_connection';
    const listeners = ctx._listeners.online_status_changed || [];
    assert.equal(listeners.length, 1, 'ONLINE_STATUS_CHANGED listener subscribed');
    listeners[0]('OpenAI');
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：已连接'));
    listeners[0]('no_connection');
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：未连接'));
    assert.equal(mod.els.statusLine.textContent.includes('酒馆连接：已连接'), false);
    listeners[0]('');
    assert.ok(mod.els.statusLine.textContent.includes('酒馆连接：未知'));
});

test('context limit uses getMaxPromptTokens first, settings difference second, maxContext last (F7)', () => {
    resetAll();
    ctx.chatCompletionSettings.openai_max_context = 32768;
    ctx.chatCompletionSettings.openai_max_tokens = 2048;
    assert.equal(mod.readContextLimit(), 30720);

    ctx.getMaxPromptTokens = () => 12000;
    assert.equal(mod.readContextLimit(), 12000);
    // 存在但返回值非法 → 明确的“预算不可用”，不回退到 settings。
    ctx.getMaxPromptTokens = () => 0;
    assert.equal(mod.readContextLimit(), null);
    ctx.getMaxPromptTokens = () => -1;
    assert.equal(mod.readContextLimit(), null);
    delete ctx.getMaxPromptTokens;

    // 只有单一 openai 值 → 回退 maxContext。
    delete ctx.chatCompletionSettings.openai_max_tokens;
    ctx.maxContext = 8192;
    assert.equal(mod.readContextLimit(), 8192);
    // 两值齐全但差 ≤0 → null（不用 maxContext 掩盖不可用预算）。
    ctx.chatCompletionSettings.openai_max_tokens = 40000;
    assert.equal(mod.readContextLimit(), null);
    delete ctx.chatCompletionSettings.openai_max_tokens;

    // 无 chat 设置 → maxContext。
    ctx.chatCompletionSettings = {};
    assert.equal(mod.readContextLimit(), 8192);
});

// ===== F10：apply-model 回滚只发生在明确拒绝 =====

test('apply-model 409 rolls custom_url/custom_model back (F10)', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    queryFixtures.applyStatus = 409;
    queryFixtures.apply = { error: { code: 'not_connected', message: '未授权' } };
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(applyCalls.length, 1);
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://user.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
    assert.ok(lastToast('error').message.includes('已回滚'));
});

test('apply-model network uncertainty keeps the gateway URL and asks the user to retry/logout (F10)', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    queryFixtures.applyNetworkError = true;
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(applyCalls.length, 0);
    // 网络不确定：保留已写入的网关 URL，不回滚到第三方 URL。
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    assert.ok(lastToast('error').message.includes('结果未知'));
    assert.ok(lastToast('error').message.includes('已保留网关 URL'));
    assert.ok(lastToast('error').message.includes('退出登录'));
    // 对话框保持打开可重试。
    assert.equal(mod.modelDialogConfirm.disabled, false);
});

// ===== F11：预设切换到第三方域时清理插件自有 Custom key =====

test('preset change to a non-gateway custom_url releases the plugin-owned Custom key (F11)', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    mod.antitrunc.customKeyPresent = true;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();

    assert.equal(releaseCalls.length, 1);
    assert.deepEqual(releaseCalls[0], {});
    assert.equal(mod.antitrunc.customKeyPresent, false);
    assert.ok(lastToast('info').message.includes('已清理插件写入酒馆 Custom 源'));

    // 已确认清理完成后不再重复调用。
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);

    // 失败时保持“仍可能有 key”，提示用户退出登录重试。
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://another-third.example/v1';
    mod.antitrunc.customKeyPresent = true;
    queryFixtures.release = { cleared: false };
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    assert.equal(mod.antitrunc.customKeyPresent, true);
    assert.ok(lastToast('warning').message.includes('未能清理干净'));
});

test('CHAT_COMPLETION_SETTINGS_READY also triggers the F11 release (once) and still skips injection quietly', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    mod.antitrunc.customKeyPresent = true;
    const data = makeGenerateData({ custom_url: 'https://third-party.example/v1' });
    await inject(data);
    assert.equal(releaseCalls.length, 1);
    assert.equal(mod.antitrunc.customKeyPresent, false);
    // B2 注入对非网关目标安静跳过（原有语义保持）。
    assert.equal(data.custom_include_body, '');
});


// ===== H1/H2/H4：预设前清理与账号切换 =====

function makeDeferred() {
    let resolve = null;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('H1: OAI_PRESET_CHANGED_BEFORE returns the release Promise before the source change', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    const listeners = ctx._listeners.oai_preset_changed_before || [];
    assert.ok(listeners.length >= 1, 'preset-before listener registered');
    const gate = makeDeferred();
    queryFixtures.releaseDeferred = gate.promise;
    const payload = {
        preset: { custom_url: 'https://third-before.example/v1' },
        settings: { bind_preset_to_connection: true },
        settingsToUpdate: { custom_url: ['#custom_api_url_text', 'custom_url', false, true] },
        presetName: 'Preset B',
    };
    const pending = listeners[0](payload);
    assert.equal(typeof pending.then, 'function', 'listener returns an awaitable');
    // ST 1.17.0 的 emit 会 await 该返回值，openai.js 在 emit 的 finally 里才应用
    // 预设差异并触发 #chat_completion_source change（reconnect/status 读取 key）。
    await settle();
    assert.ok(orderLog.includes('/release-start'), 'release request started while preset is blocked');
    assert.equal(releaseCalls.length, 0);
    gate.resolve();
    await pending;
    orderLog.push('/source-change');
    assert.equal(releaseCalls.length, 1);
    const start = orderLog.indexOf('/release-start');
    const done = orderLog.indexOf('/release-done');
    const source = orderLog.indexOf('/source-change');
    assert.ok(start >= 0 && done > start && source > done, 'release completed before the source change');
    assert.equal(mod.antitrunc.customKeyPresent, false);

    // 预设未绑定连接 / 不含 custom_url：不触发清理，返回同步 undefined。
    resetAll();
    assert.equal(listeners[0]({
        preset: { custom_url: 'https://third-before.example/v1' },
        settings: { bind_preset_to_connection: false },
        settingsToUpdate: { custom_url: [] },
    }), undefined);
    await settle();
    assert.equal(releaseCalls.length, 0);

    // J2：快速连续两次 BEFORE（同一 URL、5 秒窗口内）都请求 release——阻塞
    // 路径不做客户端节流，服务端幂等。
    resetAll();
    const rapid = {
        preset: { custom_url: 'https://third-before-rapid.example/v1' },
        settings: { bind_preset_to_connection: true },
        settingsToUpdate: { custom_url: ['#custom_api_url_text', 'custom_url', false, true] },
    };
    const firstBefore = listeners[0](rapid);
    if (firstBefore && typeof firstBefore.then === 'function') await firstBefore;
    await settle();
    assert.equal(releaseCalls.length, 1);
    const secondBefore = listeners[0](rapid);
    if (secondBefore && typeof secondBefore.then === 'function') await secondBefore;
    await settle();
    assert.equal(releaseCalls.length, 2);
});

test('H2: a page cache of customKeyPresent=false never short-circuits the release (cross-tab)', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    // 模拟 A 标签已清理过（本地展示缓存 false），B 标签随后写入了插件 key。
    mod.antitrunc.customKeyPresent = false;
    const url = 'https://third-cross-tab.example/v1';
    ctx.chatCompletionSettings.custom_url = url;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1, 'release still requested despite the stale false cache');
    // J2：只有非阻塞 PRESET_CHANGED 提示路径保留同 URL 短窗节流（I2：5 秒）。
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
});

// ===== I1：非字符串 custom_url 也走清理 =====

test('I1: non-string custom_url is treated as non-gateway by all three cleanup hooks', async () => {
    const variants = [
        ['https://third-array.example/v1'],
        { url: 'https://third-object.example/v1' },
        42,
    ];
    // 钩子一：PRESET_CHANGED（读取活动设置里的 custom_url）。
    for (const value of variants) {
        resetAll();
        ctx.chatCompletionSettings.custom_url = value;
        mod.antitrunc.customKeyPresent = null;
        mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
        await settle();
        assert.equal(releaseCalls.length, 1, `preset_changed ${String(value)}`);
    }
    // 钩子二：CHAT_COMPLETION_SETTINGS_READY（读取 generate_data.custom_url）。
    for (const value of variants) {
        resetAll();
        ctx.chatCompletionSettings.custom_url = value;
        const data = makeGenerateData({ custom_url: value });
        await inject(data);
        assert.equal(releaseCalls.length, 1, `settings_ready ${String(value)}`);
    }
    // 钩子三：OAI_PRESET_CHANGED_BEFORE（读取即将应用的预设值）。
    for (const value of variants) {
        resetAll();
        await mod.refreshStatus();
        await settle();
        const listeners = ctx._listeners.oai_preset_changed_before || [];
        assert.ok(listeners.length >= 1, 'preset-before listener registered');
        const pending = listeners[listeners.length - 1]({
            preset: { custom_url: value },
            settings: { bind_preset_to_connection: true },
            settingsToUpdate: { custom_url: ['#custom_api_url_text', 'custom_url', false, true] },
        });
        if (pending && typeof pending.then === 'function') await pending;
        await settle();
        assert.equal(releaseCalls.length, 1, `preset_before ${String(value)}`);
    }
});

// ===== I2：清理节流窗口与 key 重写重置 =====

test('I2: PRESET_CHANGED same-URL cleanup is deduped briefly and resets when this page rewrites the key', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    const url = 'https://third-rewrite.example/v1';
    ctx.chatCompletionSettings.custom_url = url;
    mod.antitrunc.customKeyPresent = false;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    // 同 URL 立即重复仍去重（节流只用于非阻塞提示路径的事件去重）。
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);

    // 本页重新 apply 成功（key 被重写）→ 节流重置；同一 URL 再次事件必须 release。
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1);
    assert.equal(mod.antitrunc.customKeyPresent, true);
    ctx.chatCompletionSettings.custom_url = url;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 2);
});

test('I2: a cross-tab key rewrite is retried after the short window, not after 60 seconds', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    const url = 'https://third-cross-window.example/v1';
    ctx.chatCompletionSettings.custom_url = url;
    mod.antitrunc.customKeyPresent = false;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    // 另一标签写入 key 发生在本页节流窗口之外（模拟 6 秒后）：同一 URL 必须再次 release。
    mod.antitrunc.cleanupAttemptAt = Date.now() - 6000;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 2);

    // J2：阻塞型路径（生成设置就绪）不受 5 秒同 URL 窗口影响——另一标签在
    // 窗口内重写 key 后，下一次生成必须再次请求幂等清理，不能沿用旧窗口。
    resetAll();
    const blockingUrl = 'https://third-blocking.example/v1';
    ctx.chatCompletionSettings.custom_url = blockingUrl;
    mod.antitrunc.customKeyPresent = false;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1, 'PRESET_CHANGED established the throttle window');
    // 模拟另一标签在本页 5 秒窗口内写入插件 key。
    mod.antitrunc.customKeyPresent = true;
    const data = makeGenerateData({ custom_url: blockingUrl });
    await inject(data);
    assert.equal(releaseCalls.length, 2, 'CHAT_COMPLETION_SETTINGS_READY ignores the throttle');
    mod.antitrunc.customKeyPresent = true; // 另一标签再次重写
    await inject(data);
    assert.equal(releaseCalls.length, 3);
});

test('I2: re-authorization resets the cleanup throttle inside the window', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    const url = 'https://third-reauth.example/v1';
    ctx.chatCompletionSettings.custom_url = url;
    mod.antitrunc.customKeyPresent = false;
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 1);
    // approved/refresh 在 UI 侧表现为新授权世代（username 变化）。
    queryFixtures.status = { ...statusPayload(), username: 'bob' };
    await mod.refreshStatus();
    await settle();
    mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
    await settle();
    assert.equal(releaseCalls.length, 2);
});

test('H3/H4: account switch clears cached keys/models/balance and refetches', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    assert.ok(mod.state.keys && mod.state.models && mod.state.balance, 'initial authorized data loaded');
    const before = { keys: keysCalls, models: modelsCalls, balance: balanceCalls };
    queryFixtures.status = { ...statusPayload(), username: 'bob' };
    await mod.refreshStatus();
    // renderStatus 在发出重新拉取前同步清空旧账号缓存。
    assert.equal(mod.state.keys, null);
    assert.equal(mod.state.models, null);
    assert.equal(mod.state.balance, null);
    // 上下文缓存清空后 renderStatus 会立刻排一次重算：预算可能已同步回填，
    // 但旧账号的用量不得残留。
    assert.equal(mod.state.contextMeter.used, null);
    await settle();
    assert.ok(keysCalls > before.keys, 'keys refetched');
    assert.ok(modelsCalls > before.models, 'models refetched');
    assert.ok(balanceCalls > before.balance, 'balance refetched');
    assert.ok(mod.state.keys && mod.state.models && mod.state.balance);
    assert.equal(mod.state.authIdentity, 'bob');
});

test('H4: an in-flight response from the previous account generation is discarded', async () => {
    resetAll();
    await mod.refreshStatus();
    await settle();
    const gate = makeDeferred();
    queryFixtures.keysDeferred = [{
        promise: gate.promise,
        value: { keys: [{ id: 'stale', name: 'stale-key', masked: '****stale', status: 'enabled' }] },
    }];
    const pendingA = mod.refreshKeys();
    await settle();
    assert.equal(mod.state.keysPending, true);
    // 切到 B：清空缓存并使 A 世代请求过期，再拉取 B 的数据。
    queryFixtures.status = { ...statusPayload(), username: 'bob' };
    await mod.refreshStatus();
    await settle();
    assert.ok(mod.state.keys, 'B data loaded');
    assert.equal(mod.state.keys.keys[0].name, '默认 key');
    // A 的旧响应此时才回来：必须被丢弃，不能覆盖 B 的列表。
    gate.resolve();
    await pendingA;
    await settle();
    assert.equal(mod.state.keys.keys[0].name, '默认 key');
    assert.equal(mod.state.keysError, null);
});


// ===== G2：真实保存先行 =====

test('G2: saveSettings is awaited (confirmed) before POST /apply-model', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(applyCalls.length, 1);
    const saveIndex = orderLog.indexOf('/save-settings');
    const applyIndex = orderLog.indexOf('/apply-model');
    assert.ok(saveIndex >= 0, 'saveSettings called');
    assert.ok(applyIndex > saveIndex, 'apply-model only after the awaited save');
});

test('G2: an unconfirmed settings save blocks the server call and restores memory state', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    saveFail = true;
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(applyCalls.length, 0);
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://user.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
    assert.ok(lastToast('error').message.includes('设置保存失败'));
    assert.equal(mod.modelDialogConfirm.disabled, false);
});

// ===== G3：清理注册与严格 URL 判定 =====

test('G3: cleanup triggers for http/userinfo/non-default-port custom URLs', async () => {
    for (const url of [
        'http://api.apercus.ai/v1',
        'https://user:pass@api.apercus.ai/v1',
        'https://api.apercus.ai:8443/v1',
    ]) {
        resetAll();
        ctx.chatCompletionSettings.custom_url = url;
        mod.antitrunc.customKeyPresent = null;
        mod.onPresetChanged({ apiId: 'openai', name: 'Preset A' });
        await settle();
        assert.equal(releaseCalls.length, 1, url);
    }
});

test('G3: settings-ready returns the release Promise and read_failed stays unknown', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    mod.antitrunc.customKeyPresent = null;
    queryFixtures.release = { cleared: false, reason: 'read_failed' };
    const data = makeGenerateData({ custom_url: 'https://third-party.example/v1' });
    const pending = mod.onChatCompletionSettingsReady(data);
    assert.equal(typeof pending.then, 'function', 'listener returns an awaitable cleanup promise');
    await pending;
    await settle();
    assert.equal(releaseCalls.length, 1);
    assert.equal(mod.antitrunc.customKeyPresent, null);
    assert.ok(lastToast('warning').message.includes('读取绑定失败'));
});

test('G3: cleanup hooks register and run even when antitrunc is unsupported', async () => {
    resetAll();
    const savedGetPreset = ctx.getPresetManager;
    delete ctx.getPresetManager;
    let sparse = null;
    try {
        sparse = await loadUiModule();
        sparse.init();
        await settle();
    } finally {
        ctx.getPresetManager = savedGetPreset;
    }
    assert.equal(sparse.antitrunc.supported, false);
    assert.ok((ctx._listeners.preset_changed || []).length >= 2);
    assert.ok((ctx._listeners.chat_completion_settings_ready || []).length >= 2);

    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    sparse.antitrunc.customKeyPresent = null;
    await sparse.onChatCompletionSettingsReady({ custom_url: 'https://third-party.example/v1' });
    await settle();
    sparse.cleanupTimers();
    assert.equal(releaseCalls.length, 1);
});

// ===== G6：原生模型控件同步 =====

test('G6: native custom model select is synced before/after switching and custom_model is reasserted', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    const modelSelectValues = [];
    const previousJQuery = globalThis.window.jQuery;
    globalThis.window.jQuery = (selector) => {
        if (selector === '#model_custom_select') {
            const handle = {
                length: 1,
                val(value) {
                    if (value !== undefined) modelSelectValues.push(value);
                    return handle;
                },
                trigger() {
                    ctx.chatCompletionSettings.custom_model = '';
                    return handle;
                },
            };
            return handle;
        }
        const handle = { val() { return handle; }, trigger() { return handle; } };
        return handle;
    };
    try {
        await mod.refreshModels();
        await settle();
        modelRow('model-a').click();
        mod.modelDialogConfirm.click();
        await settle();
    } finally {
        globalThis.window.jQuery = previousJQuery;
    }

    assert.deepEqual(modelSelectValues, ['model-a', 'model-a']);
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
});

// ===== G7：周期状态刷新 =====

test('G7: authorized status schedules a 60-minute refresh; panel open refreshes; non-authorized clears it', async () => {
    resetAll();
    let captured = null;
    const originalSetInterval = globalThis.window.setInterval;
    globalThis.window.setInterval = (handler) => {
        captured = handler;
        return { unref() {} };
    };
    try {
        await mod.refreshStatus();
        await settle();
    } finally {
        globalThis.window.setInterval = originalSetInterval;
    }
    assert.notEqual(mod.state.statusRefreshTimer, null);
    assert.equal(typeof captured, 'function');

    statusCalls = 0;
    captured();
    await settle();
    assert.equal(statusCalls, 1);

    statusCalls = 0;
    mod.openPanel();
    await settle();
    assert.ok(statusCalls >= 1);

    queryFixtures.status = { ...statusPayload(), state: 'not_connected' };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.state.statusRefreshTimer, null);

    mod.cleanupTimers();
    assert.equal(mod.state.statusRefreshTimer, null);
    assert.equal(mod.state.connectPolling, false);
});

// ===== G10：logout 重试可见 =====

test('G10: invalid + login_invalidated keeps a retryable logout button', async () => {
    resetAll();
    queryFixtures.status = { ...statusPayload(), state: 'invalid', reason: 'login_invalidated' };
    delete queryFixtures.status.username;
    queryFixtures.logoutStatus = 502;
    queryFixtures.logout = { error: { code: 'logout_local_clear_failed', message: '清理失败' } };
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.els.logoutButton.hidden, false);
    assert.ok(mod.els.logoutButton.textContent.includes('重试清理'));

    mod.els.logoutButton.click();
    await settle();
    assert.equal(logoutCalls, 1);
    assert.equal(mod.els.logoutButton.hidden, false);
});

test('G10b: confirmed login cleanup hides the retryable logout button', async () => {
    resetAll();
    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: true,
        custom_cleared: true,
    };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    // 清理已确认：重试 logout 只会因无信封的 Custom 条目变成 uncertain
    // 并强制清空用户设置，因此不给重试入口，改为重新连接提示。
    assert.equal(mod.els.logoutButton.hidden, true);
    assert.ok(mod.els.loginNote.textContent.includes('登录已失效'));

    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: true,
        custom_cleared: false,
    };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.els.logoutButton.hidden, false);
    assert.ok(mod.els.logoutButton.textContent.includes('重试清理'));
});

// ===== G11：授权页打开时序 =====

test('G11: about:blank window opens synchronously before the connect request and receives the URL', async () => {
    resetAll();
    let authWindow = null;
    const originalOpen = globalThis.window.open;
    globalThis.window.open = (url) => {
        orderLog.push('/open-blank');
        authWindow = {
            opener: null,
            location: { href: '' },
            close() { this.closed = true; },
        };
        openCalls.push(url);
        return authWindow;
    };
    try {
        await mod.doConnect();
        await settle();
    } finally {
        globalThis.window.open = originalOpen;
        mod.stopConnectPolling();
    }

    assert.equal(authWindow.location.href, 'https://gw.apercus.ai/portal/connect');
    const openIndex = orderLog.indexOf('/open-blank');
    const requestIndex = orderLog.indexOf('/connect');
    assert.ok(openIndex >= 0, 'open called');
    assert.ok(requestIndex > openIndex, 'open happens before the /connect request');
    assert.equal(mod.els.connectLink.hidden, true);
});

test('G11: a blocked window falls back to a whitelisted clickable link', async () => {
    resetAll();
    const originalOpen = globalThis.window.open;
    globalThis.window.open = () => null;
    try {
        await mod.doConnect();
        await settle();
    } finally {
        globalThis.window.open = originalOpen;
        mod.stopConnectPolling();
    }
    assert.equal(mod.els.connectLink.hidden, false);
    assert.equal(mod.els.connectLink.href, 'https://gw.apercus.ai/portal/connect');
    assert.ok(mod.els.loginNote.textContent.includes('拦截'));
});

test('G11: a non-whitelisted authorize URL closes the blank window and never opens it', async () => {
    resetAll();
    queryFixtures.connect = { status: 'pending', authorize_url: 'https://evil.example/connect' };
    let closed = false;
    const originalOpen = globalThis.window.open;
    globalThis.window.open = () => ({
        opener: null,
        location: { href: '' },
        close() { closed = true; },
    });
    try {
        await mod.doConnect();
        await settle();
    } finally {
        globalThis.window.open = originalOpen;
        mod.stopConnectPolling();
    }
    assert.equal(closed, true);
    assert.equal(mod.els.connectLink.hidden, true);
    assert.ok(mod.els.loginNote.textContent.includes('非白名单'));
});

// ===== G12：pending 自动恢复轮询 =====

test('G12: renderStatus resumes connect polling for pending and stops on the terminal state', async () => {
    resetAll();
    queryFixtures.status = { ...statusPayload(), state: 'pending' };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.state.connectPolling, true);
    assert.ok(connectStatusCalls >= 1);

    queryFixtures.status = statusPayload();
    connectStatusQueue = [{ status: 'authorized', username: 'alice' }];
    await mod.pollConnectOnce();
    await settle();
    assert.equal(mod.state.connectPolling, false);
    assert.equal(mod.state.status.value.state, 'authorized');
});

test('W1: an authorized status with a live reconnect session resumes polling after refresh', async () => {
    resetAll();
    // 已授权 + 服务端仍有连接会话（换账号/续期）：state 仍是 authorized，
    // 只有 connect_pending 能提示 UI 恢复轮询。
    queryFixtures.status = { ...statusPayload(), connect_pending: true };
    await mod.refreshStatus();
    await settle();
    assert.equal(mod.state.connectPolling, true);
    assert.ok(connectStatusCalls >= 1);
    queryFixtures.status = statusPayload();
    connectStatusQueue = [{ status: 'authorized', username: 'alice' }];
    await mod.pollConnectOnce();
    await settle();
    assert.equal(mod.state.connectPolling, false);
});

test('G1: custom_source_write_partial keeps the gateway URL and marks the key state unknown', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    queryFixtures.applyStatus = 502;
    queryFixtures.apply = { error: { code: 'custom_source_write_partial', message: '结果不确定' } };
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
    // 归属/写入状态未知：不置 true/false，重新武装第三方 URL 清理。
    assert.equal(mod.antitrunc.customKeyPresent, null);
    assert.ok(lastToast('error').message.includes('结果未知'));
    assert.equal(lastToast('error').message.includes('已回滚'), false);
    assert.equal(mod.modelDialogConfirm.disabled, false);
});

// ===== I3：/apply-model 在途期间的预设切换/取消 =====

test('I3: switching presets while /apply-model is in flight aborts the source switch and releases the key', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    const gate = makeDeferred();
    queryFixtures.applyDeferred = gate.promise;
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1, 'apply-model request is in flight');
    assert.equal(mod.modelDialogConfirm.disabled, true);

    // 等待期间用户切到第三方预设（URL 已不再等于网关 base）。
    const third = 'https://third-while-apply.example/v1';
    ctx.chatCompletionSettings.custom_url = third;
    gate.resolve();
    await settle();

    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai', 'source stays unchanged');
    assert.equal(releaseCalls.length, 1, 'just-written key is released');
    assert.equal(mod.antitrunc.customKeyPresent, null);
    assert.ok(lastToast('warning').message.includes('接入已取消'));
    assert.ok(lastToast('warning').message.includes('已清理本次写入的 Custom key'));
    assert.ok(lastToast('warning').message.includes('未切换'));
    assert.equal(mod.modelDialog.open, false);
    assert.equal(ctx.chatCompletionSettings.custom_url, third, 'preset URL is not overwritten');
});

test('I3: closing the confirm dialog while /apply-model is in flight also cancels', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    const gate = makeDeferred();
    queryFixtures.applyDeferred = gate.promise;
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1);

    // 用户点“取消”关闭弹窗：取消处理器同步作废在途确认（不依赖异步 close 事件）。
    mod.modelDialogCancel.click();
    assert.equal(mod.modelDialog.open, false);
    gate.resolve();
    await settle();

    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai');
    // W4：URL 仍指向网关时不能 blanket release——那会删掉更新一次接入写入的
    // key；保留的 key 仍只会发往网关。
    assert.equal(releaseCalls.length, 0, 'no release while the URL still points at the gateway base');
    assert.equal(mod.antitrunc.customKeyPresent, null);
    assert.ok(lastToast('warning').message.includes('接入已取消'));
    assert.ok(lastToast('warning').message.includes('仍指向网关'));

    // J4：服务端未确认 cleared:true（残留/read_failed/请求失败）时不得谎称
    // “已清理本次写入的 Custom key”，必须提示凭据可能残留。
    const cancelWithRelease = async (releaseFixture, status) => {
        resetAll();
        ctx.chatCompletionSettings.chat_completion_source = 'openai';
        queryFixtures.release = releaseFixture;
        queryFixtures.releaseStatus = status;
        const nextGate = makeDeferred();
        queryFixtures.applyDeferred = nextGate.promise;
        await mod.refreshModels();
        await settle();
        modelRow('model-a').click();
        mod.modelDialogConfirm.click();
        await settle();
        assert.equal(applyCalls.length, 1);
        // 等待期间用户切到第三方预设 → 进入取消回收分支。
        ctx.chatCompletionSettings.custom_url = 'https://third-while-apply-cancel.example/v1';
        nextGate.resolve();
        await settle();
        assert.equal(releaseCalls.length, 1, 'release attempted before telling the user anything');
        const warning = lastToast('warning');
        assert.ok(warning.message.includes('接入已取消'));
        assert.ok(warning.message.includes('凭据可能残留'));
        assert.equal(warning.message.includes('已清理本次写入'), false);
        assert.equal(mod.modelDialog.open, false);
    };
    await cancelWithRelease({ cleared: false }, 200);
    await cancelWithRelease({ cleared: false, reason: 'read_failed' }, 200);
    await cancelWithRelease({ cleared: false }, 500);
});

test('W4: a canceled older apply cannot release the key of a newer successful apply', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    queryFixtures.models = {
        items: [
            { name: 'model-a', protocol_faces: ['chat'] },
            { name: 'model-b', protocol_faces: ['chat'] },
        ],
    };
    const gateA = makeDeferred();
    const gateB = makeDeferred();
    queryFixtures.applyGateQueue = [gateA, gateB];
    await mod.refreshModels();
    await settle();

    // 接入 A 在途 → 取消 → 立刻接入 B（W8：B 排队等待 A 完全落定）。
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].model, 'model-a');
    mod.modelDialogCancel.click();
    modelRow('model-b').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1, 'B waits for A to settle');
    assert.equal(mod.modelDialog.open, true);
    assert.equal(mod.modelDialogConfirm.disabled, true);

    // A 的迟到成功先到：未清理（当前 URL 仍指向网关），随后 B 才开始。
    gateA.resolve();
    await settle();
    assert.equal(applyCalls.length, 2);
    assert.equal(applyCalls[1].model, 'model-b');
    assert.equal(releaseCalls.length, 0, 'stale success must not clear the newer apply key');
    assert.equal(mod.modelDialog.open, true);
    assert.equal(mod.modelDialogConfirm.disabled, true);
    assert.ok(lastToast('warning').message.includes('仍指向网关'));

    // B 成功：source 切换、key 写入，且没有被 A 的清理删掉。
    gateB.resolve();
    await settle();
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'custom');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-b');
    assert.equal(releaseCalls.length, 0);
});

test('W6: an obsolete apply response does not close or reset a newer confirmation', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    queryFixtures.models = {
        items: [
            { name: 'model-a', protocol_faces: ['chat'] },
            { name: 'model-b', protocol_faces: ['chat'] },
        ],
    };
    const gateA = makeDeferred();
    const gateB = makeDeferred();
    queryFixtures.applyGateQueue = [gateA, gateB];
    await mod.refreshModels();
    await settle();

    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    mod.modelDialogCancel.click();
    modelRow('model-b').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(applyCalls.length, 1, 'B waits for A');
    assert.equal(mod.modelDialog.open, true, 'newer dialog is open');
    assert.equal(mod.modelDialogConfirm.disabled, true, 'newer apply is pending');

    // A 的迟到成功先于 B 发送：不得关闭/重置 B 的弹窗，也不得让 B 的世代失效。
    gateA.resolve();
    await settle();
    assert.equal(applyCalls.length, 2, 'B starts after A releases the queue');
    assert.equal(mod.modelDialog.open, true, 'stale response must not close the newer dialog');
    assert.equal(mod.modelDialogConfirm.disabled, true, 'stale response must not re-enable the newer confirm');

    gateB.resolve();
    await settle();
    assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'custom');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-b');
    assert.equal(mod.modelDialog.open, false);
    assert.equal(releaseCalls.length, 0);
});

test('W7: canceling during the settings save restores the user Custom URL before any credential write', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    globalThis.document.nativeInputs.custom_api_url_text.value = 'https://third-party.example/v1';
    globalThis.document.nativeInputs.custom_model_id.value = 'user-model';
    const saveGate = makeDeferred();
    queryFixtures.saveGate = saveGate.promise;
    await mod.refreshModels();
    await settle();

    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    // 保存尚未落盘，尚未请求 /apply-model。
    assert.equal(applyCalls.length, 0);
    assert.equal(mod.modelDialogConfirm.disabled, true);

    mod.modelDialogCancel.click();
    saveGate.resolve();
    await settle();

    // W8：没有更新的预设/接入接管 → 恢复确认前设置；用户自有 key 不会
    // 留在“URL 已指向网关”的状态下被下一次生成发往网关。
    assert.equal(applyCalls.length, 0);
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://third-party.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
    assert.equal(globalThis.document.nativeInputs.custom_api_url_text.value, 'https://third-party.example/v1');
    assert.equal(globalThis.document.nativeInputs.custom_model_id.value, 'user-model');
    assert.equal(mod.modelDialog.open, false);
    assert.ok(lastToast('warning').message.includes('已恢复原 Custom 设置'));
});

test('W8b: a preset change that does not own custom_url still restores the pre-apply settings', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    const saveGate = makeDeferred();
    queryFixtures.saveGate = saveGate.promise;
    await mod.refreshModels();
    await settle();

    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    // 预设切换但不携带 custom_url：ST 不会覆盖 URL，网关 URL 仍是本次流程写的。
    mod.onPresetChanged({
        apiId: 'openai',
        name: 'Preset B',
        preset: { temperature: 1 },
        settings: { bind_preset_to_connection: true },
    });
    saveGate.resolve();
    await settle();

    assert.equal(applyCalls.length, 0);
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://third-party.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
    assert.ok(lastToast('warning').message.includes('已恢复原 Custom 设置'));
});

test('W9: logout clears a gateway Custom URL after the plugin key is removed', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    await mod.refreshStatus();
    await settle();
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');

    queryFixtures.logout = { status: 'logged_out', remote_revoked: true, local_cleared: true };
    queryFixtures.status = { ...statusPayload(), state: 'not_connected' };
    delete queryFixtures.status.username;
    await mod.doLogout();
    await settle();

    // ST deleteSecret 可能重新激活用户自有 key；清空网关 URL/model，避免
    // 该 key 被发往网关。插件不猜恢复旧 URL。
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');
    assert.equal(globalThis.document.nativeInputs.custom_api_url_text.value, '');
    assert.equal(globalThis.document.nativeInputs.custom_model_id.value, '');
    assert.equal(ctx.extensionSettings.apercusGateway?.modelApplyBaseline, undefined);
    assert.ok(mod.els.loginNote.textContent.includes('已清空指向网关的 Custom URL/模型'));
});

test('W9b: logout without a baseline clears the gateway Custom URL instead of leaving it', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    ctx.chatCompletionSettings.custom_url = 'https://api.apercus.ai/v1';
    ctx.chatCompletionSettings.custom_model = 'old-model';
    await mod.refreshStatus();
    await settle();
    queryFixtures.logout = { status: 'logged_out', remote_revoked: true, local_cleared: true };
    queryFixtures.status = { ...statusPayload(), state: 'not_connected' };
    delete queryFixtures.status.username;
    await mod.doLogout();
    await settle();

    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');
    assert.equal(globalThis.document.nativeInputs.custom_api_url_text.value, '');
    assert.equal(globalThis.document.nativeInputs.custom_model_id.value, '');
});

test('W10: login_invalidated clears Custom settings based on custom_cleared and gateway URL variants', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    ctx.chatCompletionSettings.custom_url = 'https://api.apercus.ai/v1';
    ctx.chatCompletionSettings.custom_model = 'model-a';

    // Custom 清理失败：残留的网关 key 不能与任何地址配对，强制清空 URL。
    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: false,
        custom_cleared: false,
    };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');

    // Custom 已清 + 非规范写法的网关 URL（尾斜杠）仍必须按网关识别并清空。
    ctx.chatCompletionSettings.custom_url = 'https://api.apercus.ai/v1/';
    ctx.chatCompletionSettings.custom_model = 'model-b';
    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: false,
        custom_cleared: true,
    };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');

    // Custom 已清 + 用户自己的第三方 URL：保留用户配置，不清空。
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://third-party.example/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');

    // 非规范网关变体（http + 非默认端口）也必须清空。
    ctx.chatCompletionSettings.custom_url = 'http://api.apercus.ai:8080/v1';
    ctx.chatCompletionSettings.custom_model = 'model-c';
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, '');

    // 非字符串 URL：清理失败路径必须强制清空，不能因类型异常放行。
    ctx.chatCompletionSettings.custom_url = ['https://evil.example/v1'];
    ctx.chatCompletionSettings.custom_model = 'model-d';
    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: false,
        custom_cleared: false,
    };
    delete queryFixtures.status.username;
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');

    // Custom 清理未确认时，即使 source 不是 custom 也强制清空 URL。
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    ctx.chatCompletionSettings.custom_url = 'https://third-party.example/v1';
    await mod.refreshStatus();
    await settle();
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
});

test('W10c: a login-invalid apply response refreshes status and clears the gateway Custom URL', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'custom';
    ctx.chatCompletionSettings.custom_url = 'https://api.apercus.ai/v1';
    ctx.chatCompletionSettings.custom_model = 'model-a';
    await mod.refreshStatus();
    await settle();
    await mod.refreshModels();
    await settle();
    queryFixtures.applyStatus = 409;
    queryFixtures.apply = { error: { code: 'not_connected', message: '登录已失效' } };
    queryFixtures.status = {
        ...statusPayload(),
        state: 'invalid',
        reason: 'login_invalidated',
        local_cleared: false,
        custom_cleared: false,
    };
    delete queryFixtures.status.username;
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(mod.state.status.value.state, 'invalid');
    assert.equal(ctx.chatCompletionSettings.custom_url, '');
    assert.equal(ctx.chatCompletionSettings.custom_model, '');
});

test('W5: successful apply syncs the native Custom URL and model display fields', async () => {
    resetAll();
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    globalThis.document.nativeInputs.custom_api_url_text.value = 'https://old-third-party.example/v1';
    globalThis.document.nativeInputs.custom_model_id.value = 'old-model';
    await mod.refreshStatus();
    await settle();
    await mod.refreshModels();
    await settle();
    modelRow('model-a').click();
    mod.modelDialogConfirm.click();
    await settle();

    assert.equal(globalThis.document.nativeInputs.custom_api_url_text.value, 'https://api.apercus.ai/v1');
    assert.equal(globalThis.document.nativeInputs.custom_model_id.value, 'model-a');
    assert.equal(ctx.chatCompletionSettings.custom_url, 'https://api.apercus.ai/v1');
    assert.equal(ctx.chatCompletionSettings.custom_model, 'model-a');
});

// ===== I7：保存不确定时 fail-closed =====

test('I7: uncertain settings persistence (degraded host) aborts before writing any credential', async () => {
    resetAll();
    ctx.chatCompletionSettings.custom_url = 'https://user.example/v1';
    ctx.chatCompletionSettings.custom_model = 'user-model';
    ctx.chatCompletionSettings.chat_completion_source = 'openai';
    // 无 saveSettings 的降级宿主：模块加载时捕获的 nativeSaveSettings 为 null，
    // persistSettings 走 saveSettingsDebounced + 250ms，返回 uncertain:true。
    globalThis.__AG_TEST_NATIVE_SAVE_SETTINGS__ = null;
    let legacy = null;
    try {
        legacy = await loadUiModule();
        legacy.init();
        await settle();
        assert.equal(legacy.state.status && legacy.state.status.ok, true);
        await legacy.refreshModels();
        await settle();
        const row = legacy.els.modelsList.children
            .find((child) => textOf(child).includes('model-a'));
        assert.ok(row, 'model row rendered');
        row.click();
        legacy.modelDialogConfirm.click();
        // 降级路径固定等待 250ms 后才判定 uncertain。
        await new Promise((resolve) => setTimeout(resolve, 400));
        await settle();

        assert.equal(applyCalls.length, 0, 'no /apply-model call');
        assert.equal(ctx.chatCompletionSettings.custom_url, 'https://user.example/v1');
        assert.equal(ctx.chatCompletionSettings.custom_model, 'user-model');
        assert.equal(ctx.chatCompletionSettings.chat_completion_source, 'openai');
        assert.ok(lastToast('warning').message.includes('无法确认设置已保存'));
        assert.ok(lastToast('warning').message.includes('未写入凭据'));
        assert.equal(legacy.modelDialogConfirm.disabled, false);
        legacy.cleanupTimers();
    } finally {
        globalThis.__AG_TEST_NATIVE_SAVE_SETTINGS__ = defaultNativeSave;
    }
});
