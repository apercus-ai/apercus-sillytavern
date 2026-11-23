/**
 * Apercus Gateway — SillyTavern UI extension.
 *
 * Source-checked against SillyTavern 1.17.0 files only (st-context.js getContext,
 * events.js event names, openai.js custom source, chat-completions.js custom
 * URL assembly and json_schema mapping, script.js context budget, preset-manager.js
 * preset objects, #leftSendForm). It has been loaded and smoke-tested in a
 * local SillyTavern 1.17.0 instance; smoke is not acceptance, and other
 * versions are not checked.
 *
 * Current boundary:
 * - Reads: /api/plugins/apercus-gateway status, connect/status, keys, models,
 *   balance. Keys/models/balance are query-surface passthroughs (the login
 *   credential stays server-side).
 * - B1 v3 connect: POST /connect returns only {status, authorize_url}; the
 *   browser opens the whitelisted gateway authorize page and polls
 *   GET /connect/status every 5s. Authorized is not connected; the tavern
 *   connection state is never claimed by the plugin.
 * - B3 key/model selection: the key list is display-only (masked, never a
 *   plaintext key). Selecting a chat-face model opens a confirm dialog; on
 *   confirm the UI writes custom_url/custom_model and saves, then the server
 *   writes api_key_custom; if the server refuses, the UI rolls both settings
 *   back. The chat completion source is switched only after server success and
 *   through ST's native source entry (direct assignment only as a no-jQuery
 *   fallback). B2 planning reuses the same custom_model.
 * - B3 metering: balance rows plus H/K (display-only) and an estimated context
 *   meter (used / limit) colored against H. Estimation never blocks generation.
 * - B2 anti-truncation (default off): a manual two-call flow (section list, then
 *   numbered structural layers) uses the plugin /plan route; injection writes only
 *   the two request-scoped apercus_antitrunc keys into custom_include_body at
 *   CHAT_COMPLETION_SETTINGS_READY. No fallback list, no silent default.
 * - All remote strings are assigned with textContent. No HTML string sinks,
 *   no browser storage, and no credentials or raw keys are persisted.
 */

import { getContext } from '../../../extensions.js';
// ST 1.17.0 public/script.js:7943 `export async function saveSettings(loopCounter)`
// 是真正落盘的入口（失败在内部 toast，不抛出）；st-context 只暴露
// saveSettingsDebounced。G2：写 custom_url/custom_model 后必须 await 它，并用
// SETTINGS_UPDATED 事件确认保存成功，再请求服务端写 Custom key。
import { saveSettings as nativeSaveSettings } from '../../../../script.js';
import * as L from './logic.mjs';

const ROUTE = '/api/plugins/apercus-gateway';
const STATUS_KEYS = L.STATUS_PROTOCOLS;
const PLAN_TIMEOUT_MS = 30000;

const state = {
    status: null,
    statusError: null,
    keys: null,
    keysError: null,
    models: null,
    modelsError: null,
    balance: null,
    balanceError: null,
    keysPending: false,
    modelsPending: false,
    balancePending: false,
    contextMeter: { used: null, max: null },
    wasAuthorized: false,
    connectPending: false,
    connectPolling: false,
    connectPollInFlight: false,
    connectPollTimer: null,
    connectStatus: null,
    connectError: null,
    // G7：授权态下的周期 /status 刷新（触发服务端 1h 机会式探活/续期）。
    statusRefreshTimer: null,
    // G11：自动开窗被浏览器拦截 → true；轮询期间保留回退提示不被覆盖。
    connectFallback: false,
    // G2：保存路径降级（无 script.js saveSettings / 无法确认 SETTINGS_UPDATED）。
    settingsSaveUncertain: false,
    // H4：最近一次 authorized 观察到的账号标识（服务端 /status 的 username；
    // 不含登录凭据）与连接世代计数。username 变化或重新进入授权态时世代 +1，
    // 清空 keys/models/balance/上下文缓存并重新拉取；旧世代在途响应丢弃。
    authIdentity: null,
    authGeneration: 0,
};

// 连接按钮旁的用户披露（规格：30 天有效期 + 门户断开指引）。
const CONNECT_DISCLOSURE = '登录有效期最长 30 天，到期需重新网页授权；断开插件请到门户“退出所有酒馆插件”。';
const CONNECT_POLL_MS = 5000;

// B2 防截断分节运行态：全部内存态。开关默认关、不持久化。
const antitrunc = {
    supported: false,
    enabled: false,
    generating: false,
    evaluating: false,
    evaluatePending: false,
    // 已经为哪个分层指纹跑过调用二：避免同一预设内容反复触发自动重分层。
    rerunLayered: null,
    // 生成期间预设被切换：完成后重新评估当前预设。
    refreshAfterGeneration: false,
    // 生成失败标记（面板五态之一）；成功后清除。
    generationFailed: false,
    // 守卫警告（最终请求形态触发弃臂）；状态条常驻，toast 仅首次。
    guardBlocked: false,
    guardReason: null,
    guardToastShown: false,
    // 最近一次成功写入的完整 custom_include_body；只存内存，用于识别插件旧键。
    lastInjectedBody: null,
    // max_tokens 地板提示的一次性 toast 去重值。
    floorToastValue: null,
    presetName: null,
    sections: null,
    layers: null,
    // 当前结构指纹 / 当前分层指纹 / 当前 sections 对应的缓存键。
    structuralFingerprint: null,
    layeredFingerprint: null,
    sectionsKey: null,
    cacheHit: false,
    fingerprintExpired: false,
    suggestedMaxTokens: null,
    // F11/H2：本地是否已知插件写过 Custom key（true/false；null＝未知）。仅作
    // 展示/诊断缓存，不作为 /release-custom-key 的跳过快路径——非网关 URL 时
    // 始终由服务端按信封归属幂等清理（跨标签页的 false 会漏清）。
    customKeyPresent: null,
    cleanupInFlight: false,
    cleanupPromise: null,
    cleanupAttemptUrl: null,
    cleanupAttemptAt: 0,
};

let ctx = null;
let els = null;
let infoDialog = null;
let infoOpener = null;
let evaluateSeq = 0;
// H4：/status 响应序号；只接受最新一次请求的结果，避免旧账号的迟到状态
// 覆盖新账号（账号切换判定本身来自 /status）。
let statusRequestSeq = 0;
let modelRequestSeq = 0;
// W8：预设应用计数。接入等待期间预设被切换时，旧快照不得回滚覆盖新预设。
let presetChangeSeq = 0;
// W8b：最近一次预设切换是否显式携带并应用 custom_url（预设拥有 URL 时
// 不恢复旧快照；预设未改 URL 时，本次流程写入的网关 URL 可以安全回滚）。
let presetOwnsCustomUrl = false;
// W8：/apply-model 串行队列。两个确认重叠时，后者等前者完全落定（含回滚/
// 取消清理）后再读取设置，避免旧流程的恢复动作覆盖新流程、或旧响应清理新 key。
let applyQueueTail = Promise.resolve();
let modelDialog = null;
let modelDialogLine = null;
let modelDialogSourceLine = null;
let modelDialogConfirm = null;
let modelDialogCancel = null;
let modelDialogName = null;
let modelDialogSwitchSource = false;
let modelOpener = null;

// F7：ST 1.17.0 的 getContext() 每次返回新对象、onlineStatus / oai_settings 等
// 是值快照。渲染/计量前重新取一次，避免把启动时的旧状态永久缓存。
function refreshCtx() {
    try {
        const fresh = getContext();
        if (fresh && typeof fresh === 'object') ctx = fresh;
    } catch {
        // 取上下文失败沿用现有 ctx；渲染仍以 fail-closed 显示未知。
    }
    return ctx;
}

function freshChatSettings() {
    refreshCtx();
    return ctx && isPlainObj(ctx.chatCompletionSettings) ? ctx.chatCompletionSettings : null;
}

function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function isPlainObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildPanel() {
    const root = h('div', 'extension_container ag-root');
    const panel = h('section', 'ag-panel inline-drawer-content');
    panel.id = 'apercus_gateway_panel';
    panel.setAttribute('aria-labelledby', 'apercus_gateway_title');
    panel.tabIndex = -1;

    const header = h('div', 'ag-header');
    const heading = h('h4', 'ag-title');
    heading.id = 'apercus_gateway_title';
    heading.textContent = 'Apercus Gateway';
    const stamp = h('span', 'ag-stamp', 'APERCUS');
    const dot = h('span', 'ag-dot ag-dot-unknown');
    dot.setAttribute('aria-hidden', 'true');
    header.append(heading, stamp, dot);

    // 与 ST 其他扩展一致：整块放进 inline-drawer，标题栏可点击收起/展开。
    const drawer = h('div', 'inline-drawer ag-drawer');
    const headerToggle = h('div', 'inline-drawer-toggle inline-drawer-header');
    headerToggle.setAttribute('role', 'button');
    headerToggle.setAttribute('tabindex', '0');
    headerToggle.setAttribute('aria-expanded', 'false');
    headerToggle.setAttribute('aria-labelledby', 'apercus_gateway_title');
    const drawerIcon = h('div', 'fa-solid fa-circle-chevron-down inline-drawer-icon down');
    drawerIcon.setAttribute('aria-hidden', 'true');
    headerToggle.append(header, drawerIcon);
    drawer.append(headerToggle, panel);

    const statusLine = h('p', 'ag-status');
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');
    statusLine.textContent = '正在读取插件状态…';

    const protocolLine = h('div', 'ag-protocols');
    const chips = {};
    for (const face of STATUS_KEYS) {
        const chip = h('span', 'ag-chip', `${face}：未加载`);
        chips[face] = chip;
        protocolLine.append(chip);
    }

    const authRow = h('div', 'ag-auth');
    const loginButton = h('button', 'menu_button ag-btn', '连接 Apercus');
    loginButton.type = 'button';
    loginButton.id = 'apercus_gateway_login';
    const logoutButton = h('button', 'menu_button ag-btn', '退出登录');
    logoutButton.type = 'button';
    logoutButton.hidden = true;
    const loginNote = h('span', 'ag-note');
    // G11：授权页被浏览器拦截时的回退入口（只在地址通过白名单后写入 href）。
    const connectLink = h('a', 'ag-note ag-connect-link', '打开网关授权页');
    connectLink.hidden = true;
    connectLink.target = '_blank';
    connectLink.rel = 'noopener noreferrer';
    const connectHint = h('p', 'ag-note ag-connect-hint', CONNECT_DISCLOSURE);
    authRow.append(loginButton, logoutButton, loginNote);
    const authBlock = h('div', 'ag-auth-block', '');
    authBlock.append(authRow, connectLink, connectHint);

    const actions = h('div', 'ag-actions');
    const keysButton = h('button', 'menu_button ag-btn', '刷新 Key');
    keysButton.type = 'button';
    const modelsButton = h('button', 'menu_button ag-btn', '刷新模型');
    modelsButton.type = 'button';
    const balanceButton = h('button', 'menu_button ag-btn', '刷新额度');
    balanceButton.type = 'button';
    const infoButton = h('button', 'menu_button ag-btn', '说明');
    infoButton.type = 'button';
    actions.append(keysButton, modelsButton, balanceButton, infoButton);

    const keysTitle = h('h5', 'ag-section-title', 'Key 列表（只读）');
    const keysList = h('div', 'ag-list ag-key-list');
    const keysNote = h('p', 'ag-note', '登录后可用。');

    const modelsTitle = h('h5', 'ag-section-title', '选择模型（Custom 源）');
    const modelsList = h('div', 'ag-list');
    const modelsNote = h('p', 'ag-note', '登录后可用。');

    const balanceTitle = h('h5', 'ag-section-title', '额度（只读快照）');
    const balanceList = h('div', 'ag-list');
    const balanceNote = h('p', 'ag-note');

    const meterTitle = h('h5', 'ag-section-title', '上下文用量（估算）');
    const meterLine = h('p', 'ag-meter', '登录后可用。');
    meterLine.id = 'apercus_gateway_context_meter';
    meterLine.setAttribute('role', 'status');
    meterLine.setAttribute('aria-live', 'polite');
    const meterNote = h('p', 'ag-note', '估算值：网关按可信输入 token 计费，严格大于阈值才追加。');

    const antitruncSection = antitrunc.supported ? buildAntitruncSection() : null;

    const boundary = h('p', 'ag-boundary');
    boundary.textContent = '连接走网关官方网页授权（v1.35 草稿存根）；「已授权」不等于「已连接」，酒馆连接状态以酒馆自身结果为准。Key 列表只显示名称/脱敏标识/状态，不显示明文；选择模型经确认后才由插件服务端写入 Custom 源 key，并在确认后写 custom_url / custom_model（不偷偷改 source）。防截断分节默认关闭，只写请求级注入键。';

    const version = h('p', 'ag-version');
    version.textContent = '版本说明：已按 SillyTavern 1.17.0 源码核对，并在本地 1.17.0 实例做过安装加载冒烟（非验收）；不声明支持其他版本。';

    panel.append(
        statusLine,
        protocolLine,
        authBlock,
        actions,
        keysTitle,
        keysNote,
        keysList,
        modelsTitle,
        modelsNote,
        modelsList,
        balanceTitle,
        balanceNote,
        balanceList,
        meterTitle,
        meterLine,
        meterNote,
    );
    if (antitruncSection) panel.append(antitruncSection.wrap);
    panel.append(boundary, version);
    root.append(drawer);

    // ST 在 document 上监听 .inline-drawer-toggle 并执行 slideToggle；这里只
    // 补键盘操作与 aria-expanded 同步（等 ST 更新完 icon class 再读状态）。
    const syncDrawerAria = () => {
        headerToggle.setAttribute(
            'aria-expanded',
            drawerIcon.classList.contains('up') ? 'true' : 'false',
        );
    };
    headerToggle.addEventListener('click', () => {
        window.setTimeout(syncDrawerAria, 0);
    });
    drawer.addEventListener('inline-drawer-toggle', () => {
        window.setTimeout(syncDrawerAria, 0);
    });
    headerToggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            headerToggle.click();
        }
    });

    loginButton.addEventListener('click', () => { void doConnect(); });
    logoutButton.addEventListener('click', () => { void doLogout(); });
    keysButton.addEventListener('click', () => { void refreshKeys(); });
    modelsButton.addEventListener('click', () => { void refreshModels(); });
    balanceButton.addEventListener('click', () => { void refreshBalance(); });
    infoButton.addEventListener('click', () => openInfo(infoButton));

    return {
        root,
        drawer,
        headerToggle,
        drawerIcon,
        panel,
        statusLine,
        dot,
        chips,
        loginButton,
        logoutButton,
        loginNote,
        connectLink,
        connectHint,
        keysButton,
        modelsButton,
        balanceButton,
        keysNote,
        keysList,
        modelsNote,
        modelsList,
        balanceNote,
        balanceList,
        meterTitle,
        meterLine,
        meterNote,
        ...(antitruncSection || {}),
    };
}

// 防截断分节面板：开关默认关；状态条五态；生成按钮手动触发；当前清单展示。
function buildAntitruncSection() {
    const wrap = h('div', 'ag-antitrunc');

    const title = h('h5', 'ag-section-title', '防截断分节');
    const toggleRow = h('label', 'ag-antitrunc-toggle');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'apercus_gateway_antitrunc_toggle';
    toggle.checked = false;
    const toggleText = h('span', null, '启用注入（默认关闭）');
    toggleRow.append(toggle, toggleText);

    const statusLine = h('p', 'ag-antitrunc-state');
    statusLine.id = 'apercus_gateway_antitrunc_state';
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');

    const note = h('p', 'ag-antitrunc-note');
    note.setAttribute('role', 'status');
    note.hidden = true;

    const actions = h('div', 'ag-actions');
    const button = h('button', 'menu_button ag-btn', '生成节名单');
    button.type = 'button';
    button.disabled = true;
    const suggest = h('button', 'menu_button ag-btn', '应用建议值');
    suggest.type = 'button';
    suggest.hidden = true;
    const cost = h('span', 'ag-note', L.ANTITRUNC_COST_HINT);
    actions.append(button, suggest, cost);

    const listTitle = h('p', 'ag-note', '当前清单：');
    const list = h('div', 'ag-antitrunc-sections');

    wrap.append(title, toggleRow, statusLine, note, actions, listTitle, list);

    toggle.addEventListener('change', onAntitruncToggleChange);
    button.addEventListener('click', () => { void generateSections(); });
    suggest.addEventListener('click', applySuggestedMaxTokens);

    return {
        wrap,
        antitruncToggle: toggle,
        antitruncState: statusLine,
        antitruncNote: note,
        antitruncButton: button,
        antitruncSuggest: suggest,
        antitruncCost: cost,
        antitruncSections: list,
    };
}

function buildQuickButton() {
    const button = h('button', 'menu_button ag-quick');
    button.type = 'button';
    button.id = 'apercus_gateway_quick';
    button.title = 'Apercus Gateway 状态与模型';
    button.setAttribute('aria-label', 'Apercus Gateway');
    const label = h('span', 'ag-quick-label', 'Apercus');
    button.append(label);
    button.addEventListener('click', openPanel);
    return button;
}

function attach() {
    const settings = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2')
        || document.body;
    const built = buildPanel();
    settings.append(built.root);
    els = built;

    const leftSendForm = document.getElementById('leftSendForm');
    const quick = buildQuickButton();
    if (leftSendForm && leftSendForm.parentElement) {
        leftSendForm.parentElement.insertBefore(quick, leftSendForm.nextSibling);
    } else {
        quick.hidden = true;
    }
    els.quick = quick;

    buildInfoDialog();
    buildModelDialog();
    renderAntitrunc();
    void refreshStatus();
}

function buildInfoDialog() {
    infoDialog = document.createElement('dialog');
    infoDialog.className = 'ag-dialog';
    const title = h('h4', 'ag-title', 'Apercus Gateway 边界说明');
    title.id = 'apercus_gateway_info_title';
    infoDialog.setAttribute('aria-labelledby', title.id);
    const body = h('div', 'ag-dialog-body');
    for (const line of [
        '状态、Key 列表、模型目录和额度来自同源插件 /api/plugins/apercus-gateway（网关 v1.35 查询面），只读展示。',
        '连接 Apercus：插件服务端发起网关连接请求，浏览器打开固定网关域（gw.apercus.ai）的官方授权页；用户在网页上允许后插件自动完成连接。登录有效期最长 30 天，到期需重新网页授权；断开插件请到门户“退出所有酒馆插件”。',
        '“已授权”不等于“已连接”：酒馆连接状态以酒馆自身结果为准；连接成功后插件不会另设判定。',
        'Key 列表只显示名称、脱敏标识和状态，不含明文 key；插件不提供手填 key 输入框，也不使用共享 key。',
        '选择模型：确认弹窗之后，UI 先写 custom_url=https://api.apercus.ai/v1 与 custom_model 并保存，再请求插件服务端把当前网关 key 写入酒馆 Custom 源凭据（api_key_custom）。只有服务端明确拒绝（4xx 或完全未写）才回滚 custom_url/custom_model；写入部分成功、超时或其他 5xx 视为结果未知，保留网关 URL 并提示重试/退出登录清理（避免回滚到可能已收到 key 的第三方源）。只有用户在弹窗中确认“切换为 Custom”且服务端成功后，才通过酒馆原生切换入口改 chat_completion_source（不会偷偷改 source）。Custom 源 URL 由酒馆自行追加 /chat/completions。',
        '计量：余额与 H/K 只展示；K 为毫率，仅作说明，插件不做追加额计算。上下文用量为估算值，按 H 的 90%/100% 着色，不参与计费判定。',
        '防截断分节（默认关闭）：手动生成节名单需要已授权与模型；两次 /plan 调用会消耗少量额度。注入只写 custom_include_body 的 apercus_antitrunc 两键，节名单与分层明文保存在扩展设置，不含任何凭据。',
        '生成节名单会把脱敏后的预设摘要与条目内容发送到固定网关域名；脱敏非穷尽，预设内残留的凭据由用户自行承担。',
        '网关 key 与插件登录凭据只写 SillyTavern 服务端密钥库（按用户目录隔离）；浏览器不保存、不回显任何原始 key 或登录凭据。',
        '按 SillyTavern 1.17.0 源码核对（2026-11-23），并在本地 1.17.0 实例做过安装加载冒烟（非验收）；不声明支持其他版本。',
    ]) {
        body.append(h('p', 'ag-dialog-line', line));
    }
    const close = h('button', 'menu_button ag-btn', '关闭');
    close.type = 'button';
    infoDialog.append(title, body, close);
    document.body.append(infoDialog);

    close.addEventListener('click', () => infoDialog.close());
    infoDialog.addEventListener('close', () => {
        if (infoOpener && typeof infoOpener.focus === 'function') infoOpener.focus();
        infoOpener = null;
    });
}

function openInfo(opener) {
    if (!infoDialog) return;
    infoOpener = opener || null;
    if (!infoDialog.open) infoDialog.showModal();
    const close = infoDialog.querySelector('button');
    if (close) close.focus();
}

// ===== B3 模型选择：确认弹窗 =====
// 点选目录行 → 确认弹窗（模型名 + 是否切换 source 的明确说明）。取消不写任何
// 设置；确认后先调服务端 /apply-model 写 Custom 源 key，成功后才由 UI 写
// custom_url / custom_model /（确认过的）chat_completion_source。
function buildModelDialog() {
    modelDialog = document.createElement('dialog');
    modelDialog.className = 'ag-dialog';
    const title = h('h4', 'ag-title', '选择模型');
    title.id = 'apercus_gateway_model_title';
    modelDialog.setAttribute('aria-labelledby', title.id);
    const body = h('div', 'ag-dialog-body');
    modelDialogLine = h('p', 'ag-dialog-line');
    modelDialogSourceLine = h('p', 'ag-dialog-line');
    const noteLine = h('p', 'ag-dialog-line', '确认后 UI 先写 custom_url 与 custom_model 并保存，再由插件服务端把网关 key 写入酒馆 Custom 源（浏览器不显示、不保存明文 key）。服务端明确拒绝时回滚这两个设置；结果未知（部分写入/超时/其他错误）时保留网关 URL 并提示重试或退出登录清理，不回滚到可能已收到 key 的第三方源。“已授权”不等于“已连接”，连接结果以酒馆自身状态为准；目录展示不代表协议适配已接通。');
    body.append(modelDialogLine, modelDialogSourceLine, noteLine);
    const actions = h('div', 'ag-dialog-actions');
    modelDialogConfirm = h('button', 'menu_button ag-btn', '确认选择');
    modelDialogConfirm.type = 'button';
    modelDialogCancel = h('button', 'menu_button ag-btn', '取消');
    modelDialogCancel.type = 'button';
    actions.append(modelDialogConfirm, modelDialogCancel);
    modelDialog.append(title, body, actions);
    document.body.append(modelDialog);

    modelDialogCancel.addEventListener('click', () => {
        // I3：同步作废在途确认——close 事件的派发是异步任务，/apply-model
        // 响应可能先到；不能等 close 事件才识别“用户已取消”。
        modelRequestSeq += 1;
        modelDialog.close();
    });
    modelDialog.addEventListener('cancel', () => {
        // Esc 关闭：cancel 事件先于 close 派发，同样作废在途确认。
        modelRequestSeq += 1;
    });
    modelDialogConfirm.addEventListener('click', () => { void applyModelSelection(); });
    modelDialog.addEventListener('close', () => {
        // I3：关闭弹窗即作废在途确认（等待 /apply-model 返回后不得再切源）。
        modelRequestSeq += 1;
        if (modelOpener && typeof modelOpener.focus === 'function') modelOpener.focus();
        modelOpener = null;
        modelDialogName = null;
        modelDialogSwitchSource = false;
    });
}

function openModelDialog(modelName, opener) {
    if (!modelDialog || !modelDialogLine) return;
    const settings = freshChatSettings();
    if (!settings) {
        agToast('warning', '无法读取酒馆对话补全设置，模型选择不可用。');
        return;
    }
    modelOpener = opener || null;
    modelDialogName = modelName;
    modelRequestSeq += 1;
    modelDialogSwitchSource = settings.chat_completion_source !== 'custom';
    modelDialogLine.textContent = `模型：${modelName}`;
    modelDialogSourceLine.textContent = modelDialogSwitchSource
        ? '当前对话补全源不是 Custom；确认后将切换对话补全源为 Custom（仅此处确认后才切换）。'
        : '当前对话补全源已是 Custom；确认后不改动 source。';
    modelDialogConfirm.disabled = false;
    modelDialogConfirm.textContent = '确认选择';
    if (!modelDialog.open) modelDialog.showModal();
    modelDialogConfirm.focus();
}

// U1：确认后的设置写入顺序 = 先写 custom_url/custom_model 并保存，再调
// /apply-model 让服务端写 api_key_custom；服务端失败则回滚这两个键到原值。
// source 切换只在服务端确认成功后发生，且走 ST 原生入口（#chat_completion_source
// 的 change 处理器）；无 jQuery 的极简环境才直接赋值（同样只在确认后）。
function snapshotModelSettings(settings) {
    return {
        customUrl: Object.hasOwn(settings, 'custom_url') ? settings.custom_url : undefined,
        customUrlOwn: Object.hasOwn(settings, 'custom_url'),
        customModel: Object.hasOwn(settings, 'custom_model') ? settings.custom_model : undefined,
        customModelOwn: Object.hasOwn(settings, 'custom_model'),
    };
}

function restoreModelSettings(settings, snapshot) {
    if (snapshot.customUrlOwn) settings.custom_url = snapshot.customUrl;
    else delete settings.custom_url;
    if (snapshot.customModelOwn) settings.custom_model = snapshot.customModel;
    else delete settings.custom_model;
}

// G2：真正落盘的保存。ST 1.17.0 saveSettings 内部吞掉失败（只 toast），唯一
// 可观测的成功信号是它 await 的 SETTINGS_UPDATED 事件；监听器在保存前复位，
// 保存调用结束后仍未见到事件就按“未确认保存”处理（不请求服务端写 key）。
// 没有 script.js saveSettings 的环境才退回 saveSettingsDebounced + 短延迟，
// 并标记 uncertain（不再声称已落盘）。
let settingsUpdatedSeen = false;
let settingsUpdatedListenerBound = false;

function ensureSettingsUpdatedListener() {
    if (settingsUpdatedListenerBound) return;
    const events = ctx && ctx.event_types;
    if (isPlainObj(events) && typeof events.SETTINGS_UPDATED === 'string'
        && ctx.eventSource && typeof ctx.eventSource.on === 'function') {
        ctx.eventSource.on(events.SETTINGS_UPDATED, () => { settingsUpdatedSeen = true; });
        settingsUpdatedListenerBound = true;
    }
}

async function persistSettings() {
    const nativeSave = typeof nativeSaveSettings === 'function' ? nativeSaveSettings : null;
    if (nativeSave) {
        ensureSettingsUpdatedListener();
        settingsUpdatedSeen = false;
        try {
            await nativeSave();
        } catch {
            return { ok: false, uncertain: false, reason: 'save_failed' };
        }
        if (settingsUpdatedListenerBound) {
            return settingsUpdatedSeen
                ? { ok: true, uncertain: false }
                : { ok: false, uncertain: false, reason: 'save_unconfirmed' };
        }
        // 事件类型缺失（非 1.17 宿主）：await 仍是唯一可用的顺序保证。
        return { ok: true, uncertain: true };
    }
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        try {
            ctx.saveSettingsDebounced();
        } catch {
            return { ok: false, uncertain: false, reason: 'save_failed' };
        }
        await new Promise((resolve) => { window.setTimeout(resolve, 250); });
        return { ok: true, uncertain: true };
    }
    return { ok: false, uncertain: false, reason: 'save_unavailable' };
}

function saveSettingsDebouncedLocal() {
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function getJQuery() {
    const candidates = [
        globalThis.window && globalThis.window.jQuery,
        globalThis.window && globalThis.window.$,
        globalThis.jQuery,
        globalThis.$,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'function') return candidate;
    }
    return null;
}

// G6：ST 1.17.0 openai.js:5262 的 #model_custom_select change 处理器会把
// value 写回 oai_settings.custom_model。切源前/后同步该原生控件，避免 ST 的
// 源切换重填列表后把 custom_model 重置成别的模型；若同步不生效，切源完成后
// 再复核并重写 custom_model。
function syncNativeCustomModelSelect(model) {
    if (typeof model !== 'string' || model.length === 0) return false;
    const jq = getJQuery();
    if (jq) {
        try {
            const select = jq('#model_custom_select');
            if (select && (typeof select.length !== 'number' || select.length > 0)) {
                select.val(model).trigger('change');
                return true;
            }
        } catch {
            // 原生入口异常时尝试 DOM 兜底。
        }
    }
    // 无 jQuery 的极简宿主：直接赋值并派发 change（仍只在用户确认+服务端
    // 成功后执行）。
    try {
        const doc = globalThis.document;
        const element = doc && typeof doc.getElementById === 'function'
            ? doc.getElementById('model_custom_select')
            : null;
        if (!element) return false;
        if (Object.hasOwn(element, 'value') || 'value' in element) element.value = model;
        if (typeof element.dispatchEvent === 'function' && typeof globalThis.Event === 'function') {
            element.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
        }
        return true;
    } catch {
        return false;
    }
}

function switchToCustomSource(settings) {
    // ST 1.17.0 的原生切换入口：改变 select 值并触发 change，让 ST 自己的
    // 处理器更新 chat_completion_source / UI（插件不复制这套逻辑）。
    const jq = getJQuery();
    if (jq) {
        try {
            jq('#chat_completion_source').val('custom').trigger('change');
            return true;
        } catch {
            // 原生入口异常时才走直接赋值兜底。
        }
    }
    // 无 jQuery 的回退：直接赋值同一字段并保存（仍只在用户确认 + 服务端
    // 成功之后执行，不存在偷偷改 source 的路径）。
    settings.chat_completion_source = 'custom';
    saveSettingsDebouncedLocal();
    return true;
}

async function reassertCustomModel(model) {
    const fresh = freshChatSettings();
    if (!fresh) return;
    if (typeof fresh.custom_model === 'string' && fresh.custom_model === model) return;
    fresh.custom_model = model;
    await persistSettings();
}

// W4/W8：等待服务端/保存期间用户取消或切换预设后，旧快照不得再覆盖新设置。
// 只有“弹窗世代未变、预设世代未变且当前 custom_url 仍是本次写入的网关 base”
// 才算本次确认仍然有效。
function applyContextUnchanged(applySeq, applyPresetSeq) {
    const latest = freshChatSettings();
    return !!latest
        && applySeq === modelRequestSeq
        && applyPresetSeq === presetChangeSeq
        && typeof latest.custom_url === 'string'
        && latest.custom_url === L.GATEWAY_CUSTOM_BASE_URL;
}

// W8：取消/失败且没有更新的预设或更晚的接入接管当前设置时，可以安全恢复
// 本次确认前的 Custom URL/model（同时同步原生展示控件），避免“用户自有
// 第三方 key 留在 api_key_custom，而 URL 已指向网关”的外送窗口。
function canRestoreApplySnapshot(applyPresetSeq) {
    const latest = freshChatSettings();
    if (!latest
        || typeof latest.custom_url !== 'string'
        || latest.custom_url !== L.GATEWAY_CUSTOM_BASE_URL) {
        return false;
    }
    if (applyPresetSeq === presetChangeSeq) return true;
    // 预设切换过：只有预设自己没改 custom_url 时，网关 URL 仍是本次流程
    // 写入的值，可以恢复；预设显式设置 URL 时由预设拥有，不覆盖。
    return presetOwnsCustomUrl === false;
}

// W5：ST 1.17.0 的原生 Custom 面板不会因直接改 oai_settings 而刷新（源切换
// 只触发 select change，不复制 URL/model 到输入框）。服务端确认成功后把两个
// 展示控件同步为实际生效值；settings 已由插件保存，这里不再触发 input 事件
// 以免重复保存/覆盖。
function syncNativeCustomDisplay(model, url) {
    if (typeof model !== 'string') model = '';
    const targetUrl = typeof url === 'string' ? url : L.GATEWAY_CUSTOM_BASE_URL;
    const jq = getJQuery();
    if (jq) {
        try {
            jq('#custom_api_url_text').val(targetUrl);
            jq('#custom_model_id').val(model);
            return true;
        } catch {
            // 原生入口异常时尝试 DOM 兜底。
        }
    }
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.getElementById !== 'function') return false;
        const urlInput = doc.getElementById('custom_api_url_text');
        const modelInput = doc.getElementById('custom_model_id');
        if (!urlInput || !modelInput) return false;
        urlInput.value = targetUrl;
        modelInput.value = model;
        return true;
    } catch {
        return false;
    }
}

async function applyModelSelection() {
    const name = modelDialogName;
    const switchSource = modelDialogSwitchSource === true;
    if (typeof name !== 'string' || name.length === 0) return;
    if (!modelDialogConfirm || modelDialogConfirm.disabled) return;
    // I3：记下本次确认对应的弹窗/预设世代；等待保存与服务端期间用户关闭
    // 弹窗或切换预设都会让世代 +1。
    const applySeq = modelRequestSeq;
    const applyPresetSeq = presetChangeSeq;
    modelDialogConfirm.disabled = true;
    modelDialogConfirm.textContent = '正在接入…';

    // W8：同一时间只跑一个接入流程。新确认排在旧流程之后（含旧流程的
    // 取消回滚/凭据清理），再读取最新设置；避免两个流程交错写同一组
    // custom_url/custom_model 与同一个 Custom key。
    const previous = applyQueueTail;
    let releaseQueue;
    applyQueueTail = new Promise((resolve) => { releaseQueue = resolve; });
    try {
        await previous;
        await runApplyModel(name, switchSource, applySeq, applyPresetSeq);
    } finally {
        releaseQueue();
    }
}

async function runApplyModel(name, switchSource, applySeq, applyPresetSeq) {
    // 排队期间用户又取消/换了预设或打开了更新的确认：本次确认已过期，
    // 不写设置、不请求服务端。
    if (applySeq !== modelRequestSeq || applyPresetSeq !== presetChangeSeq) {
        if (applySeq === modelRequestSeq) {
            modelDialogConfirm.disabled = false;
            modelDialogConfirm.textContent = '确认选择';
        }
        agToast('warning', '接入已取消或设置已变更，未请求服务端写入 Custom key。');
        renderModels();
        return;
    }
    const settings = freshChatSettings();
    if (!settings) {
        agToast('warning', '无法读取酒馆对话补全设置，模型选择不可用。');
        return;
    }

    // G2：先写 custom_url / custom_model 并 await 真正落盘（SETTINGS_UPDATED
    // 确认）；保存失败 → 不请求服务端、不写 key，恢复内存设置并提示。
    const snapshot = snapshotModelSettings(settings);
    // ST 1.17.0 chat-completions.js 会在 custom_url 后追加 /chat/completions，
    // 所以这里写 base（含 /v1、不含后缀）。
    settings.custom_url = L.GATEWAY_CUSTOM_BASE_URL;
    settings.custom_model = name;
    const saved = await persistSettings();
    state.settingsSaveUncertain = saved.uncertain === true;
    // W4：保存期间用户可能取消/切换预设；此后不得再按旧快照回滚，也不得
    // 继续请求服务端写 key（否则会把凭据写到一个已经不属于本次确认的配置）。
    if (!applyContextUnchanged(applySeq, applyPresetSeq)) {
        // W6：若期间用户已打开更新的一次确认，共享的 confirm 按钮属于新弹窗，
        // 旧流程不得重置/关闭它（否则会把新弹窗的世代作废）。
        // W8：没有预设/更新的接入接管时，恢复本次确认前的 Custom 设置，避免
        // 用户自有的第三方 key 留在 api_key_custom 而 URL 已指向网关。
        if (canRestoreApplySnapshot(applyPresetSeq)) {
            const restorePresetSeq = presetChangeSeq;
            restoreModelSettings(settings, snapshot);
            const restored = await persistSettings();
            state.settingsSaveUncertain = restored.uncertain === true;
            if (presetChangeSeq === restorePresetSeq) {
                syncNativeCustomDisplay(
                    snapshot.customModelOwn ? snapshot.customModel : '',
                    snapshot.customUrlOwn ? snapshot.customUrl : '',
                );
                agToast('warning', restored.ok
                    ? '接入已取消：已恢复原 Custom 设置，未写入凭据。'
                    : '接入已取消：内存设置已恢复但落盘未确认，请检查 Custom URL/模型后再生成。');
            } else {
                // 落盘期间又切换了预设：展示以新预设为准，不写回旧快照控件。
                agToast('warning', '接入已取消：期间预设已变更，请检查当前 Custom 设置。');
            }
        } else {
            agToast('warning', '接入已取消或设置已变更，未请求服务端写入 Custom key。');
        }
        if (applySeq === modelRequestSeq) {
            modelDialogConfirm.disabled = false;
            modelDialogConfirm.textContent = '确认选择';
        }
        renderModels();
        return;
    }
    // I7：无法确认落盘（无 SETTINGS_UPDATED 的降级宿主/旧 debounce 路径）时
    // fail-closed：不调 /apply-model、不写凭据，恢复内存设置并提示。
    if (saved.uncertain) {
        restoreModelSettings(settings, snapshot);
        saveSettingsDebouncedLocal();
        modelDialogConfirm.disabled = false;
        modelDialogConfirm.textContent = '确认选择';
        agToast('warning', '无法确认设置已保存，未写入凭据（Custom 源 key）。请检查酒馆设置保存后再试。');
        renderModels();
        return;
    }
    if (!saved.ok) {
        restoreModelSettings(settings, snapshot);
        saveSettingsDebouncedLocal();
        modelDialogConfirm.disabled = false;
        modelDialogConfirm.textContent = '确认选择';
        agToast('error', `设置保存失败：${saved.reason || '未确认落盘'}。未请求服务端写入 Custom key；请检查酒馆设置保存后再试。`);
        renderModels();
        return;
    }

    const result = await request('/apply-model', {
        method: 'POST',
        body: JSON.stringify({ model: name, switchSource }),
    });
    if (!result.ok) {
        // W10b：登录失效时先强制清空 Custom URL，再刷新状态；随后失败路径
        // 不得回滚到旧快照（那会把可能残留的网关 key 配到第三方地址）。
        const loginInvalid = isLoginInvalidResult(result);
        if (loginInvalid) {
            await clearCustomUrlAfterLoginClear(true);
            reportLoginInvalid((message) => agToast('warning', message));
        }
        const error = errorFrom(result, '服务器未确认接入');
        // F10/G1：只有服务端明确拒绝（4xx / 完全未写的 custom_source_write_failed）
        // 才回滚到第三方 URL；custom_source_write_partial、网络不确定（status 0 /
        // 超时 / 其他 5xx）保留网关 URL——回滚到可能已收到 key 的第三方源比停留
        // 在网关更危险，且 key 归属未知，需要重新武装清理。
        const rollback = L.shouldRollbackApplyModel(result.status, error.code);
        const canRestore = rollback && !loginInvalid && canRestoreApplySnapshot(applyPresetSeq);
        if (!rollback) antitrunc.customKeyPresent = null;
        if (applySeq === modelRequestSeq) {
            modelDialogConfirm.disabled = false;
            modelDialogConfirm.textContent = '确认选择';
        }
        if (canRestore) {
            const restorePresetSeq = presetChangeSeq;
            restoreModelSettings(settings, snapshot);
            const restored = await persistSettings();
            state.settingsSaveUncertain = restored.uncertain === true;
            if (presetChangeSeq === restorePresetSeq) {
                syncNativeCustomDisplay(
                    snapshot.customModelOwn ? snapshot.customModel : '',
                    snapshot.customUrlOwn ? snapshot.customUrl : '',
                );
                agToast('error', restored.ok
                    ? `模型接入失败：${describeError(result, '服务器未确认接入')}（已回滚 custom_url / custom_model）`
                    : `模型接入失败：${describeError(result, '服务器未确认接入')}（内存已回滚但落盘未确认，请检查设置）`);
            } else {
                agToast('error', `模型接入失败：${describeError(result, '服务器未确认接入')}（期间预设已变更，请检查当前 Custom 设置）`);
            }
        } else if (rollback) {
            // W4：等待期间用户取消/切换预设，旧快照会覆盖新配置；保留当前值。
            agToast('error', `模型接入失败：${describeError(result, '服务器未确认接入')}（等待期间设置已变更，未回滚当前设置）`);
        } else {
            agToast('error', `模型接入结果未知：${describeError(result, '服务器未确认接入')}。已保留网关 URL；请重试，或退出登录清理后再试。`);
        }
        renderModels();
        return;
    }
    // I3：/apply-model 在途期间用户可能关闭弹窗或切到第三方预设。服务端已写
    // 了 key，若此时仍自动切源/同步模型，就会把用户的新设置覆盖掉。返回后
    // 重新读取最新设置：URL 不再等于网关 base 或弹窗世代已变 → 不切源，
    // 回收本次写入的 key（force 跳过 URL 闸/节流），并按取消提示。
    const latest = freshChatSettings();
    const latestUrl = latest ? latest.custom_url : undefined;
    const settingsChanged = applySeq !== modelRequestSeq
        || applyPresetSeq !== presetChangeSeq
        || typeof latestUrl !== 'string' || latestUrl !== L.GATEWAY_CUSTOM_BASE_URL;
    if (settingsChanged) {
        antitrunc.customKeyPresent = null;
        const latestUrlSafe = latest && typeof latestUrl === 'string';
        const stillGateway = latestUrlSafe && latestUrl === L.GATEWAY_CUSTOM_BASE_URL;
        const stillCurrent = applySeq === modelRequestSeq;
        if (stillCurrent) {
            modelDialogConfirm.disabled = false;
            modelDialogConfirm.textContent = '确认选择';
        }
        if (stillGateway) {
            // W4：当前设置仍指向网关（例如用户取消后另一个接入已完成，或
            // 切到同样指向网关的预设）。此时 force 清理会删除“本次”之外的
            // 插件自有 key（包括更新一次成功接入写入的 key），因此跳过清理；
            // 保留的 key 仍只会发往网关。
            agToast('warning', '接入已取消：等待期间设置已变更但仍指向网关，保留已写入的 Custom key；未切换对话补全源。');
        } else {
            const cleanupResult = await cleanupCustomKey(
                latest ? { custom_url: latestUrl } : null,
                { force: true },
            );
            antitrunc.customKeyPresent = null;
            // J4：只有服务端确认 cleared:true 才能说“已清理”；read_failed/残留/
            // 请求失败一律如实提示凭据可能残留，不得谎称回收成功。
            const cleared = isPlainObj(cleanupResult) && cleanupResult.cleared === true;
            agToast('warning', cleared
                ? '接入已取消：等待期间设置已变更，已清理本次写入的 Custom key，未切换对话补全源。'
                : '接入已取消：等待期间设置已变更，凭据可能残留，请重试清理或退出登录。');
        }
        if (stillCurrent && modelDialog && modelDialog.open) modelDialog.close();
        renderModels();
        renderAntitrunc();
        return;
    }
    antitrunc.customKeyPresent = true;
    // I2：key 已被（重新）写入，旧的同 URL 清理节流窗口作废。
    resetCustomCleanupThrottle();
    // G6：切源前同步原生模型控件，切源后再同步并复核 custom_model 未被 ST
    // 的源切换重填逻辑覆盖。
    syncNativeCustomModelSelect(name);
    if (switchSource === true) switchToCustomSource(settings);
    syncNativeCustomModelSelect(name);
    await reassertCustomModel(name);
    syncNativeCustomDisplay(name);
    agToast('success', switchSource
        ? `已接入模型：${name}（对话补全源已切换为 Custom）。`
        : `已接入模型：${name}。`);
    if (modelDialog && modelDialog.open) modelDialog.close();
    renderModels();
    renderAntitrunc();
}

function openPanel() {
    if (!els) return;
    void estimateContextMeter(); // 面板打开时对当前 chat 估算一次（fire-and-forget）。
    // G7：面板打开时也刷新状态（同时触发服务端机会式探活）。
    void refreshStatus();
    const drawer = document.getElementById('rm_extensions_block');
    if (drawer && drawer.classList.contains('closedDrawer')) {
        const toggle = document.querySelector('#extensions-settings-button .drawer-icon');
        if (toggle) toggle.click();
    }
    // 快捷按钮打开面板时展开本插件折叠块；用户仍可点标题栏重新收起。
    if (els.drawerIcon && els.drawerIcon.classList.contains('down')) {
        els.headerToggle.click();
    }
    window.setTimeout(() => {
        els.panel.scrollIntoView({ block: 'center' });
        els.panel.focus({ preventScroll: true });
    }, 60);
}

async function request(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : 10000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = ctx && typeof ctx.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const response = await fetch(`${ROUTE}${path}`, {
            method: options.method || 'GET',
            headers,
            signal: controller.signal,
            body: options.body,
        });
        const text = await response.text();
        if (text.length > L.MAX_RESPONSE_BYTES) {
            return { ok: false, status: response.status, json: null, error: { code: 'response_too_large', message: '响应过大' } };
        }
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }
        return { ok: response.ok, status: response.status, json, text };
    } catch (error) {
        const timedOut = error && error.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            json: null,
            error: {
                code: timedOut ? 'timeout' : 'network_error',
                message: timedOut ? '请求超时' : '网络请求失败',
            },
        };
    } finally {
        window.clearTimeout(timer);
    }
}

function errorFrom(result, fallback) {
    const nested = result && result.json && result.json.error;
    if (nested && typeof nested === 'object'
        && (typeof nested.code === 'string' || typeof nested.message === 'string')) {
        return {
            code: typeof nested.code === 'string' ? nested.code : 'request_failed',
            message: typeof nested.message === 'string' && nested.message ? nested.message : fallback,
        };
    }
    if (result && result.error) return result.error;
    return { code: 'request_failed', message: fallback };
}

function describeError(result, fallback) {
    const error = errorFrom(result, fallback);
    const http = result && result.status ? `HTTP ${result.status}` : '无响应';
    return `${http} · ${error.code}：${error.message}`;
}

// H4：账号切换/重新授权时清空所有按账号缓存的数据。不触碰防截断预设缓存
// （那是预设内容指纹，不含账号数据）；上下文计量也随之归零等待重算。
function clearAuthorizedCaches() {
    state.keys = null;
    state.keysError = null;
    state.models = null;
    state.modelsError = null;
    state.balance = null;
    state.balanceError = null;
    state.contextMeter = { used: null, max: null };
    // 旧世代请求的 pending 标记一并复位；旧响应返回时会因世代不符被丢弃。
    state.keysPending = false;
    state.modelsPending = false;
    state.balancePending = false;
}

// H4：授权态身份判定。服务端不返回登录凭据，以 username 为账号标识；每次
// “从未授权 → 授权”或 username 变化视为一次连接世代切换（同用户名重新登录
// 也因 wasAuthorized 复位而算新世代）。
function noteAuthorizedIdentity(value) {
    const identity = typeof value.username === 'string' && value.username.length > 0
        ? value.username
        : null;
    if (!state.wasAuthorized || state.authIdentity !== identity) {
        state.authIdentity = identity;
        state.authGeneration += 1;
        clearAuthorizedCaches();
        // I2：approved/renewed 登录会让服务端重新持有（并可能同步）插件 key，
        // 旧的同 URL 清理节流窗口随之作废。
        resetCustomCleanupThrottle();
        return true;
    }
    return false;
}

async function refreshStatus() {
    if (!els) return;
    els.statusLine.textContent = '正在读取插件状态…';
    const seq = ++statusRequestSeq;
    const result = await request('/status');
    if (seq !== statusRequestSeq) return;
    if (!result.ok) {
        state.status = null;
        state.statusError = describeError(result, '插件状态不可用');
        renderStatus();
        return;
    }
    if (!result.json) {
        state.status = null;
        state.statusError = '状态响应不是 JSON';
        renderStatus();
        return;
    }
    const parsed = L.parseStatus(result.json);
    if (!parsed.ok) {
        state.status = null;
        state.statusError = `状态响应不符合契约（${parsed.reason}）`;
        renderStatus();
        return;
    }
    state.status = parsed;
    state.statusError = null;
    renderStatus();
}

function statusStateLabel(value) {
    switch (value.state) {
        case 'authorized':
            return value.username ? `已授权：${value.username}` : '已授权';
        case 'pending':
            return '等待网页授权';
        case 'invalid':
            return '登录已失效';
        default:
            return '未连接';
    }
}

function renderStatus() {
    if (!els) return;
    refreshCtx();
    if (state.statusError || !state.status) {
        els.statusLine.textContent = `插件状态不可用：${state.statusError || '未知错误'}`;
        els.dot.className = 'ag-dot ag-dot-error';
        for (const face of STATUS_KEYS) {
            els.chips[face].textContent = `${face}：未知`;
            els.chips[face].className = 'ag-chip';
        }
        els.loginNote.textContent = '尚未取得后端状态；连接请求可能直接返回错误。';
        els.logoutButton.hidden = true;
        state.wasAuthorized = false;
        stopStatusRefresh();
        setQueryButtonsDisabled(true);
        renderKeys();
        renderModels();
        renderBalance();
        renderContextMeter();
        updateQuick();
        renderAntitrunc();
        return;
    }

    const value = state.status.value;
    const authorized = L.isAuthorized(state.status);
    // W9/W10：登录失效时按服务端确认的 Custom 清理结果处理：Custom 已清
    // 且 URL 仍指向网关 → 清空；Custom 未确认清理 → 强制清空 Custom URL，
    // 防止残留的网关 key 被发往第三方或重新激活的用户 key 被发往网关。
    if (value.state === 'invalid' && value.reason === 'login_invalidated') {
        void clearCustomUrlAfterLoginClear(value.custom_cleared !== true);
    }
    // H4：授权身份变化（username 变化或重新授权）→ 新的连接世代；清空旧账号
    // 缓存后再重新拉取。未授权时身份置空，下一次授权按新世代处理。
    const accountChanged = authorized ? noteAuthorizedIdentity(value) : false;
    if (!authorized) state.authIdentity = null;
    // 「已授权」与「已连接」分层：connected 恒 false；st_connection 独立显示
    // 酒馆侧连接。服务端固定 unknown，UI 在 ctx.onlineStatus 可用时读取 ST
    // 自身三态（connected/disconnected/unknown）；不可用则不显示“已连接”。
    const liveState = L.stConnectionState(ctx && typeof ctx.onlineStatus === 'string'
        ? ctx.onlineStatus
        : null);
    const stText = liveState === 'connected' ? '已连接' : liveState === 'disconnected' ? '未连接' : '未知';
    els.statusLine.textContent = `${statusStateLabel(value)} · 酒馆连接：${stText}`;
    let usable = false;
    for (const face of STATUS_KEYS) {
        const on = value.connected === true && value.protocols[face] === true;
        usable = usable || on;
        els.chips[face].textContent = `${face}：${on ? '已接通' : '未接通'}`;
        els.chips[face].className = `ag-chip ${on ? 'ag-chip-on' : 'ag-chip-off'}`;
    }
    els.dot.className = `ag-dot ${usable ? 'ag-dot-ok' : value.state === 'not_connected' || value.state === 'invalid' ? 'ag-dot-error' : 'ag-dot-warn'}`;

    if (state.connectPending) {
        els.loginNote.textContent = '正在发起连接…';
    } else if (state.connectPolling) {
        els.loginNote.textContent = '已打开网关授权页，等待网页授权…';
    } else if (state.connectError) {
        els.loginNote.textContent = `连接：${state.connectError}`;
    } else if (value.state === 'authorized') {
        els.loginNote.textContent = '已授权（不等于已连接：模型连接状态以酒馆为准）。';
    } else if (value.state === 'pending') {
        els.loginNote.textContent = '等待网关网页授权…';
    } else if (value.state === 'invalid') {
        els.loginNote.textContent = '登录已失效或连接未完成，请重新点击“连接 Apercus”。';
    } else {
        els.loginNote.textContent = '尚未连接 Apercus 网关。';
    }
    els.loginButton.textContent = state.connectPending ? '正在连接…' : '连接 Apercus';
    els.loginButton.disabled = state.connectPending;
    // G10：只有本地清理不完整时才会显示退出重试入口。清理已确认成功
    // （local_cleared/custom_cleared=true）时重试 logout 只会因无信封的
    // Custom 条目进入 uncertain 并强制清空用户设置，应改为重新连接提示。
    const cleanupIncomplete = value.local_cleared !== true || value.custom_cleared !== true;
    const retryLogout = value.state === 'invalid'
        && value.reason === 'login_invalidated'
        && cleanupIncomplete;
    els.logoutButton.hidden = !(authorized || retryLogout);
    els.logoutButton.textContent = retryLogout ? '退出登录（重试清理）' : '退出登录';
    els.logoutButton.disabled = state.connectPending;
    setQueryButtonsDisabled(!authorized);
    renderKeys();
    renderModels();
    renderBalance();
    renderContextMeter();
    // H4：身份变化（首次授权/换账号）时清空缓存并自动拉一遍 key/模型/额度
    // （用户无需逐个点刷新）；同一账号的周期刷新不重复清空/重拉。
    if (authorized && accountChanged) {
        void refreshKeys();
        void refreshModels();
        void refreshBalance();
        void estimateContextMeter();
    }
    if (authorized) state.wasAuthorized = true;
    else state.wasAuthorized = false;
    // G12/W1：pending 是服务端仍有存活连接请求的持久状态；页面刷新/第二标签
    // 打开面板时自动恢复 /connect/status 轮询（终态由轮询自身停止）。已授权
    // 时重新发起连接（换账号/续期）state 仍是 authorized，因此还看服务端的
    // connect_pending——只认 state 会漏掉这类会话，approved 交付无人领取。
    if ((value.state === 'pending' || value.connect_pending === true) && !state.connectPending) {
        startConnectPolling();
    }
    // G7：授权态周期刷新；其他状态清理 interval。
    ensureStatusRefresh(authorized);
    updateQuick();
    renderAntitrunc();
}

function setQueryButtonsDisabled(disabled) {
    if (!els) return;
    els.keysButton.disabled = disabled || state.keysPending;
    els.modelsButton.disabled = disabled || state.modelsPending;
    els.balanceButton.disabled = disabled || state.balancePending;
}

function updateQuick() {
    if (!els || !els.quick) return;
    const kind = els.dot && els.dot.className.includes('ag-dot-ok')
        ? 'ok'
        : els.dot && els.dot.className.includes('ag-dot-warn')
            ? 'warn'
            : els.dot && els.dot.className.includes('ag-dot-error') ? 'error' : 'unknown';
    const labels = {
        ok: 'Apercus Gateway：酒馆已连接',
        warn: 'Apercus Gateway：已授权，酒馆连接状态未知',
        error: 'Apercus Gateway：未连接或登录已失效',
        unknown: 'Apercus Gateway：状态未知',
    };
    els.quick.className = 'menu_button ag-quick';
    els.quick.setAttribute('aria-label', labels[kind]);
}

function stopConnectPolling() {
    state.connectPolling = false;
    if (state.connectPollTimer !== null) {
        window.clearInterval(state.connectPollTimer);
        state.connectPollTimer = null;
    }
}

// G12：renderStatus 见到 pending（页面刷新/第二标签/多次打开面板）时自动恢复
// 连接轮询；终态（authorized/invalid）由 pollConnectOnceInner 负责停止。
function startConnectPolling() {
    if (state.connectPolling) return;
    state.connectPolling = true;
    if (state.connectPollTimer !== null) {
        window.clearInterval(state.connectPollTimer);
        state.connectPollTimer = null;
    }
    state.connectPollTimer = window.setInterval(() => { void pollConnectOnce(); }, CONNECT_POLL_MS);
    void pollConnectOnce();
}

// G7：授权态每 60 分钟刷新一次 /status，触发服务端 1h 机会式登录探活/续期。
// logout / 失效 / 页面卸载都必须清掉这个 interval。
const STATUS_REFRESH_MS = 60 * 60 * 1000;

function stopStatusRefresh() {
    if (state.statusRefreshTimer !== null) {
        window.clearInterval(state.statusRefreshTimer);
        state.statusRefreshTimer = null;
    }
}

function ensureStatusRefresh(authorized) {
    if (!authorized) {
        stopStatusRefresh();
        return;
    }
    if (state.statusRefreshTimer !== null) return;
    state.statusRefreshTimer = window.setInterval(() => { void refreshStatus(); }, STATUS_REFRESH_MS);
    if (state.statusRefreshTimer && typeof state.statusRefreshTimer.unref === 'function') {
        // Node 测试宿主：不让周期 timer 阻止测试进程退出（浏览器 timer 是数字）。
        state.statusRefreshTimer.unref();
    }
}

function cleanupTimers() {
    stopConnectPolling();
    stopStatusRefresh();
}

function setConnectNote(message) {
    if (!els) return;
    els.loginNote.textContent = message;
}

function hideConnectLink() {
    if (!els || !els.connectLink) return;
    els.connectLink.hidden = true;
}

function showConnectLink(url) {
    if (!els || !els.connectLink) return;
    els.connectLink.href = url;
    els.connectLink.hidden = false;
}

function closeConnectWindow(authWindow) {
    if (!authWindow) return;
    try {
        authWindow.close();
    } catch {
        // 关闭失败不影响错误语义。
    }
}

// 连接面板：POST /connect 只拿 {status, authorize_url}；浏览器打开前校验地址
// 白名单（https + 固定网关域），非白名单域拒绝打开（不泄露到错误信息）。
// G11：点击时同步打开 about:blank 保留窗口引用，拿到地址后再设置 location；
// 绝不在 await 之后才 window.open（否则浏览器会拦截为“非用户手势”）。
// 被拦截时回退为可点击链接（地址仅在通过白名单后写入 href）。
// 轮询 GET /connect/status 每 5 秒一次；authorized / invalid 为终态，清定时器。
// 远端 username 只经 statusStateLabel 拼入字符串后以 textContent 渲染。
async function doConnect() {
    if (!els || state.connectPending) return;
    stopConnectPolling();
    hideConnectLink();
    state.connectPending = true;
    state.connectError = null;
    state.connectStatus = null;
    state.connectFallback = false;
    renderStatus();

    // 必须发生在任何 await 之前：用户手势内同步开窗。
    let authWindow = null;
    try {
        if (els.loginButton && typeof window.open === 'function') {
            authWindow = window.open('about:blank', '_blank');
            if (authWindow) authWindow.opener = null;
        }
    } catch {
        authWindow = null;
    }

    const result = await request('/connect', { method: 'POST', body: '{}' });
    state.connectPending = false;
    if (!result.ok) {
        closeConnectWindow(authWindow);
        state.connectError = describeError(result, '连接请求失败');
        renderStatus();
        setConnectNote(`连接失败：${state.connectError}`);
        return;
    }
    const payload = isPlainObj(result.json) ? result.json : null;
    if (!payload || typeof payload.status !== 'string' || typeof payload.authorize_url !== 'string') {
        closeConnectWindow(authWindow);
        state.connectError = '连接响应不符合契约';
        renderStatus();
        setConnectNote('连接失败：网关返回了无法识别的响应。');
        return;
    }
    if (!L.isGatewayAuthorizeUrl(payload.authorize_url)) {
        closeConnectWindow(authWindow);
        state.connectError = '授权页地址不在白名单域';
        renderStatus();
        setConnectNote('已拒绝打开非白名单授权页地址；请稍后重试或联系网关管理员。');
        return;
    }
    let opened = false;
    if (authWindow) {
        try {
            authWindow.location.href = payload.authorize_url;
            opened = true;
        } catch {
            opened = false;
        }
    }
    state.connectFallback = !opened;
    if (!opened) {
        // 浏览器拦截了自动开窗：保留同一已校验地址作为可点击链接。
        showConnectLink(payload.authorize_url);
    } else {
        hideConnectLink();
    }
    startConnectPolling();
    renderStatus();
    if (!opened) {
        // renderStatus 会按 connectPolling 覆盖提示，最后再如实说明回退方式。
        setConnectNote('浏览器拦截了自动打开授权页，请点击上方“打开网关授权页”链接继续。');
    }
}

async function pollConnectOnce() {
    if (!state.connectPolling || state.connectPollInFlight) return;
    state.connectPollInFlight = true;
    try {
        await pollConnectOnceInner();
    } finally {
        state.connectPollInFlight = false;
    }
}

async function pollConnectOnceInner() {
    if (!state.connectPolling) return;
    const result = await request('/connect/status');
    if (!state.connectPolling) return;
    if (!result.ok || !isPlainObj(result.json)) {
        // 传输层失败保留轮询：下一次 5 秒自然重试。
        setConnectNote(`连接状态暂不可用：${describeError(result, '连接状态查询失败')}`);
        return;
    }
    const parsed = L.parseConnectStatus(result.json);
    if (!parsed.ok) {
        // 契约响应非法：fail-closed 停止轮询（不猜测状态）。
        stopConnectPolling();
        setConnectNote(`连接状态响应不符合契约（${parsed.reason}）。`);
        renderStatus();
        return;
    }
    state.connectStatus = parsed.value;
    if (parsed.value.status === 'authorized') {
        stopConnectPolling();
        hideConnectLink();
        state.connectFallback = false;
        state.connectPending = false;
        state.connectError = null;
        // I2：approved 成功（服务端已写新信封）→ 旧的同 URL 清理节流窗口作废。
        resetCustomCleanupThrottle();
        setConnectNote(parsed.value.username
            ? `已授权：${parsed.value.username}。已授权不等于已连接，模型连接状态以酒馆为准。`
            : '已授权。已授权不等于已连接，模型连接状态以酒馆为准。');
        await refreshStatus();
        if (els) els.logoutButton.hidden = false;
        setConnectNote(parsed.value.username
            ? `已授权：${parsed.value.username}。已授权不等于已连接，模型连接状态以酒馆为准。`
            : '已授权。已授权不等于已连接，模型连接状态以酒馆为准。');
        return;
    }
    if (parsed.value.status === 'invalid') {
        stopConnectPolling();
        hideConnectLink();
        state.connectFallback = false;
        state.connectError = '连接未完成或已失效';
        setConnectNote('连接未完成或已失效，请重新点击“连接 Apercus”。');
        await refreshStatus();
        return;
    }
    if (!state.connectFallback) {
        setConnectNote('已打开网关授权页，等待网页授权…');
    }
}

async function doLogout() {
    if (!els || state.connectPending) return;
    stopConnectPolling();
    // G7：退出期间不再周期刷新（请求完成后的 renderStatus 会按新状态重建）。
    stopStatusRefresh();
    state.connectPending = true;
    state.connectError = null;
    renderStatus();
    const result = await request('/logout', { method: 'POST', body: '{}' });
    state.connectPending = false;
    state.connectStatus = null;
    if (!result.ok) {
        const error = errorFrom(result, '退出登录请求失败');
        state.connectError = describeError(result, '退出登录请求失败');
        await refreshStatus();
        if (error.code === 'logout_local_clear_failed') {
            // 本地清理失败：服务端已保留失效标记，/status 不得再显示 authorized；
            // 提示用户重试或到门户兜底。
            setConnectNote(`退出登录失败：本地凭据未清理干净（${state.connectError}）。请重试，或到门户“退出所有酒馆插件”兜底。`);
        } else if (result.status === 0) {
            // 传输层失败：无法确认服务端是否执行过清理，不宣称“本地已清理”。
            setConnectNote(`退出登录请求未到达服务端（${state.connectError}）。请重试，或到门户“退出所有酒馆插件”兜底。`);
        } else {
            setConnectNote(`退出登录未完成：${state.connectError}。请重试，或到门户“退出所有酒馆插件”兜底。`);
        }
        return;
    }
    const payload = isPlainObj(result.json) ? result.json : null;
    const remoteRevoked = !!payload && payload.remote_revoked === true;
    const localCleared = !!payload && payload.local_cleared === true;
    if (!localCleared) {
        // 200 却没报告本地清干净：按 fail-closed 当失败提示，不显示“已退出”。
        state.connectError = '响应未确认本地清理';
        await refreshStatus();
        setConnectNote('退出登录状态未确认：请重试，或到门户“退出所有酒馆插件”兜底。');
        return;
    }
    // F11：服务端确认本地两命名空间已清；本地“插件持有 Custom key”记录归零。
    antitrunc.customKeyPresent = false;
    // W9/W10：服务端确认两命名空间已清；若 Custom 清理结果不确定
    // (custom_cleared=false)，强制清空 Custom URL，避免残留 key 配对。
    const customClearConfirmed = payload.custom_cleared === true;
    const clearedCustom = await clearCustomUrlAfterLoginClear(!customClearConfirmed);
    // I2：会话已清，旧的同 URL 清理节流窗口不再有意义。
    resetCustomCleanupThrottle();
    // H4：退出登录即新世代，旧账号数据/在途响应一律作废。
    state.authGeneration += 1;
    state.authIdentity = null;
    state.wasAuthorized = false;
    clearAuthorizedCaches();
    await refreshStatus();
    if (!remoteRevoked) {
        // S2：远端撤销失败时本地仍已清理，但网关侧凭据可能仍有效。
        setConnectNote(clearedCustom
            ? '已退出本地登录；远端凭据可能仍有效，请到门户“退出所有酒馆插件”兜底撤销。已清空指向网关的 Custom URL/模型，请重新选择模型。'
            : '已退出本地登录；远端凭据可能仍有效，请到门户“退出所有酒馆插件”兜底撤销。');
    } else {
        setConnectNote(clearedCustom
            ? '已退出登录。已清空指向网关的 Custom URL/模型，请重新选择模型。'
            : '已退出登录。');
    }
}

// 查询面 409 not_connected 可能是「本地无登录」或「查询面 401 已清本地」；
// 服务端对后者使用固定的“登录已失效”文案。只有该文案才触发登录失效清理，
// 普通未连接不能清空用户 Custom 设置。
function isLoginInvalidResult(result) {
    const error = errorFrom(result, '');
    if (!result || result.status !== 409 || error.code !== 'not_connected') return false;
    const message = typeof error.message === 'string' ? error.message : '';
    return message.includes('登录已失效') || message.includes('登录已撤销');
}

function reportLoginInvalid(messageSetter) {
    messageSetter('登录已失效，请重新连接 Apercus 网关。');
    state.wasAuthorized = false;
    void refreshStatus();
}

async function refreshKeys() {
    if (!els || state.keysPending) return;
    if (!L.isAuthorized(state.status)) {
        renderKeys();
        return;
    }
    state.keysPending = true;
    setQueryButtonsDisabled(false);
    els.keysNote.textContent = '正在读取 Key 列表…';
    // H4：记录请求世代；账号切换后旧响应不得落到新账号的展示状态。
    const generation = state.authGeneration;
    const result = await request('/keys');
    if (generation !== state.authGeneration) return;
    state.keysPending = false;
    setQueryButtonsDisabled(!L.isAuthorized(state.status));

    if (!result.ok) {
        state.keys = null;
        if (isLoginInvalidResult(result)) {
            state.keysError = '登录已失效';
            renderKeys();
            reportLoginInvalid((message) => { els.keysNote.textContent = message; });
            return;
        }
        state.keysError = describeError(result, 'Key 列表请求失败');
        renderKeys();
        return;
    }
    if (!result.json) {
        state.keys = null;
        state.keysError = 'Key 列表响应不是 JSON';
        renderKeys();
        return;
    }
    const parsed = L.keyListView(result.json);
    if (!parsed.ok) {
        state.keys = null;
        state.keysError = `Key 列表响应不符合契约（${parsed.reason}）`;
        renderKeys();
        return;
    }
    state.keys = parsed;
    state.keysError = null;
    renderKeys();
}

function renderKeys() {
    if (!els) return;
    clear(els.keysList);
    if (!L.isAuthorized(state.status)) {
        els.keysNote.textContent = '登录后可用。';
        return;
    }
    if (state.keysError) {
        els.keysNote.textContent = `Key 列表不可用：${state.keysError}`;
        els.keysNote.className = 'ag-note ag-warn';
        return;
    }
    if (!state.keys) {
        els.keysNote.textContent = '尚未加载 Key 列表。';
        els.keysNote.className = 'ag-note';
        return;
    }
    els.keysNote.textContent = `${state.keys.keys.length} 把 key（v1 恒一把）；只显示名称与脱敏标识。`;
    els.keysNote.className = 'ag-note';
    if (state.keys.keys.length === 0) {
        els.keysList.append(h('p', 'ag-empty', '账号下没有可用的 key。'));
        return;
    }
    for (const item of state.keys.keys) {
        const row = h('div', `ag-key-row${item.current ? ' ag-key-current' : ''}`);
        const top = h('div', 'ag-key-top');
        const name = h('span', 'ag-key-name');
        name.textContent = item.name;
        top.append(name, h('span', 'ag-key-masked', item.masked));
        if (item.current) top.append(h('span', 'ag-badge', '当前 key'));
        const status = h('span', 'ag-key-status', item.status === 'enabled' ? '启用' : item.status);
        row.append(top, status);
        els.keysList.append(row);
    }
}

async function refreshModels() {
    if (!els || state.modelsPending) return;
    if (!L.isAuthorized(state.status)) {
        renderModels();
        return;
    }
    state.modelsPending = true;
    setQueryButtonsDisabled(false);
    els.modelsNote.textContent = '正在读取模型目录…';
    const generation = state.authGeneration;
    const result = await request('/models');
    if (generation !== state.authGeneration) return;
    state.modelsPending = false;
    setQueryButtonsDisabled(!L.isAuthorized(state.status));

    if (!result.ok) {
        state.models = null;
        if (isLoginInvalidResult(result)) {
            state.modelsError = '登录已失效';
            renderModels();
            reportLoginInvalid((message) => { els.modelsNote.textContent = message; });
            return;
        }
        state.modelsError = describeError(result, '模型目录请求失败');
        renderModels();
        return;
    }
    if (!result.json) {
        state.models = null;
        state.modelsError = '模型目录响应不是 JSON';
        renderModels();
        return;
    }
    const parsed = L.classifyModelChoices(result.json);
    if (!parsed.ok) {
        state.models = null;
        state.modelsError = `模型目录响应不符合契约（${parsed.reason}）`;
        renderModels();
        return;
    }
    state.models = parsed;
    state.modelsError = null;
    renderModels();
}

function renderModels() {
    if (!els) return;
    clear(els.modelsList);
    if (!L.isAuthorized(state.status)) {
        els.modelsNote.textContent = '登录后可用。';
        return;
    }
    if (state.modelsError) {
        els.modelsNote.textContent = `模型目录不可用：${state.modelsError}`;
        els.modelsNote.className = 'ag-note ag-warn';
        return;
    }
    if (!state.models) {
        els.modelsNote.textContent = '尚未加载模型目录。';
        els.modelsNote.className = 'ag-note';
        return;
    }
    const notes = [`共 ${state.models.items.length} 条`];
    if (state.models.invalidCount > 0) notes.push(`忽略 ${state.models.invalidCount} 条无效条目`);
    if (state.models.truncated) notes.push(`仅显示前 ${L.MAX_CATALOG_ITEMS} 条`);
    els.modelsNote.textContent = notes.join(' · ');
    els.modelsNote.className = 'ag-note';

    if (state.models.items.length === 0) {
        els.modelsList.append(h('p', 'ag-empty', '模型目录为空。'));
        return;
    }

    const settings = freshChatSettings();
    const currentModel = settings && typeof settings.custom_model === 'string' ? settings.custom_model : null;
    for (const item of state.models.items) {
        const selectable = L.isModelSelectable(item, true);
        const current = currentModel === item.name;
        const row = h('div', `ag-model ${selectable ? 'ag-model-selectable' : 'ag-model-disabled'}${current ? ' ag-model-current' : ''}`);
        const top = h('div', 'ag-model-top');
        const name = h('span', 'ag-model-name');
        name.textContent = item.name;
        name.title = item.name;
        top.append(name);
        for (const face of item.protocol_faces) {
            top.append(h('span', `ag-badge${face === 'chat' ? '' : ' ag-badge-dim'}`, face));
        }
        if (current) top.append(h('span', 'ag-badge', '当前模型'));
        const reason = h('span', `ag-reason ${selectable ? 'ag-reason-ok' : ''}`.trim());
        reason.textContent = selectable
            ? (current ? '点击重新接入（不代表已连接）' : '点击选择（不代表已连接）')
            : '未适配协议面（不含 chat），不可选择';
        row.append(top, reason);
        if (selectable) {
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.addEventListener('click', () => openModelDialog(item.name, row));
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openModelDialog(item.name, row);
                }
            });
        }
        els.modelsList.append(row);
    }
}

async function refreshBalance() {
    if (!els || state.balancePending) return;
    if (!L.isAuthorized(state.status)) {
        renderBalance();
        return;
    }
    state.balancePending = true;
    setQueryButtonsDisabled(false);
    els.balanceNote.textContent = '正在读取额度…';
    const generation = state.authGeneration;
    const result = await request('/balance');
    if (generation !== state.authGeneration) return;
    state.balancePending = false;
    setQueryButtonsDisabled(!L.isAuthorized(state.status));

    if (!result.ok) {
        state.balance = null;
        if (isLoginInvalidResult(result)) {
            state.balanceError = '登录已失效';
            renderBalance();
            reportLoginInvalid((message) => { els.balanceNote.textContent = message; });
            return;
        }
        // 获取失败显示「暂时无法获取」：不显示为零，也不影响登录态。
        state.balanceError = describeError(result, '额度请求失败');
        renderBalance();
        return;
    }
    if (!result.json) {
        state.balance = null;
        state.balanceError = '额度响应不是 JSON';
        renderBalance();
        return;
    }
    const parsed = L.parseBalance(result.json);
    if (!parsed.ok) {
        state.balance = null;
        state.balanceError = `额度响应不符合契约（${parsed.reason}）`;
        renderBalance();
        return;
    }
    state.balance = parsed.value;
    state.balanceError = null;
    renderBalance();
}

function renderBalance() {
    if (!els) return;
    clear(els.balanceList);
    if (!L.isAuthorized(state.status)) {
        els.balanceNote.textContent = '登录后可用。';
        els.balanceNote.className = 'ag-note';
        renderContextMeter();
        return;
    }
    if (state.balanceError) {
        els.balanceNote.textContent = `暂时无法获取额度：${state.balanceError}`;
        els.balanceNote.className = 'ag-note ag-warn';
        renderContextMeter();
        return;
    }
    if (!state.balance) {
        els.balanceNote.textContent = '尚未加载额度。';
        els.balanceNote.className = 'ag-note';
        renderContextMeter();
        return;
    }
    const view = L.balanceRows(state.balance);
    for (const row of view.rows) {
        const line = h('div', 'ag-balance-row');
        line.append(h('span', 'ag-balance-label', row.label), h('span', 'ag-balance-value', row.value));
        els.balanceList.append(line);
    }
    // B3 计量两行：H/K 由 BigInt 校验，非法/缺失显「未知」；K 仅展示，客户端
    // 不做追加额计算。
    const thresholdRow = h('div', 'ag-balance-row');
    thresholdRow.append(
        h('span', 'ag-balance-label', '大输入惩罚阈值 H'),
        h('span', 'ag-balance-value', view.penalty.threshold ?? '未知'),
    );
    const multiplierRow = h('div', 'ag-balance-row');
    multiplierRow.append(
        h('span', 'ag-balance-label', '倍率 K'),
        h('span', 'ag-balance-value', `${view.penalty.multiplier ?? '未知'}（毫率，仅展示）`),
    );
    els.balanceList.append(thresholdRow, multiplierRow);
    const meta = [];
    if (view.quotaDate === null) meta.push('账日：未设置');
    else meta.push(`账日：${view.quotaDate}`);
    meta.push(`观察时点：${view.observedAt}`);
    if (view.warning) {
        els.balanceNote.textContent = `${view.warning} ${meta.join(' · ')}`;
        els.balanceNote.className = 'ag-note ag-warn';
    } else {
        els.balanceNote.textContent = meta.join(' · ');
        els.balanceNote.className = 'ag-note';
    }
    renderContextMeter();
}

// ===== B3 上下文计量（集成层）=====
// 预算优先级（F7）：getMaxPromptTokens（运行时若暴露则优先；ST 1.17.0 的
// getContext 不暴露，属未来版本/宿主扩展点）→ oai_settings（ctx.chatCompletion
// Settings）的 openai_max_context - openai_max_tokens（ST 1.17.0 script.js:
// 5867/5892 口径）→ ctx.maxContext。文本补全源的旧特判已删除：只要 oai_settings
// 两值齐全就用差值，否则统一回退 maxContext。
// 计数只用 ctx.getTokenCountAsync 且只喂字符串（joinMessageText 聚合；喂对象
// 数组会静默返回 0）。任何异常/缺失 → null → UI 显「未知」，绝不打断生成。

function readContextLimit() {
    refreshCtx();
    if (!ctx) return null;
    try {
        if (typeof ctx.getMaxPromptTokens === 'function') {
            const value = ctx.getMaxPromptTokens();
            // 存在即优先：无效返回值表示预算不可用，不回退到更粗的口径。
            return Number.isInteger(value) && value > 0 ? value : null;
        }
        const settings = isPlainObj(ctx.chatCompletionSettings) ? ctx.chatCompletionSettings : null;
        const budget = L.promptBudgetFromSettings(settings);
        if (budget !== null) return budget;
        // chat 配置齐全但预算 ≤0：这是明确的“预算不可用”，不得用 maxContext
        // 掩盖成可用预算。
        if (settings
            && Number.isInteger(settings.openai_max_context)
            && Number.isInteger(settings.openai_max_tokens)) {
            return null;
        }
        if (typeof ctx.maxContext === 'number') {
            return Number.isInteger(ctx.maxContext) && ctx.maxContext > 0 ? ctx.maxContext : null;
        }
    } catch {
        return null;
    }
    return null;
}

async function countChatTokens() {
    refreshCtx();
    if (!ctx || typeof ctx.getTokenCountAsync !== 'function') return null;
    const joined = L.joinMessageText(ctx.chat, 'mes');
    if (!joined) return null;
    try {
        const total = await ctx.getTokenCountAsync(joined);
        return Number.isInteger(total) && total >= 0 ? total : null;
    } catch {
        return null;
    }
}

async function estimateContextMeter() {
    const generation = state.authGeneration;
    const max = readContextLimit();
    const used = await countChatTokens();
    // H4：等待计数期间账号已切换 → 丢弃旧账号的估算结果。
    if (generation !== state.authGeneration) return;
    state.contextMeter.max = max;
    state.contextMeter.used = used;
    renderContextMeter();
}

// GENERATE_AFTER_DATA：同步入口、内部 fire-and-forget；dryRun（PromptManager
// 预览）不计；载荷 prompt / messages 双键聚合 content，无文本则跳过。
function onGenerateAfterData(generateData, dryRun) {
    try {
        if (dryRun) return;
        if (!isPlainObj(generateData) || !ctx || typeof ctx.getTokenCountAsync !== 'function') return;
        const joined = L.joinMessageText(generateData.prompt, 'content')
            ?? L.joinMessageText(generateData.messages, 'content');
        if (!joined) return;
        // H4：账号切换后旧生成请求的计数结果不得覆盖新账号的计量。
        const generation = state.authGeneration;
        ctx.getTokenCountAsync(joined).then((total) => {
            if (generation !== state.authGeneration) return;
            state.contextMeter.used = Number.isInteger(total) && total >= 0 ? total : null;
            state.contextMeter.max = readContextLimit();
            renderContextMeter();
        }).catch(() => {
            state.contextMeter.used = null;
            renderContextMeter();
        });
    } catch {
        // 计量绝不打断生成。
    }
}

function renderContextMeter() {
    if (!els || !els.meterLine) return;
    refreshCtx();
    if (!L.isAuthorized(state.status)) {
        els.meterLine.className = 'ag-meter';
        els.meterLine.textContent = '登录后可用。';
        return;
    }
    const view = L.contextMeterView(state.contextMeter.used, state.contextMeter.max);
    const usedText = view.used === null ? '未知' : String(view.used);
    const maxText = view.max === null ? '未知' : String(view.max);
    const threshold = state.balance ? state.balance.penalty_input_threshold : null;
    const band = threshold !== null ? L.penaltyBand(view.used, threshold) : null;
    els.meterLine.className = band ? `ag-meter ag-meter-${band}` : 'ag-meter';
    els.meterLine.textContent = `上下文：已用 ${usedText} / 预算 ${maxText}`;
}

// ===== B2 防截断分节：集成层 =====
// 依赖全部特性检测（事件名 / eventSource / getPresetManager / crypto.subtle，
// 任一缺失则整功能静默禁用）。注入只在 ST await 的
// CHAT_COMPLETION_SETTINGS_READY 监听里改 generate_data.custom_include_body，
// 绝不阻塞或改写原生成流程其余部分。

function detectAntitruncSupport() {
    if (!ctx) return false;
    // 非 https 部署（局域网 IP 直连）无 crypto.subtle → 指纹算不出来，整功能禁用。
    if (typeof globalThis.crypto?.subtle?.digest !== 'function') return false;
    const events = ctx.event_types;
    const eventSource = ctx.eventSource;
    if (!isPlainObj(events) || !eventSource || typeof eventSource.on !== 'function') return false;
    if (typeof events.PRESET_CHANGED !== 'string'
        || typeof events.CHAT_COMPLETION_SETTINGS_READY !== 'string') return false;
    return typeof ctx.getPresetManager === 'function';
}

// 规划通道 / 注入门控：只认「已授权」（state === 'authorized'）。「已授权」与
// 「已连接」分层——connected 恒 false；酒馆侧连接状态由 st_connection 单独展示。
// 未授权时按钮禁用、注入暂停（/plan 409 是预期 fail-closed）。
function isPlanBound() {
    return L.isAuthorized(state.status);
}

// U7：规划模型只取 B3 模型选择写入的 chatCompletionSettings.custom_model。
// 不再回退 generate_data.model（生成请求里的模型可能来自其它源/旧设置，
// 拿它做 /plan 会绕过用户确认的模型选择）。未选择时 B2 生成按钮禁用。
function currentPlanModel() {
    const settings = freshChatSettings();
    if (settings && typeof settings.custom_model === 'string' && settings.custom_model.length > 0) {
        return settings.custom_model;
    }
    return null;
}

// 预设名 + 预设内容。名称仍取 getSelectedPresetName()；内容优先取 ST 当前
// 活动设置 ctx.chatCompletionSettings（ST 1.17.0 openai.js:4638/4654 的
// oai_settings，含 prompts / prompt_order）。getCompletionPresetByName 返回的是
// 已保存副本（preset-manager.js）：用户编辑条目或开关但未点“更新预设”时，
// 活动设置已变而副本未变，指纹与条目必须跟活动设置走。活动设置形态不符才
// 回退保存副本。
function readSelectedPreset() {
    if (!ctx || typeof ctx.getPresetManager !== 'function') return null;
    let manager = null;
    try {
        manager = ctx.getPresetManager('openai');
    } catch {
        return null;
    }
    if (!manager || typeof manager.getSelectedPresetName !== 'function') {
        return null;
    }
    let name = null;
    try {
        name = manager.getSelectedPresetName();
    } catch {
        return null;
    }
    if (typeof name !== 'string' || name.length === 0) return null;

    const active = freshChatSettings();
    if (active && Array.isArray(active.prompts) && Array.isArray(active.prompt_order)) {
        return { name, presetJson: active };
    }

    // 活动设置形态不符（或尚未加载）：回退已保存的预设副本。
    if (typeof manager.getCompletionPresetByName !== 'function') return null;
    let presetJson = null;
    try {
        presetJson = manager.getCompletionPresetByName(name);
    } catch {
        presetJson = null;
    }
    if (!isPlainObj(presetJson)) return null;
    return { name, presetJson };
}

function presetSummary(presetJson) {
    try {
        // 白名单投影：剔除凭据类字段名，并对字符串值做密钥形态替换后再序列化。
        const serialized = JSON.stringify(L.redactPresetForSummary(presetJson));
        return typeof serialized === 'string' ? serialized : '';
    } catch {
        return '';
    }
}

function readSectionsCache() {
    const root = ctx && isPlainObj(ctx.extensionSettings) ? ctx.extensionSettings : null;
    if (!root) return null;
    const ns = root[L.ANTITRUNC_CACHE_NAMESPACE];
    return isPlainObj(ns) && isPlainObj(ns.sectionsCache) ? ns.sectionsCache : null;
}

function ensureSectionsCache() {
    const root = ctx && isPlainObj(ctx.extensionSettings) ? ctx.extensionSettings : null;
    if (!root) return null;
    let ns = root[L.ANTITRUNC_CACHE_NAMESPACE];
    if (!isPlainObj(ns)) {
        ns = {};
        root[L.ANTITRUNC_CACHE_NAMESPACE] = ns;
    }
    if (!isPlainObj(ns.sectionsCache)) {
        ns.sectionsCache = {};
    }
    return ns.sectionsCache;
}

// W9/W10：退出登录或登录失效清理后，若 Custom 源仍指向网关（或清理未确认），
// 清空 Custom URL/model，避免 ST deleteSecret 重新激活的用户自有 key继续发往
// 网关、或残留的网关 key 被发往第三方端点。不猜测/恢复旧 URL；用户重新选择
// 模型即可。force=true 用于 Custom 清理失败（任何 Custom URL 都清空）。
let customUrlClearInFlight = null;

// 只按 hostname 判断是否网关数据面（忽略协议/端口/路径/查询/userinfo）：
// 清理阶段宁可多清一次，也不能把「看起来不是网关」的变体留在原地。
function isGatewayDataHostUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return parsed.hostname.replace(/\.$/, '') === L.GATEWAY_DATA_HOST;
}

async function clearCustomUrlAfterLoginClear(force) {
    if (customUrlClearInFlight) return customUrlClearInFlight;
    const run = (async () => {
        const settings = freshChatSettings();
        if (!settings) return false;
        const forceClear = force === true;
        const url = settings.custom_url;
        const nonString = typeof url !== 'string';
        if (forceClear) {
            if (!nonString && url.length === 0
                && typeof settings.custom_model === 'string'
                && settings.custom_model.length === 0) {
                return false;
            }
        } else {
            if (nonString) {
                // 非字符串 URL 无法证明安全（ST 会在请求时 stringify）。
            } else if (!isGatewayDataHostUrl(url)) {
                return false;
            }
        }
        settings.custom_url = '';
        settings.custom_model = '';
        const saved = await persistSettings();
        state.settingsSaveUncertain = saved.uncertain === true;
        syncNativeCustomDisplay('', '');
        if (!saved.ok) {
            agToast('warning', '已退出登录，但清空 Custom URL/模型未确认落盘；请检查设置后再生成。');
        }
        return true;
    })();
    customUrlClearInFlight = run;
    try {
        return await run;
    } finally {
        if (customUrlClearInFlight === run) customUrlClearInFlight = null;
    }
}

// 唯一持久化键：sectionsCache[结构层指纹] = {sections, layers, layeredFingerprint,
// presetName, lastUsedAt}（明文、非敏感；凭据与 key 绝不进 extensionSettings）。
// 每预设 ≤3 条、全局 ≤20 条由 logic 按 lastUsedAt LRU 淘汰。
function saveCacheEntry(structuralKey, entry, presetName) {
    const cache = ensureSectionsCache();
    if (!cache) return false;
    L.pruneAntitruncCache(cache, entry.layeredFingerprint);
    const written = L.writeAntitruncCacheEntry(cache, structuralKey, {
        sections: entry.sections,
        layers: entry.layers,
        layeredFingerprint: entry.layeredFingerprint,
        presetName: typeof presetName === 'string' ? presetName : undefined,
        lastUsedAt: Date.now(),
    });
    if (written && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return written;
}

function touchCacheEntry(cache, structuralKey) {
    if (!cache) return;
    if (L.touchAntitruncCacheEntry(cache, structuralKey, Date.now())
        && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

// 重新读取当前预设并计算分层指纹，用于缓存命中后的竞态复核（评审 H）。
async function currentPresetLayeredFingerprint(expectedName) {
    const current = readSelectedPreset();
    if (!current || current.name !== expectedName) return null;
    const entries = L.presetEntries(current.presetJson);
    if (entries.length === 0) return null;
    return L.layeredFingerprint(entries);
}

function agToast(kind, message) {
    const toastr = window.toastr;
    if (toastr && typeof toastr[kind] === 'function') {
        // 显式转义：toastr 是 HTML sink，不依赖 ST 全局 escapeHtml 设置。
        toastr[kind](message, 'Apercus Gateway', { escapeHtml: true });
    }
}

function antitruncToast(kind, message) {
    if (window.toastr && typeof window.toastr[kind] === 'function') {
        agToast(kind, message);
        return;
    }
    if (kind === 'warning' || kind === 'error') {
        showAntitruncNote(message);
    }
}

function showAntitruncNote(message) {
    if (!els || !els.antitruncNote) return;
    els.antitruncNote.textContent = message;
    els.antitruncNote.hidden = false;
}

function hideAntitruncNote() {
    if (els && els.antitruncNote) els.antitruncNote.hidden = true;
}

function antitruncStateClass(panelState) {
    switch (panelState) {
        case L.ANTITRUNC_STATE.VALID: return 'ag-antitrunc-state-valid';
        case L.ANTITRUNC_STATE.STALE: return 'ag-antitrunc-state-stale';
        case L.ANTITRUNC_STATE.FAILED: return 'ag-antitrunc-state-failed';
        case L.ANTITRUNC_STATE.GUARDED: return 'ag-antitrunc-state-guard';
        default: return 'ag-antitrunc-state-empty';
    }
}

function renderAntitrunc() {
    if (!els || !els.antitruncButton) return;
    const bound = isPlanBound();
    if (!bound && antitrunc.enabled) {
        antitrunc.enabled = false;
        antitrunc.suggestedMaxTokens = null;
    }
    const panelState = L.antitruncPanelState({
        cacheHit: antitrunc.cacheHit,
        fingerprintExpired: antitrunc.fingerprintExpired,
        generationFailed: antitrunc.generationFailed,
        guardBlocked: antitrunc.enabled && antitrunc.guardBlocked,
        guardReason: antitrunc.guardReason,
    });
    const model = currentPlanModel();

    els.antitruncToggle.checked = antitrunc.enabled;
    els.antitruncToggle.disabled = antitrunc.generating || !bound;
    els.antitruncState.textContent = `${panelState.state}：${panelState.message}`;
    els.antitruncState.className = `ag-antitrunc-state ${antitruncStateClass(panelState.state)}`;
    els.antitruncButton.disabled = antitrunc.generating || !antitrunc.enabled || !bound || model === null;
    els.antitruncButton.textContent = antitrunc.generating
        ? '正在生成…'
        : (antitrunc.fingerprintExpired || antitrunc.generationFailed
            ? '重新生成节名单'
            : '生成节名单');
    els.antitruncCost.textContent = L.ANTITRUNC_COST_HINT
        + (model ? `（模型：${model}）` : '（未选择模型，按钮不可用。）');

    if (antitrunc.suggestedMaxTokens !== null) {
        els.antitruncSuggest.hidden = false;
        els.antitruncSuggest.disabled = !bound;
        els.antitruncSuggest.textContent = `应用建议值 max_tokens=${antitrunc.suggestedMaxTokens}`;
    } else {
        els.antitruncSuggest.hidden = true;
    }

    clear(els.antitruncSections);
    if (!Array.isArray(antitrunc.sections) || antitrunc.sections.length === 0) {
        els.antitruncSections.append(h('span', 'ag-note', '（未生成）'));
    } else {
        for (const section of antitrunc.sections) {
            els.antitruncSections.append(h('span', 'ag-chip ag-chip-section', section));
        }
    }
}

function resetAntitruncView() {
    // 作废任何在途评估的结果：调用方已明确要回到“未生成”态。
    evaluateSeq += 1;
    antitrunc.presetName = null;
    antitrunc.sections = null;
    antitrunc.layers = null;
    antitrunc.structuralFingerprint = null;
    antitrunc.layeredFingerprint = null;
    antitrunc.sectionsKey = null;
    antitrunc.rerunLayered = null;
    antitrunc.cacheHit = false;
    antitrunc.fingerprintExpired = false;
    antitrunc.generationFailed = false;
    antitrunc.suggestedMaxTokens = null;
    renderAntitrunc();
}

function applyCachedView(name, cached, structural, layered) {
    antitrunc.presetName = name;
    antitrunc.sections = cached.sections.slice();
    antitrunc.layers = { ...cached.layers };
    antitrunc.structuralFingerprint = structural;
    antitrunc.layeredFingerprint = layered;
    antitrunc.sectionsKey = cached.key;
    antitrunc.rerunLayered = layered;
    antitrunc.cacheHit = typeof structural === 'string' && structural === cached.key
        && cached.layeredFingerprint === layered;
    antitrunc.fingerprintExpired = !antitrunc.cacheHit;
    antitrunc.generationFailed = false;
    antitrunc.suggestedMaxTokens = null;
    renderAntitrunc();
}

// 缓存命中竞态/结构变动：展示已有名单但标记“过期”，注入暂停（评审 H）。
function applyStaleView(name, cached, structural, layered) {
    antitrunc.presetName = name;
    antitrunc.sections = cached.sections.slice();
    antitrunc.layers = { ...cached.layers };
    antitrunc.structuralFingerprint = structural;
    antitrunc.layeredFingerprint = layered;
    antitrunc.sectionsKey = cached.key;
    antitrunc.rerunLayered = null;
    antitrunc.cacheHit = false;
    antitrunc.fingerprintExpired = true;
    antitrunc.generationFailed = false;
    antitrunc.suggestedMaxTokens = null;
    renderAntitrunc();
}

// 惰性评估：读取当前预设 → 分层指纹 → 缓存命中/过期 → 必要时按 F1 重跑调用二。
// 任何异常只影响提醒，不打断生成。另有 in-flight 闸：同一时刻只跑一次评估。
async function evaluateAntitrunc(options = {}) {
    if (!antitrunc.supported || !els) return;
    if (antitrunc.generating) return;
    if (antitrunc.evaluating) {
        antitrunc.evaluatePending = true;
        return;
    }
    antitrunc.evaluating = true;
    const seq = ++evaluateSeq;
    try {
        const preset = readSelectedPreset();
        if (!preset) {
            resetAntitruncView();
            return;
        }
        const entries = L.presetEntries(preset.presetJson);
        if (entries.length === 0) {
            // 预设结构无法读取：不猜测、不生成。
            resetAntitruncView();
            return;
        }
        const layered = await L.layeredFingerprint(entries);
        if (!layered) {
            resetAntitruncView();
            return;
        }
        if (seq !== evaluateSeq) return;

        const cache = readSectionsCache();
        const cached = L.findAntitruncCacheEntry(cache, layered);
        if (cached) {
            const structural = await L.structuralFingerprint(entries, cached.layers);
            if (seq !== evaluateSeq) return;
            // 命中后复核当前预设的分层/结构指纹，读取期间预设可能已变（评审 H）。
            const freshLayered = await currentPresetLayeredFingerprint(preset.name);
            if (seq !== evaluateSeq) return;
            if (structural !== cached.key || cached.layeredFingerprint !== layered || freshLayered !== layered) {
                applyStaleView(preset.name, cached, structural, layered);
                return;
            }
            touchCacheEntry(cache, cached.key);
            applyCachedView(preset.name, cached, structural, layered);
            return;
        }

        const samePreset = antitrunc.presetName !== null && antitrunc.presetName === preset.name;
        if (samePreset && antitrunc.layers
            && options.allowLayerRerun !== false
            && antitrunc.rerunLayered !== layered) {
            await rerunLayersForPreset(preset, entries, layered, seq);
            return;
        }
        if (samePreset && antitrunc.sections) {
            // 预设有变动但当前不能/无需重跑调用二：按过期处理，注入暂停。
            antitrunc.layeredFingerprint = layered;
            antitrunc.cacheHit = false;
            antitrunc.fingerprintExpired = true;
            renderAntitrunc();
            return;
        }
        resetAntitruncView();
    } catch {
        // 评估失败不影响生成。
    } finally {
        antitrunc.evaluating = false;
        if (antitrunc.evaluatePending) {
            antitrunc.evaluatePending = false;
            void evaluateAntitrunc({ allowLayerRerun: true });
        }
    }
}

async function rerunLayersForPreset(preset, entries, layered, seq) {
    const model = currentPlanModel();
    if (!antitrunc.enabled || !isPlanBound() || model === null) {
        antitrunc.presetName = preset.name;
        antitrunc.layeredFingerprint = layered;
        antitrunc.cacheHit = false;
        antitrunc.fingerprintExpired = true;
        renderAntitrunc();
        return;
    }
    const layers = await requestLayers(entries);
    if (seq !== evaluateSeq) return;
    antitrunc.rerunLayered = layered;
    const structural = await L.structuralFingerprint(entries, layers);
    if (seq !== evaluateSeq) return;

    const previousSectionsKey = antitrunc.sectionsKey;
    antitrunc.presetName = preset.name;
    antitrunc.layers = layers;
    antitrunc.structuralFingerprint = structural;
    antitrunc.layeredFingerprint = layered;

    if (typeof structural === 'string' && structural === previousSectionsKey && antitrunc.sections) {
        // 内容层变动（或重分类后结构集合不变）：旧名单仍有效，只更新分层缓存。
        saveCacheEntry(structural, {
            sections: antitrunc.sections,
            layers,
            layeredFingerprint: layered,
        }, preset.name);
        antitrunc.cacheHit = true;
        antitrunc.fingerprintExpired = false;
        antitrunc.generationFailed = false;
        antitrunc.suggestedMaxTokens = null;
    } else {
        // 结构层变动：黄条提醒重新生成，生成前注入暂停。
        antitrunc.cacheHit = false;
        antitrunc.fingerprintExpired = true;
    }
    renderAntitrunc();
}

function onAntitruncToggleChange() {
    antitrunc.enabled = !!(els && els.antitruncToggle && els.antitruncToggle.checked);
    if (!antitrunc.enabled) {
        hideAntitruncNote();
        antitrunc.suggestedMaxTokens = null;
    } else {
        void evaluateAntitrunc({ allowLayerRerun: true });
    }
    renderAntitrunc();
}

// F11：预设切换 / 生成设置就绪时，若活动 custom_url 已指向非网关域而插件仍
// 可能持有 Custom key（本地记录 true 或未知），调服务端按信封归属清理插件
// 自有 api_key_custom 条目；用户自有值由服务端按值排除。清理是幂等的，服务端
// 在无绑定/未授权时也返回 200。同 URL 短窗节流只用于非阻塞 PRESET_CHANGED
// 提示路径的事件去重（I2：窗口 5 秒，且任何“key 可能被重写”的会话点都重置
// 节流，不复用旧窗口）。J2：阻塞型清理（CHAT_COMPLETION_SETTINGS_READY 与
// OAI_PRESET_CHANGED_BEFORE）不做节流——另一标签可能在窗口内重写 key，跳过
// 清理会让 ST 生成继续使用本插件的旧 key；服务端幂等，重复请求无副作用。
// G3：CHAT_COMPLETION_SETTINGS_READY 的调用方（ST）会 await 监听器返回值，
// 因此该路径必须返回清理 Promise；不能取消生成，但必须等清理完成再发请求。
const CUSTOM_CLEANUP_MIN_INTERVAL_MS = 5 * 1000;

// I2：apply 成功、logout 成功、授权世代切换（approved/refresh 在 UI 侧的表现）
// 都会让“插件可能又持有 Custom key”，旧的同 URL 节流窗口不得跨这些点复用。
function resetCustomCleanupThrottle() {
    antitrunc.cleanupAttemptUrl = null;
    antitrunc.cleanupAttemptAt = 0;
}

// I1：custom_url 非字符串（数组/对象/数字等）时也按原值取用，交给
// isNonGatewayCustomUrl 判定（无法证明是网关即触发幂等清理）。
function resolveCleanupUrl(generateData) {
    if (isPlainObj(generateData)) {
        const value = generateData.custom_url;
        if (value !== undefined && value !== null && value !== '') return value;
    }
    const settings = freshChatSettings();
    if (!settings) return '';
    const value = settings.custom_url;
    return value === undefined || value === null ? '' : value;
}

// 返回 Promise：所有早退路径返回已 resolve 的 Promise；实际清理等待
// /release-custom-key 完成（包含 read_failed/残留失败分支），绝不在事件
// 监听器里 fire-and-forget 后让 ST 抢先发请求。Promise 解析为
// {cleared:true} 或 {cleared:false}（早退/失败），供调用方如实提示。
// options.force（I3）：跳过 URL 闸与节流，用于 /apply-model 返回后确认接入已
// 取消时的“本次已写 key 必须回收”路径（此时 URL 可能仍是网关 base）。
// options.throttle（J2）：仅非阻塞 PRESET_CHANGED 提示路径使用 5 秒同 URL
// 节流；阻塞路径（SETTINGS_READY / PRESET_CHANGED_BEFORE）必须始终请求。
function cleanupCustomKey(generateData, options) {
    if (!els) return Promise.resolve();
    const force = isPlainObj(options) && options.force === true;
    const throttle = isPlainObj(options) && options.throttle === true;
    // H2：不按本地 customKeyPresent 快速短路——该标记是单标签页展示缓存，
    // 另一标签页写入插件 key 后本页的 false 会漏清。非网关 URL 时始终请求
    // 服务端（幂等、按信封归属）。
    const url = resolveCleanupUrl(generateData);
    if (!force && !L.isNonGatewayCustomUrl(url)) return Promise.resolve();
    if (antitrunc.cleanupInFlight && antitrunc.cleanupPromise) {
        return antitrunc.cleanupPromise;
    }
    const now = Date.now();
    if (!force && throttle && url === antitrunc.cleanupAttemptUrl
        && now - antitrunc.cleanupAttemptAt < CUSTOM_CLEANUP_MIN_INTERVAL_MS) {
        return Promise.resolve();
    }
    if (throttle) {
        antitrunc.cleanupAttemptUrl = url;
        antitrunc.cleanupAttemptAt = now;
    }
    antitrunc.cleanupInFlight = true;
    const pending = request('/release-custom-key', { method: 'POST', body: '{}' })
        .then((result) => {
            const payload = result.ok && isPlainObj(result.json) ? result.json : null;
            if (result.ok && payload && payload.cleared === true) {
                antitrunc.customKeyPresent = false;
                agToast('info', '已清理插件写入酒馆 Custom 源的本插件 key（用户自有 key 未触碰）。');
                return { cleared: true };
            }
            if (result.ok && payload && payload.reason === 'read_failed') {
                // G8：服务端读取信信封失败，归属未知；保持 null 让后续事件重试。
                antitrunc.customKeyPresent = null;
                agToast('warning', '插件 Custom key 清理未能确认归属（读取绑定失败）：将在后续事件重试，或请退出登录清理。');
                return { cleared: false, reason: 'read_failed' };
            }
            if (result.ok && payload && payload.cleared === false) {
                agToast('warning', '插件 Custom key 未能清理干净：请到酒馆密钥设置检查，或退出登录重试。');
                return { cleared: false, reason: 'residual' };
            }
            agToast('warning', `插件 Custom key 清理请求失败：${describeError(result, '服务端未确认清理')}。请退出登录后重试。`);
            return { cleared: false };
        })
        .catch(() => {
            // 清理失败不影响生成/预设切换；保留 customKeyPresent 供重试。
            return { cleared: false };
        })
        .finally(() => {
            antitrunc.cleanupInFlight = false;
            antitrunc.cleanupPromise = null;
        });
    antitrunc.cleanupPromise = pending;
    return pending;
}

function maybeCleanupCustomKey() {
    try {
        // J2：只有这条非阻塞提示路径保留同 URL 短窗节流。
        void cleanupCustomKey(undefined, { throttle: true });
    } catch {
        // 附加清理绝不打断预设切换。
    }
}

// H1：OAI_PRESET_CHANGED_BEFORE 在 ST 应用预设差异/触发
// #chat_completion_source change（其处理器会 reconnect/status，早于
// PRESET_CHANGED 读取 api_key_custom）之前发出。ST 1.17.0 的
// eventSource.emit 会 await 监听器返回值，openai.js 在该 Promise 的 finally
// 里才应用设置；因此这里返回清理 Promise 即可让 /release-custom-key 先完成，
// 再让酒馆自动重连/状态请求看到已清理的 Custom key。功能缺失时返回 undefined。
// 不依赖页面 customKeyPresent 标记（H2）：即将应用的 URL 非网关即请求幂等清理。
function presetCarriesCustomUrl(payload) {
    if (!isPlainObj(payload) || !isPlainObj(payload.preset)) return false;
    if (!Object.hasOwn(payload.preset, 'custom_url')) return false;
    // bind_preset_to_connection 关闭时 ST 不应用连接字段，URL 仍归本次流程。
    if (isPlainObj(payload.settings) && payload.settings.bind_preset_to_connection === false) {
        return false;
    }
    return true;
}

function onPresetChangedBefore(payload) {
    try {
        if (isPlainObj(payload) && typeof payload.apiId === 'string'
            && payload.apiId !== 'openai') {
            return undefined;
        }
        // W8b：预设切换从“即将应用”起就作废接入推导；若预设不拥有 URL，
        // 取消/失败时可以恢复本次流程写入前的设置。
        presetChangeSeq += 1;
        presetOwnsCustomUrl = presetCarriesCustomUrl(payload);
        const current = freshChatSettings();
        const currentUrl = current && typeof current.custom_url === 'string'
            ? current.custom_url
            : '';
        const upcoming = L.pendingPresetCustomUrl(payload, currentUrl);
        if (!L.isNonGatewayCustomUrl(upcoming)) return undefined;
        return cleanupCustomKey({ custom_url: upcoming });
    } catch {
        // 清理绝不能打断预设切换。
        return undefined;
    }
}

function onPresetChanged(payload) {
    try {
        if (!isPlainObj(payload) || payload.apiId !== 'openai') return;
        // F11：切到第三方 Custom URL 时清理插件自有 key（异步、幂等）。
        maybeCleanupCustomKey();
        // 作废在途评估：预设内容/选择已变，旧结果不得再落面板。
        evaluateSeq += 1;
        // W8：预设已应用；接入流程的旧快照不再代表当前配置。
        presetChangeSeq += 1;
        presetOwnsCustomUrl = presetCarriesCustomUrl(payload);
        antitrunc.suggestedMaxTokens = null;
        antitrunc.floorToastValue = null;
        if (typeof payload.name === 'string' && payload.name.length > 0
            && antitrunc.presetName !== null && payload.name !== antitrunc.presetName) {
            resetAntitruncView();
        }
        void evaluateAntitrunc({ allowLayerRerun: true });
    } catch {
        // 提醒失败不影响预设切换。
    }
}

function onChatCompletionSettingsReady(generateData) {
    try {
        // F11/G3：活动 custom_url 落到第三方域时清理插件自有 Custom key。ST 会
        // await 监听器返回值，所以这里把清理 Promise 返回给 ST：清理未完成前
        // 不得发出生成请求；清理失败只 toast，不取消生成。
        const cleanup = cleanupCustomKey(generateData);
        // 开关关闭/功能不支持时不进入注入流程，但插件旧键清理仍必须执行（评审 B）。
        cleanStaleAntitruncBody(generateData);
        if (!antitrunc.supported || !antitrunc.enabled) return cleanup;
        // ST 的 emit 会 await 监听器返回值：返回 Promise 保证合并结果先于请求发出。
        // 任何注入异常都必须吞掉，绝不能打断原生成流程。
        const injection = Promise.resolve(injectAntitrunc(generateData)).catch(() => undefined);
        return Promise.all([cleanup, injection]).then(() => undefined);
    } catch {
        // 注入是附加能力：任何异常都不允许打断原生成流程。
        return undefined;
    }
}

function clipReason(reason) {
    const text = typeof reason === 'string' && reason.length > 0 ? reason : '未知原因';
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

async function requestPlan(model, prompt) {
    const result = await request('/plan', {
        method: 'POST',
        body: JSON.stringify({ model, prompt }),
        timeoutMs: PLAN_TIMEOUT_MS,
    });
    if (!result.ok) {
        // W10b：/plan 的 409 not_connected 可能是数据面 401 触发的登录失效；
        // 立即刷新状态，让 W9/W10 的 Custom URL 清理在本次失败后执行，而不是
        // 等到下一次周期状态刷新。
        if (isLoginInvalidResult(result)) {
            // 先强制清空 Custom URL，再刷新状态：即使 /status 慢/失败，也不能
            // 让可能残留的 key 继续发往网关或第三方端点。
            await clearCustomUrlAfterLoginClear(true);
            reportLoginInvalid((message) => antitruncToast('warning', message));
        }
        return { ok: false, text: '', summary: describeError(result, '分节规划请求失败') };
    }
    if (!isPlainObj(result.json) || typeof result.json.text !== 'string') {
        return { ok: false, text: '', summary: 'plan 响应不是 {text} 形态' };
    }
    return { ok: true, text: result.json.text, summary: null };
}

// 调用二：解析失败重试一次；仍失败按全部条目 structural（保守取向）。
// 传输层失败不再叠加 UI 重试（服务端已重试一次），直接按全 structural。
async function requestLayers(entries, modelOverride) {
    const model = typeof modelOverride === 'string' && modelOverride.length > 0
        ? modelOverride
        : currentPlanModel();
    if (model === null) return L.allStructuralLayers(entries);
    // 编号制：提示词与解析共用同一份输入元数据（truncatedIndexes 透传给
    // parseLayers，被截断条目强制 structural）。
    const input = L.buildLayersPromptWithMeta(entries);
    let attempt = await requestPlan(model, input.prompt);
    let parsed = attempt.ok
        ? L.parseLayers(attempt.text, entries, input)
        : { ok: false, layers: L.allStructuralLayers(entries), reason: attempt.summary };
    if (!parsed.ok && attempt.ok) {
        const retryPrompt = `${input.prompt}\n\n上一次尝试失败（${clipReason(parsed.reason)}）。请严格只输出要求的 JSON 对象。`;
        attempt = await requestPlan(model, retryPrompt);
        parsed = attempt.ok
            ? L.parseLayers(attempt.text, entries, input)
            : { ok: false, layers: L.allStructuralLayers(entries), reason: attempt.summary };
    }
    return parsed.layers;
}

function markGenerationFailed(message) {
    antitrunc.generationFailed = true;
    antitrunc.cacheHit = false;
    antitrunc.fingerprintExpired = false;
    renderAntitrunc();
    antitruncToast('error', message);
}

async function generateSections() {
    if (!antitrunc.supported || antitrunc.generating) return;
    if (!antitrunc.enabled) return;
    if (!isPlanBound()) {
        antitruncToast('warning', '尚未连接 Apercus 网关，无法生成节名单。');
        return;
    }
    const preset = readSelectedPreset();
    if (!preset) {
        antitruncToast('warning', '未读取到选中的 OpenAI 预设。');
        return;
    }
    const model = currentPlanModel();
    if (model === null) {
        antitruncToast('warning', '尚未选择模型：请先在模型列表确认一个 chat 模型（不再回退生成请求里的模型）。');
        return;
    }
    const entries = L.presetEntries(preset.presetJson);
    if (entries.length === 0) {
        markGenerationFailed('预设结构无法读取（prompts / prompt_order 形态不符），未生成节名单。');
        return;
    }

    antitrunc.generating = true;
    // 作废在途评估：手动生成的结果优先，避免旧评估回写覆盖。
    evaluateSeq += 1;
    antitrunc.generationFailed = false;
    hideAntitruncNote();
    renderAntitrunc();
    try {
        const layered = await L.layeredFingerprint(entries);
        if (!layered) {
            markGenerationFailed('无法计算预设指纹，未生成节名单。');
            return;
        }

        // 缓存命中且结构/分层指纹仍匹配 → 不重复调用。
        const cache = readSectionsCache();
        const cached = L.findAntitruncCacheEntry(cache, layered);
        if (cached) {
            const structuralNow = await L.structuralFingerprint(entries, cached.layers);
            const freshLayered = await currentPresetLayeredFingerprint(preset.name);
            if (structuralNow === cached.key && cached.layeredFingerprint === layered && freshLayered === layered) {
                touchCacheEntry(cache, cached.key);
                applyCachedView(preset.name, cached, structuralNow, layered);
                antitruncToast('info', `已使用缓存节名单：${cached.sections.join('、')}`);
                return;
            }
            if (cached.layeredFingerprint !== layered || freshLayered !== layered) {
                // 缓存命中竞态：读取后预设已变，不能拿旧条目继续生成（评审 H）。
                applyStaleView(preset.name, cached, structuralNow, layered);
                antitruncToast('warning', '预设已变动，请重新生成节名单。');
                return;
            }
            // 结构指纹变化：缓存过期，继续走完整生成。
        }

        // 调用一（主，出清单）。
        const sectionsPrompt = L.buildSectionsPrompt(presetSummary(preset.presetJson));
        let attempt = await requestPlan(model, sectionsPrompt);
        let parsed = attempt.ok
            ? L.parseSections(attempt.text)
            : { ok: false, reason: attempt.summary };
        if (!parsed.ok && attempt.ok) {
            const retryPrompt = `${sectionsPrompt}\n\n上一次尝试失败（${clipReason(parsed.reason)}）。请严格只输出要求的 JSON 对象（sections 数组）。`;
            attempt = await requestPlan(model, retryPrompt);
            parsed = attempt.ok
                ? L.parseSections(attempt.text)
                : { ok: false, reason: attempt.summary };
        }
        if (!parsed.ok) {
            markGenerationFailed(`生成失败：${clipReason(parsed.reason)}。`);
            return;
        }

        // 调用二（次，结构分层）——调用一成功后才跑；同一模型选择。
        const layers = await requestLayers(entries, model);
        const structural = await L.structuralFingerprint(entries, layers);
        if (!structural) {
            markGenerationFailed('无法计算结构指纹，未生成节名单。');
            return;
        }

        saveCacheEntry(structural, {
            sections: parsed.sections,
            layers,
            layeredFingerprint: layered,
        }, preset.name);

        // 生成期间预设可能被切换：结果按发起时预设保存，但不要把旧预设的
        // 名单盖到新预设的运行态上。
        const current = readSelectedPreset();
        let switched = current === null || current.name !== preset.name;
        if (!switched) {
            const currentEntries = L.presetEntries(current.presetJson);
            const currentLayered = currentEntries.length > 0
                ? await L.layeredFingerprint(currentEntries)
                : null;
            switched = currentLayered !== layered;
        }
        antitrunc.generationFailed = false;
        if (switched) {
            antitrunc.refreshAfterGeneration = true;
            antitruncToast('info', '规划已完成，但检测到预设已切换：结果已按发起时预设保存，请在新预设下重新生成。');
            return;
        }

        antitrunc.presetName = preset.name;
        antitrunc.sections = parsed.sections.slice();
        antitrunc.layers = layers;
        antitrunc.structuralFingerprint = structural;
        antitrunc.layeredFingerprint = layered;
        antitrunc.sectionsKey = structural;
        antitrunc.rerunLayered = layered;
        antitrunc.cacheHit = true;
        antitrunc.fingerprintExpired = false;
        antitrunc.suggestedMaxTokens = null;
        antitruncToast('success', `已生成节名单：${parsed.sections.join('、')}`);
    } catch {
        markGenerationFailed('生成失败：内部错误。');
    } finally {
        antitrunc.generating = false;
        renderAntitrunc();
        if (antitrunc.refreshAfterGeneration) {
            antitrunc.refreshAfterGeneration = false;
            void evaluateAntitrunc({ allowLayerRerun: true });
        }
    }
}

function applySuggestedMaxTokens() {
    const value = antitrunc.suggestedMaxTokens;
    if (!Number.isInteger(value)) return;
    const settings = freshChatSettings();
    if (!settings || typeof settings.openai_max_tokens !== 'number') {
        antitruncToast('warning', '无法应用建议值：未找到可写的 max_tokens 设置项。');
        return;
    }
    // U3：应用前计算可用提示预算；floor >= 预算（含预算未知时的非法值）不写，
    // 避免把提示预算压成负数。预算未知（null）保持旧行为允许写入。
    const budget = readContextLimit();
    if (!L.maxTokensFitsBudget(value, budget)) {
        const budgetText = budget === null ? '未知' : String(budget);
        antitruncToast('warning', `建议值 max_tokens=${value} 不小于可用预算 ${budgetText}，未应用：需先调高上下文/降低输出预算。`);
        return;
    }
    // 用户点击才写，不静默覆盖。
    settings.openai_max_tokens = value;
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    antitrunc.suggestedMaxTokens = null;
    renderAntitrunc();
    antitruncToast('success', `已应用建议值 max_tokens=${value}。`);
}

function markGuard(reason) {
    const first = !antitrunc.guardBlocked;
    antitrunc.guardBlocked = true;
    antitrunc.guardReason = reason;
    renderAntitrunc();
    if (first && !antitrunc.guardToastShown) {
        antitrunc.guardToastShown = true;
        // 按 reason 显示具体字段，不再一律说“函数调用开启”。
        antitruncToast('warning', L.antitruncGuardMessage(reason));
    }
}

// 清理插件上一次写入的旧键（评审 B / U6）：仅当当前 body 与 lastInjectedBody
// 完全相等时移除两键；用户改过的 body（键序、其他字段、同名键值变化）不触碰。
// 所有早退路径（开关关/未连接/非网关目标/清单失效/守卫触发）都先经过这里。
function cleanStaleAntitruncBody(generateData) {
    if (!isPlainObj(generateData) || typeof generateData.custom_include_body !== 'string') return;
    const last = antitrunc.lastInjectedBody;
    if (typeof last !== 'string') return;
    if (!L.isStaleAntitruncBody(generateData.custom_include_body, last)) return;
    generateData.custom_include_body = L.stripAntitruncKeys(generateData.custom_include_body);
    antitrunc.lastInjectedBody = null;
}

async function injectAntitrunc(generateData) {
    const data = isPlainObj(generateData) ? generateData : null;
    if (!data) return;
    // 先清理插件旧键：开关关/未连接/非网关目标/清单失效/守卫触发等所有早退
    // 路径都已经过这里（开关关的路径在 onChatCompletionSettingsReady 里调用）。
    cleanStaleAntitruncBody(data);
    if (!isPlanBound()) {
        // 未授权：开关回落关闭（renderAntitrunc 统一处理），本次不注入。
        renderAntitrunc();
        return;
    }

    const settings = freshChatSettings();
    if (!settings) return;
    const target = {
        chat_completion_source: settings.chat_completion_source,
        custom_url: typeof data.custom_url === 'string' ? data.custom_url : settings.custom_url,
    };
    // 第三道闸的固定域检查：非网关目标安静跳过（塞了无意义还漏信息）。
    if (!L.isGatewayCustomTarget(target)) return;
    if (antitrunc.generationFailed) {
        // 生成失败后保持关闭，直到用户点击重试成功（无回退名单）。
        showAntitruncNote('生成失败：本次未注入，请点击“重新生成节名单”重试。');
        return;
    }
    if (typeof data.custom_include_body !== 'string') {
        showAntitruncNote('防截断注入面仅 Custom OpenAI-compatible 源可用（custom_include_body）；当前生成未携带注入面，未注入。');
        return;
    }

    // 守卫直接检查打包完的请求形态（不区分谁开的）。先做顶层检查：
    // 即使节名单未生成/过期，也要让状态条反映当前请求的守卫事实。
    // generate_data 走默认口径：messages 缺失/非数组/空都算触发。
    const guards = L.checkAntitruncGuards(data);
    if (!guards.ok) {
        markGuard(guards.reason);
        return;
    }
    antitrunc.guardBlocked = false;
    antitrunc.guardReason = null;
    antitrunc.guardToastShown = false;
    renderAntitrunc();

    const preset = readSelectedPreset();
    if (!preset) {
        showAntitruncNote('未读取到选中的 OpenAI 预设，本次未注入。');
        return;
    }
    const entries = L.presetEntries(preset.presetJson);
    if (entries.length === 0) {
        showAntitruncNote('预设结构无法读取，本次未注入。');
        return;
    }
    const layered = await L.layeredFingerprint(entries);
    if (!layered) {
        showAntitruncNote('无法计算预设指纹，本次未注入。');
        return;
    }
    const cache = readSectionsCache();
    const cached = L.findAntitruncCacheEntry(cache, layered);
    if (!cached || cached.layeredFingerprint !== layered) {
        showAntitruncNote('节名单未生成或已过期：本次未注入，请生成/重新生成节名单。');
        // 惰性触发 F1：同一预设内容变动后重跑调用二（in-flight 闸防重复计费）。
        void evaluateAntitrunc({ allowLayerRerun: true });
        return;
    }
    const structural = await L.structuralFingerprint(entries, cached.layers);
    // 缓存命中也要复核当前预设的分层指纹：读取/等待期间预设可能已变（评审 H）。
    const freshLayered = await currentPresetLayeredFingerprint(preset.name);
    if (!structural || structural !== cached.key || freshLayered !== layered) {
        applyStaleView(preset.name, cached, structural, layered);
        showAntitruncNote('预设结构已变动，点击重新生成；生成前防截断暂停。本次未注入。');
        return;
    }
    touchCacheEntry(cache, cached.key);

    // 顶层守卫已在前面检查；合并后的 custom_include_body 由 merge 再做一次
    // （合并体口径：messages 可以缺席，只有“存在但非法”才触发）。U6：只有
    // body 与 lastInjectedBody 完全相等才视为插件自有；用户同名键优先。
    const merged = L.mergeAntitruncBody(data.custom_include_body, cached.sections, {
        lastInjectedBody: antitrunc.lastInjectedBody,
    });
    if (!merged.ok) {
        if (typeof merged.reason === 'string' && merged.reason.startsWith('antitrunc_guard_')) {
            markGuard(merged.reason);
            return;
        }
        if (merged.reason === 'antitrunc_body_user_override') {
            showAntitruncNote('防截断分节未注入：custom_include_body 里已有同名的 apercus_antitrunc 键且值不同，按用户内容优先跳过；如需插件注入请先移除这两个用户键。');
            return;
        }
        showAntitruncNote(merged.reason === 'antitrunc_body_unparseable'
            ? '防截断分节未注入：custom_include_body 不是 JSON（可能为 YAML），无法安全合并。'
            : '防截断分节未注入：合并校验未通过。');
        return;
    }
    data.custom_include_body = merged.body;
    antitrunc.lastInjectedBody = merged.body;

    // 注入成功即同步运行态（缓存命中、指纹有效）。
    antitrunc.presetName = preset.name;
    antitrunc.sections = cached.sections.slice();
    antitrunc.layers = { ...cached.layers };
    antitrunc.structuralFingerprint = structural;
    antitrunc.layeredFingerprint = layered;
    antitrunc.sectionsKey = cached.key;
    antitrunc.cacheHit = true;
    antitrunc.fingerprintExpired = false;
    antitrunc.generationFailed = false;
    hideAntitruncNote();

    const tokensNow = typeof data.max_tokens === 'number' && Number.isFinite(data.max_tokens)
        ? data.max_tokens
        : (typeof data.max_completion_tokens === 'number' && Number.isFinite(data.max_completion_tokens)
            ? data.max_completion_tokens
            : null);
    const floor = L.antitruncFloorTokens(cached.sections.length);
    if (tokensNow !== null && floor !== null && tokensNow < floor) {
        antitrunc.suggestedMaxTokens = floor;
        if (antitrunc.floorToastValue !== floor) {
            antitrunc.floorToastValue = floor;
            antitruncToast('warning', `防截断分节：max_tokens ${tokensNow} 低于建议下限 ${floor}，正文可能被截断。`);
        }
    } else {
        antitrunc.suggestedMaxTokens = null;
        antitrunc.floorToastValue = null;
    }
    renderAntitrunc();
}

// F7：ST 1.17.0 在 online_status 变化时 emitAndWait(ONLINE_STATUS_CHANGED,
// online_status)（script.js:7053-7057）。特性检测订阅；payload 是状态字符串，
// 同步进最新 ctx 并重渲染状态行（绝不把插件判定写成“已连接”）。
function onOnlineStatusChanged(value) {
    try {
        refreshCtx();
        if (ctx && typeof value === 'string') ctx.onlineStatus = value;
        renderStatus();
    } catch {
        // 状态显示失败不影响生成。
    }
}

function init() {
    ctx = getContext();
    if (!ctx) return;
    antitrunc.supported = detectAntitruncSupport();
    attach();
    const events = ctx.event_types;
    const canListen = isPlainObj(events) && ctx.eventSource
        && typeof ctx.eventSource.on === 'function';
    // G3：F11 清理钩子不依赖 antitrunc.supported，只要事件源与设置可用就注册；
    // B2 生成/评估逻辑仍在 supported 门内。
    if (canListen && typeof events.PRESET_CHANGED === 'string') {
        ctx.eventSource.on(events.PRESET_CHANGED, onPresetChanged);
    }
    // H1：特性检测订阅（ST 1.17.0 events.js 有该事件）；监听器返回清理 Promise，
    // emit 会 await 它，从而阻塞后续 source change/reconnect。
    if (canListen && typeof events.OAI_PRESET_CHANGED_BEFORE === 'string') {
        ctx.eventSource.on(events.OAI_PRESET_CHANGED_BEFORE, onPresetChangedBefore);
    }
    if (canListen && typeof events.CHAT_COMPLETION_SETTINGS_READY === 'string') {
        ctx.eventSource.on(events.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    }
    if (antitrunc.supported) {
        void evaluateAntitrunc({ allowLayerRerun: false });
    }
    // 上下文计量独立于防截断：事件存在才订阅（ST 1.17.0 events.js 有该事件）。
    if (canListen && typeof events.GENERATE_AFTER_DATA === 'string') {
        ctx.eventSource.on(events.GENERATE_AFTER_DATA, onGenerateAfterData);
    }
    if (canListen && typeof events.ONLINE_STATUS_CHANGED === 'string') {
        ctx.eventSource.on(events.ONLINE_STATUS_CHANGED, onOnlineStatusChanged);
    }
    // G7：页面卸载/隐藏时清理周期状态刷新与连接轮询。
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', cleanupTimers);
        window.addEventListener('beforeunload', cleanupTimers);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
