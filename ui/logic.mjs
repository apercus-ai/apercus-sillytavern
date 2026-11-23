/**
 * Pure data and gating logic for the Apercus Gateway SillyTavern extension.
 *
 * This module deliberately has no SillyTavern imports and no side effects so it
 * can be exercised with node:test. Every function returns new values; nothing
 * here writes settings, secrets, or request state.
 *
 * Source contracts:
 * - Gateway catalog fields: docs/api/api.md data-5 (`items[].name`,
 *   `protocol_faces`, `modality`, `capabilities`, optional `classification_name`).
 * - Gateway balance fields: docs/api/api.md query-2 (`permanent_balance`,
 *   `debt`, `daily_quota`, `daily_quota_used`, `daily_quota_remaining`,
 *   `quota_date`, `needs_refresh`, `observed_at`).
 * - ST plugin routes: /api/plugins/apercus-gateway status (v3 state machine),
 *   models, balance, connect, connect/status and logout. Connect responses
 *   carry only status + authorize_url; no credential ever reaches this module.
 */

export const PROTOCOLS = Object.freeze(['chat', 'responses', 'anthropic', 'image', 'tts', 'embedding', 'video']);
export const MODALITIES = Object.freeze(['text', 'image', 'embedding', 'tts', 'video']);
export const STATUS_PROTOCOLS = Object.freeze(['chat', 'anthropic', 'responses']);

export const MAX_CATALOG_ITEMS = 500;
export const MAX_RESPONSE_BYTES = 262144;

const MODEL_MAX_LENGTH = 512;
const DECIMAL_6 = /^\d+\.\d{6}$/;
const QUOTA_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** @param {string} value */
function isValidQuotaDate(value) {
    if (!QUOTA_DATE.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

/** @param {unknown} value */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize one catalog item, keeping only contract fields. Invalid entries
 * return null; no defaults are invented.
 * @param {unknown} item
 */
export function normalizeModelItem(item) {
    if (!isPlainObject(item)) return null;
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > MODEL_MAX_LENGTH) return null;
    const name = item.name;

    if (!Array.isArray(item.protocol_faces)) return null;
    const faces = [];
    for (const face of item.protocol_faces) {
        if (typeof face !== 'string' || !PROTOCOLS.includes(face)) return null;
        if (!faces.includes(face)) faces.push(face);
    }

    if (typeof item.modality !== 'string' || !MODALITIES.includes(item.modality)) return null;
    if (typeof item.capabilities !== 'string') return null;

    let classificationName = null;
    if (Object.hasOwn(item, 'classification_name')) {
        if (!isNonEmptyString(item.classification_name)) return null;
        classificationName = item.classification_name.trim();
    }

    const normalized = {
        name,
        protocol_faces: Object.freeze(faces),
        modality: item.modality,
        capabilities: item.capabilities,
    };
    if (classificationName !== null) {
        normalized.classification_name = classificationName;
    }
    return Object.freeze(normalized);
}

/**
 * Validate the `{ items: [...] }` catalog envelope and drop invalid entries.
 * @param {unknown} payload
 */
export function classifyCatalog(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
        return { ok: false, reason: 'catalog_envelope_invalid', items: [], invalidCount: 0, truncated: false };
    }
    const items = [];
    let invalidCount = 0;
    let truncated = false;
    for (let index = 0; index < payload.items.length; index += 1) {
        if (items.length >= MAX_CATALOG_ITEMS) {
            truncated = true;
            break;
        }
        const normalized = normalizeModelItem(payload.items[index]);
        if (normalized === null) {
            invalidCount += 1;
            continue;
        }
        items.push(normalized);
    }
    return { ok: true, reason: null, items: Object.freeze(items), invalidCount, truncated };
}

/**
 * Select a protocol face for a model from protocol_faces only.
 * chat wins when present. anthropic is always disabled in this delivery because
 * no verified safe anthropic adapter exists. responses-only, unsupported faces,
 * malformed entries, and empty faces also stay disabled.
 * @param {unknown} rawItem
 */
export function faceForModel(rawItem) {
    const normalized = normalizeModelItem(rawItem);
    if (normalized === null) {
        return { face: null, disabled: true, reason: 'invalid_entry' };
    }
    const faces = normalized.protocol_faces;
    if (faces.includes('chat')) {
        return { face: 'chat', disabled: false, reason: null };
    }
    if (faces.includes('anthropic')) {
        return { face: 'anthropic', disabled: true, reason: 'anthropic_adapter_unavailable' };
    }
    if (faces.includes('responses')) {
        return { face: null, disabled: true, reason: 'responses_not_enabled' };
    }
    return { face: null, disabled: true, reason: 'face_not_enabled' };
}

// v3 /status 状态机（B1 v1.35）：state 四态 + 酒馆侧连接 st_connection。
// connected 恒 false（插件从不代替酒馆报告连接）；「已授权」只在 state
// authorized 时成立，且不等于「已连接」。
export const STATUS_STATES = Object.freeze(['not_connected', 'pending', 'authorized', 'invalid']);
export const ST_CONNECTION_STATES = Object.freeze(['connected', 'unknown']);
export const CONNECT_STATUS_STATES = Object.freeze(['connecting', 'pending', 'authorized', 'invalid']);
export const GATEWAY_HOST = 'gw.apercus.ai';

function isNonEmptyBoundedString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !/[\r\n\x00-\x1f\x7f]/.test(value);
}

/**
 * Validate the plugin status payload (v3). Missing or wrongly typed v3 fields
 * make the status unusable; no protocol is assumed to be available. Legacy
 * display fields are optional but strict when present.
 * @param {unknown} payload
 */
export function parseStatus(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: 'status_envelope_invalid' };
    if (typeof payload.state !== 'string' || !STATUS_STATES.includes(payload.state)) {
        return { ok: false, reason: 'status_state_invalid' };
    }
    if (payload.reason !== undefined && !isNonEmptyBoundedString(payload.reason, 512)) {
        return { ok: false, reason: 'status_reason_invalid' };
    }
    if (payload.username !== undefined && !isNonEmptyBoundedString(payload.username, 512)) {
        return { ok: false, reason: 'status_username_invalid' };
    }
    if (!isPlainObject(payload.st_connection)
        || typeof payload.st_connection.state !== 'string'
        || !ST_CONNECTION_STATES.includes(payload.st_connection.state)) {
        return { ok: false, reason: 'status_st_connection_invalid' };
    }

    const authAvailable = payload.authAvailable === undefined ? false : payload.authAvailable;
    const connected = payload.connected === undefined ? false : payload.connected;
    if (typeof authAvailable !== 'boolean') return { ok: false, reason: 'status_auth_invalid' };
    if (typeof connected !== 'boolean') return { ok: false, reason: 'status_connected_invalid' };
    const connectPending = payload.connect_pending === undefined ? false : payload.connect_pending;
    if (typeof connectPending !== 'boolean') return { ok: false, reason: 'status_connect_pending_invalid' };
    const localCleared = payload.local_cleared === undefined ? false : payload.local_cleared;
    if (typeof localCleared !== 'boolean') return { ok: false, reason: 'status_local_cleared_invalid' };
    const customCleared = payload.custom_cleared === undefined ? false : payload.custom_cleared;
    if (typeof customCleared !== 'boolean') return { ok: false, reason: 'status_custom_cleared_invalid' };
    const code = payload.code === undefined ? '' : payload.code;
    const message = payload.message === undefined ? '' : payload.message;
    if (typeof code !== 'string') return { ok: false, reason: 'status_code_invalid' };
    if (typeof message !== 'string') return { ok: false, reason: 'status_message_invalid' };

    const protocols = {};
    if (payload.protocols !== undefined) {
        if (!isPlainObject(payload.protocols)) return { ok: false, reason: 'status_protocols_invalid' };
        for (const face of STATUS_PROTOCOLS) {
            if (typeof payload.protocols[face] !== 'boolean') {
                return { ok: false, reason: 'status_protocols_invalid' };
            }
            protocols[face] = payload.protocols[face];
        }
    } else {
        for (const face of STATUS_PROTOCOLS) protocols[face] = false;
    }

    return {
        ok: true,
        value: Object.freeze({
            state: payload.state,
            reason: payload.reason === undefined ? null : payload.reason,
            username: payload.username === undefined ? null : payload.username,
            st_connection: Object.freeze({ state: payload.st_connection.state }),
            authAvailable,
            connected,
            connect_pending: connectPending,
            local_cleared: localCleared,
            custom_cleared: customCleared,
            code,
            message,
            protocols: Object.freeze(protocols),
        }),
    };
}

/**
 * 已授权判据（B1）：仅 state === 'authorized'。不代表酒馆已连接。
 * @param {ReturnType<typeof parseStatus>} status
 */
export function isAuthorized(status) {
    return !!(status && status.ok === true && status.value.state === 'authorized');
}

/**
 * Validate GET /connect/status payload（四态 + 可选 username，fail-closed）。
 * @param {unknown} payload
 */
export function parseConnectStatus(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: 'connect_status_envelope_invalid' };
    if (typeof payload.status !== 'string' || !CONNECT_STATUS_STATES.includes(payload.status)) {
        return { ok: false, reason: 'connect_status_value_invalid' };
    }
    if (payload.username !== undefined && !isNonEmptyBoundedString(payload.username, 512)) {
        return { ok: false, reason: 'connect_status_username_invalid' };
    }
    return {
        ok: true,
        value: Object.freeze({
            status: payload.status,
            username: payload.username === undefined ? null : payload.username,
        }),
    };
}

/**
 * 授权页地址白名单：https + host ∈ 固定网关域 + 无内嵌凭据 + 默认端口。
 * 浏览器打开 authorize_url 前必须过此闸（TLS 校验只覆盖服务端调用）。
 * @param {unknown} value
 */
export function isGatewayAuthorizeUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== GATEWAY_HOST) return false;
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    if (parsed.port !== '' && parsed.port !== '443') return false;
    return true;
}

/**
 * A face is usable only when the plugin says the gateway is connected and that
 * exact face is true.
 * @param {ReturnType<typeof parseStatus>} status
 * @param {string | null} face
 */
export function canUseProtocol(status, face) {
    if (!status || !status.ok || !face || !STATUS_PROTOCOLS.includes(face)) return false;
    return status.value.connected === true && status.value.protocols[face] === true;
}

/**
 * Validate one gateway balance number. Contract values are fixed six-decimal
 * non-negative strings; no numeric conversion is performed.
 * @param {unknown} value
 */
export function isBalanceDecimal(value) {
    return typeof value === 'string' && DECIMAL_6.test(value);
}

/**
 * BILL-08 整数字符串校验（H/K）：非负十进制整数字符串、不经浮点、≤ MaxInt64
 * （9223372036854775807）。非字符串/空串/小数/符号/指数/超限一律 null
 * （fail-closed → UI 显"未知"）；BigInt 包 try/catch，极端长输入抛错也按 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function parsePenaltyIntegerString(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    try {
        if (BigInt(value) > 9223372036854775807n) return null;
    } catch {
        return null;
    }
    return value;
}

/**
 * Validate the gateway balance payload without deriving, merging, or rounding
 * any value. The two BILL-08 columns (`penalty_input_threshold` /
 * `penalty_multiplier`) are required by the v1.35 query surface; the UI still
 * degrades malformed/missing values to null ("未知") instead of rejecting the
 * whole snapshot, so a display bug never hides the separately-validated
 * balance rows.
 * @param {unknown} payload
 */
export function parseBalance(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: 'balance_envelope_invalid' };
    const decimalFields = [
        'permanent_balance',
        'debt',
        'daily_quota',
        'daily_quota_used',
        'daily_quota_remaining',
    ];
    for (const field of decimalFields) {
        if (!isBalanceDecimal(payload[field])) {
            return { ok: false, reason: `balance_${field}_invalid` };
        }
    }
    if (payload.quota_date !== null && !(typeof payload.quota_date === 'string' && isValidQuotaDate(payload.quota_date))) {
        return { ok: false, reason: 'balance_quota_date_invalid' };
    }
    if (typeof payload.needs_refresh !== 'boolean') return { ok: false, reason: 'balance_needs_refresh_invalid' };
    if (typeof payload.observed_at !== 'string' || !UTC_DATE_TIME.test(payload.observed_at) || Number.isNaN(Date.parse(payload.observed_at))) {
        return { ok: false, reason: 'balance_observed_at_invalid' };
    }

    return {
        ok: true,
        value: Object.freeze({
            permanent_balance: payload.permanent_balance,
            debt: payload.debt,
            daily_quota: payload.daily_quota,
            daily_quota_used: payload.daily_quota_used,
            daily_quota_remaining: payload.daily_quota_remaining,
            quota_date: payload.quota_date,
            needs_refresh: payload.needs_refresh,
            observed_at: payload.observed_at,
            penalty_input_threshold: parsePenaltyIntegerString(payload.penalty_input_threshold),
            penalty_multiplier: parsePenaltyIntegerString(payload.penalty_multiplier),
        }),
    };
}

/**
 * Build the display rows for a parsed balance. Daily remaining, permanent
 * balance, and debt remain separate strings; a stale ledger is never presented
 * as today's usable quota. `penalty` carries parsed H/K (string|null): null
 * renders as "未知"; K is display-only (no client-side surcharge math).
 * @param {ReturnType<typeof parseBalance>['value']} balance
 */
export function balanceRows(balance) {
    return {
        rows: [
            { key: 'daily_quota_remaining', label: '每日剩余', value: balance.daily_quota_remaining },
            { key: 'permanent_balance', label: '长期余额', value: balance.permanent_balance },
            { key: 'debt', label: '欠额', value: balance.debt },
        ],
        penalty: {
            threshold: typeof balance.penalty_input_threshold === 'string' ? balance.penalty_input_threshold : null,
            multiplier: typeof balance.penalty_multiplier === 'string' ? balance.penalty_multiplier : null,
        },
        warning: balance.needs_refresh
            ? '账本待刷新：当前账日不是今日，以下数值不是今日可调用余额。'
            : null,
        quotaDate: balance.quota_date,
        observedAt: balance.observed_at,
    };
}

/**
 * View model for one catalog row. There is no active native adapter, so a row
 * is enabled only when protocol_faces and status agree and a verified adapter
 * exists; no such adapter exists in this delivery.
 * @param {unknown} rawItem
 * @param {ReturnType<typeof parseStatus>} status
 */
export function rowView(rawItem, status) {
    const item = normalizeModelItem(rawItem);
    if (item === null) {
        return { name: null, face: null, modality: null, classification: null, disabled: true, reason: 'invalid_entry' };
    }
    const face = faceForModel(item);
    const base = {
        name: item.name,
        face: face.face,
        modality: item.modality,
        classification: item.classification_name ?? null,
        disabled: true,
        reason: null,
    };
    if (!status || !status.ok) return { ...base, reason: 'status_unavailable' };
    if (face.disabled) return { ...base, reason: face.reason };
    if (!canUseProtocol(status, face.face)) return { ...base, reason: 'protocol_not_connected' };
    return { ...base, reason: 'adapter_unavailable' };
}

// ===== B3 key / 模型选择与计量（纯逻辑；DOM/事件/ST API 在 ui/index.js）=====

// ST 1.17.0 源码核实：Custom 源请求 URL = custom_url + '/chat/completions'
// （src/endpoints/backends/chat-completions.js: `endpointUrl = `${apiUrl}/chat/completions``）。
// 因此 custom_url 必须是数据面 base（含 /v1、不含 /chat/completions 后缀）。
export const GATEWAY_CUSTOM_BASE_URL = 'https://api.apercus.ai/v1';

/**
 * B3 目录行（查询面 /models 的线形状：{name, protocol_faces, 可选 modality/
 * capabilities/classification_name}）严格归一化。与旧目录 normalizeModelItem
 * 的差别：modality/capabilities 可选（/me/models 是 /v1/models 投影，不保证
 * 携带目录四要素），但 protocol_faces 必须存在且取值域合法。
 * @param {unknown} item
 */
export function normalizeModelChoice(item) {
    if (!isPlainObject(item)) return null;
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > MODEL_MAX_LENGTH) return null;
    if (!Array.isArray(item.protocol_faces)) return null;
    const faces = [];
    for (const face of item.protocol_faces) {
        if (typeof face !== 'string' || !PROTOCOLS.includes(face)) return null;
        if (!faces.includes(face)) faces.push(face);
    }
    let modality = null;
    if (item.modality !== undefined) {
        if (typeof item.modality !== 'string' || !MODALITIES.includes(item.modality)) return null;
        modality = item.modality;
    }
    let capabilities = null;
    if (item.capabilities !== undefined) {
        if (typeof item.capabilities !== 'string') return null;
        capabilities = item.capabilities;
    }
    let classificationName = null;
    if (Object.hasOwn(item, 'classification_name')) {
        if (!isNonEmptyString(item.classification_name)) return null;
        classificationName = item.classification_name.trim();
    }

    const normalized = {
        name: item.name,
        protocol_faces: Object.freeze(faces),
    };
    if (modality !== null) normalized.modality = modality;
    if (capabilities !== null) normalized.capabilities = capabilities;
    if (classificationName !== null) normalized.classification_name = classificationName;
    return Object.freeze(normalized);
}

/**
 * Validate the `{items:[...]}` model-selection envelope; invalid entries are
 * dropped (same tolerance as the legacy catalog view). No defaults invented.
 * @param {unknown} payload
 */
export function classifyModelChoices(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
        return { ok: false, reason: 'models_envelope_invalid', items: [], invalidCount: 0, truncated: false };
    }
    const items = [];
    let invalidCount = 0;
    let truncated = false;
    for (let index = 0; index < payload.items.length; index += 1) {
        if (items.length >= MAX_CATALOG_ITEMS) {
            truncated = true;
            break;
        }
        const normalized = normalizeModelChoice(payload.items[index]);
        if (normalized === null) {
            invalidCount += 1;
            continue;
        }
        items.push(normalized);
    }
    return { ok: true, reason: null, items: Object.freeze(items), invalidCount, truncated };
}

/**
 * A model is selectable only when the account is authorized and the model
 * advertises the chat protocol face. "Selectable" never means "connectable":
 * the tavern still owns the connection result.
 * @param {unknown} rawItem
 * @param {unknown} bound
 */
export function isModelSelectable(rawItem, bound) {
    if (bound !== true) return false;
    const item = normalizeModelChoice(rawItem);
    if (item === null) return false;
    return item.protocol_faces.includes('chat');
}

/**
 * B3 key 列表视图（脱敏）：只认 {keys:[{id,name,masked,status}]}。任何明文
 * key 形态字段（key/secret/plaintext）出现即整包拒绝；输出只含四个展示字段。
 * v1 恒一把：第一把标记 current（网关契约 v1 的 id 固定 default）。
 * @param {unknown} payload
 */
export function keyListView(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.keys)) {
        return { ok: false, reason: 'keys_envelope_invalid', keys: [], currentId: null };
    }
    const keys = [];
    for (const item of payload.keys) {
        if (!isPlainObject(item)) return { ok: false, reason: 'keys_item_invalid', keys: [], currentId: null };
        if (Object.hasOwn(item, 'key') || Object.hasOwn(item, 'secret')
            || Object.hasOwn(item, 'plaintext')) {
            return { ok: false, reason: 'keys_plaintext_rejected', keys: [], currentId: null };
        }
        const fields = {};
        for (const field of ['id', 'name', 'masked', 'status']) {
            if (!isNonEmptyBoundedString(item[field], 512)) {
                return { ok: false, reason: `keys_${field}_invalid`, keys: [], currentId: null };
            }
            fields[field] = item[field];
        }
        keys.push(Object.freeze({ ...fields, current: keys.length === 0 }));
    }
    return {
        ok: true,
        reason: null,
        keys: Object.freeze(keys),
        currentId: keys.length > 0 ? keys[0].id : null,
    };
}

/**
 * 阈值色带：used/threshold 任一非正整数 → null（不着色）。ratio = used/threshold：
 * >=1 → danger、>=0.9 → warn、否则 ok。threshold 也接受十进制整数字符串（H
 * 的原字符串）：经 BigInt 精确比较，绝不经 Number() 浮点；0.9 带等价于
 * 10×used >= 9×threshold。阈值 0 不比色。
 * @param {unknown} usedTokens
 * @param {unknown} threshold
 * @returns {'ok' | 'warn' | 'danger' | null}
 */
export function penaltyBand(usedTokens, threshold) {
    if (!Number.isInteger(usedTokens) || usedTokens <= 0) return null;
    if (typeof threshold === 'string') {
        const parsed = parsePenaltyIntegerString(threshold);
        if (parsed === null) return null;
        const thresholdBig = BigInt(parsed);
        if (thresholdBig <= 0n) return null;
        const usedBig = BigInt(usedTokens);
        if (usedBig >= thresholdBig) return 'danger';
        if (usedBig * 10n >= thresholdBig * 9n) return 'warn';
        return 'ok';
    }
    if (!Number.isInteger(threshold) || threshold <= 0) return null;
    const ratio = usedTokens / threshold;
    if (ratio >= 1) return 'danger';
    if (ratio >= 0.9) return 'warn';
    return 'ok';
}

/**
 * Chat 补全的提示预算 = openai_max_context - openai_max_tokens（ST 1.17.0
 * script.js:5867/5892 口径）。两值必须是非负整数；上下文缺失/非法/结果
 * ≤0 → null（预算未知，UI 显“未知”并回退 maxContext）。若运行时暴露
 * getMaxPromptTokens，UI 侧优先使用它（未核对具体 ST 版本）。
 * @param {unknown} settings
 * @returns {number | null}
 */
export function promptBudgetFromSettings(settings) {
    if (!isPlainObject(settings)) return null;
    const context = settings.openai_max_context;
    const maxTokens = settings.openai_max_tokens;
    if (!Number.isInteger(context) || context <= 0) return null;
    if (!Number.isInteger(maxTokens) || maxTokens < 0) return null;
    const budget = context - maxTokens;
    return budget > 0 ? budget : null;
}

/**
 * max_tokens 建议值能否应用：只有已知预算且 floor < 预算才允许写入。
 * 预算未知（null）时 fail-closed 不写——否则无法证明不会产生负的提示预算。
 * @param {unknown} floor
 * @param {unknown} budget
 */
export function maxTokensFitsBudget(floor, budget) {
    if (!Number.isInteger(floor) || floor <= 0) return false;
    if (!Number.isInteger(budget) || budget <= 0) return false;
    return floor < budget;
}

/**
 * ST 在线状态（ctx.onlineStatus）→ 三态。ST 1.17.0 口径（script.js:600/7053-7057、
 * 4304）：初值 'no_connection'；任何非空字符串（模型名、'Connected'、状态提示等）
 * 都表示已有后端连接。故只把 'no_connection' 视为未连接，非空字符串视为已连接，
 * 其余/缺失 → unknown。插件绝不自行宣称“已连接”。
 * @param {unknown} onlineStatus
 * @returns {'connected' | 'disconnected' | 'unknown'}
 */
export function stConnectionState(onlineStatus) {
    if (typeof onlineStatus !== 'string' || onlineStatus.length === 0) return 'unknown';
    if (onlineStatus === 'no_connection') return 'disconnected';
    return 'connected';
}

/**
 * 活动 custom_url 是否指向非网关域（F11 运行时清理触发条件）。G3：与
 * isGatewayCustomTarget 同口径的严格判定——只有“https + host 恰为固定数据面域
 * + 默认端口 + 无 userinfo”才算网关目标；其余可解析 URL（http、非默认端口、
 * 带 userinfo、其他 host）一律视为非网关并触发清理。空值（undefined/null/'')
 * 不触发。
 *
 * I1：恶意预设可把 custom_url 写成数组/对象/数字（ST 原样赋给 oai_settings，
 * 模板字符串后变成第三方 URL），而 string-only 判定会把这类值当成“不是非网关”
 * 从而绕过清理钩子。无法证明是网关即按非网关处理：已定义且非字符串的值一律
 * 返回 true（清理幂等、只删插件归属 key）；字符串仍走严格 URL 判定。
 *
 * J3：已定义非空的字符串若无法被 URL 解析（相对/畸形形态，如
 * '//attacker.example/v1'、'\\host'、'///host'），同样无法证明是网关，按
 * 非网关返回 true（fail-safe 清理），而不是静默跳过。
 * @param {unknown} value
 */
export function isNonGatewayCustomUrl(value) {
    if (value === undefined || value === null || value === '') return false;
    if (typeof value !== 'string') return true;
    let url;
    try {
        url = new URL(value);
    } catch {
        return true;
    }
    if (url.protocol !== 'https:') return true;
    if (url.hostname !== GATEWAY_DATA_HOST) return true;
    if (url.port !== '' && url.port !== '443') return true;
    if (url.username.length > 0 || url.password.length > 0) return true;
    return false;
}

/**
 * H1：ST 1.17.0 `OAI_PRESET_CHANGED_BEFORE` payload（{preset, settings,
 * settingsToUpdate}）→ 即将应用的 custom_url。ST 只在
 * bind_preset_to_connection 为真时应用连接类字段；settingsToUpdate 是
 * key → [selector, setting, isCheckbox, isConnection] 映射，不含 custom_url
 * 时该字段不会被应用。无法确认将应用时返回 currentUrl（不触发清理）。
 *
 * I1：预设里的 custom_url 已定义且非空（含数组/对象/数字）时返回原始值，
 * 不再回退 currentUrl——否则非字符串值会被 string-only 判定当成“未变更”，
 * 三条清理钩子全部绕过。是否触发清理由 isNonGatewayCustomUrl 判定（无法
 * 证明是网关即按非网关处理）。
 * @param {unknown} payload
 * @param {unknown} currentUrl
 */
export function pendingPresetCustomUrl(payload, currentUrl) {
    if (!isPlainObject(payload)) return currentUrl;
    const preset = payload.preset;
    if (!isPlainObject(preset)) return currentUrl;
    if (preset.custom_url === undefined || preset.custom_url === null || preset.custom_url === '') {
        return currentUrl;
    }
    const settings = isPlainObject(payload.settings) ? payload.settings : null;
    // ST 口径：连接类预设字段仅在 bind_preset_to_connection 时应用。
    if (settings && settings.bind_preset_to_connection === false) return currentUrl;
    const settingsToUpdate = payload.settingsToUpdate;
    if (isPlainObject(settingsToUpdate) && !Object.hasOwn(settingsToUpdate, 'custom_url')) {
        return currentUrl;
    }
    return preset.custom_url;
}

/**
 * /apply-model 失败后的回滚判定（F10）：只有“服务端明确拒绝”才回滚
 * custom_url/custom_model——4xx（含 409 not_connected、429、422）或已知的预写
 * 失败 custom_source_write_failed（502）。status 0/超时/其他 5xx 属结果不确定，
 * 保留网关 URL（宁可让用户重试或退出登录清理，也不回滚到可能已泄漏 key 的
 * 第三方 URL）。
 * @param {unknown} status
 * @param {unknown} code
 */
export function shouldRollbackApplyModel(status, code) {
    if (!Number.isInteger(status) || status === 0) return false;
    if (status >= 400 && status < 500) return true;
    return code === 'custom_source_write_failed';
}

/**
 * 上下文计量视图：两者都是非负整数 → {used,max,ratio}；任一缺失 →
 * {used,max,ratio:null}（缺失侧为 null → UI 显"未知"）。max=0 时比率不可算，
 * ratio 恒 null（fail-closed）。
 * @param {unknown} usedTokens
 * @param {unknown} maxTokens
 */
export function contextMeterView(usedTokens, maxTokens) {
    const used = Number.isInteger(usedTokens) && usedTokens >= 0 ? usedTokens : null;
    const max = Number.isInteger(maxTokens) && maxTokens >= 0 ? maxTokens : null;
    if (used === null || max === null || max === 0) {
        return { used, max, ratio: null };
    }
    return { used, max, ratio: used / max };
}

/**
 * 计数聚合：把消息数组的文本字段拼接成单个字符串供 getTokenCountAsync 计数
 * （ST 1.17.0 的 getTokenCountAsync 只接受字符串，喂对象数组会静默返回 0）。
 * 逐条取指定文本字段（非字符串条目跳过），按换行拼接；没有任何文本 → null。
 * @param {unknown} messages
 * @param {string} textField
 * @returns {string | null}
 */
export function joinMessageText(messages, textField) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    if (typeof textField !== 'string' || textField.length === 0) return null;
    const parts = [];
    for (const message of messages) {
        if (message !== null && typeof message === 'object'
            && typeof message[textField] === 'string' && message[textField].length > 0) {
            parts.push(message[textField]);
        }
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
}

// ===== B2 防截断分节（纯逻辑；DOM/事件/存储都在 ui/index.js）=====
//
// 2026-11-19 规格：插件只负责“喂单”——两次出题、结构层指纹、三道闸注入、
// 守卫与面板状态。硬防截断在网关；本模块不提供任何回退/默认名单。
//
// 缓存形如 extensionSettings.apercusGateway.sectionsCache[结构层指纹] =
// { sections, layers, layeredFingerprint }。只存节名单与分层（明文、非敏感），
// 登录凭据与 key 绝不进 extensionSettings。

export const ANTITRUNC_SUMMARY_MAX_CHARS = 16000;
export const ANTITRUNC_LAYERS_INPUT_MAX_CHARS = 16000;
export const ANTITRUNC_CACHE_NAMESPACE = 'apercusGateway';
export const ANTITRUNC_BODY_FLAG = 'apercus_antitrunc';
export const ANTITRUNC_BODY_SECTIONS = 'apercus_antitrunc_sections';
export const ANTITRUNC_COST_HINT = '生成节名单需要两次模型调用（先出清单，再做结构分层），将消耗少量额度。';
export const GATEWAY_DATA_HOST = 'api.apercus.ai';

export const ANTITRUNC_STATE = Object.freeze({
    NOT_GENERATED: '未生成',
    VALID: '有效',
    STALE: '过期',
    FAILED: '生成失败',
    GUARDED: '守卫警告',
});

const ANTITRUNC_STATE_MESSAGES = Object.freeze({
    [ANTITRUNC_STATE.NOT_GENERATED]: '尚未生成节名单。',
    [ANTITRUNC_STATE.VALID]: '节名单有效，注入就绪。',
    [ANTITRUNC_STATE.STALE]: '预设结构已变动，点击重新生成；生成前防截断暂停。',
    [ANTITRUNC_STATE.FAILED]: '生成失败，点击重试。',
    [ANTITRUNC_STATE.GUARDED]: '防截断不生效：检测到网关放弃集字段。',
});

// 守卫文案按 reason 显示具体字段（评审 I）：状态条与首次 toast 共用同一份
// 映射，不再一律说“函数调用开启”。
const ANTITRUNC_GUARD_FIELD_LABELS = Object.freeze({
    tools: 'tools（工具）',
    functions: 'functions（函数）',
    function_call: 'function_call（函数调用）',
    response_format: 'response_format（输出格式）',
    // 插件自加（ST 侧映射），非 api.md 原文：ST 1.17.0 chat-completions.js:
    // 2362-2370 把 json_schema 转成上游 response_format；最终请求因此命中
    // 放弃集，守卫必须在插件侧提前拦截。
    json_schema: 'json_schema（结构化输出映射到 response_format）',
    n: 'n（候选数）不为 1',
    messages: 'messages（消息）缺失或为空',
});

/**
 * 从守卫 reason 里取出字段名（antitrunc_guard_<field>）；不匹配返回 null。
 * @param {unknown} reason
 */
export function antitruncGuardField(reason) {
    const prefix = 'antitrunc_guard_';
    if (typeof reason !== 'string' || !reason.startsWith(prefix)) return null;
    const field = reason.slice(prefix.length);
    return field.length > 0 ? field : null;
}

/**
 * 守卫文案：按具体字段说明哪一项触发网关放弃集。未知 reason 使用通用文案。
 * @param {unknown} reason
 */
export function antitruncGuardMessage(reason) {
    if (reason === 'antitrunc_settings_invalid') {
        return '防截断不生效：请求设置无法识别。';
    }
    const field = antitruncGuardField(reason);
    const label = field !== null && Object.hasOwn(ANTITRUNC_GUARD_FIELD_LABELS, field)
        ? ANTITRUNC_GUARD_FIELD_LABELS[field]
        : '网关放弃集字段';
    return `防截断不生效：检测到 ${label}。`;
}

const SECTION_MIN_COUNT = 2;
const SECTION_MAX_COUNT = 16;
const SECTION_MAX_BYTES = 64;
const SECTION_ENCODER = new TextEncoder();
const PRESET_GLOBAL_ORDER_ID = 100001;

// 调用一（主，出清单）提示词：plugin-batch.md B2 节 2026-11-19 版逐字。
const ANTITRUNC_SECTIONS_PROMPT = '你是分节配置器。你的输出会作为节名单交给网关：网关把单次回复\n'
    + '按清单拆成多节，逐节生成、逐节交付给用户（每节约 800–1000 字），\n'
    + '使长回复不被截断、用户也无需等整篇写完。\n'
    + '\n'
    + '依据该预设规划节名单：\n'
    + '- 节数：按预设对单次回复体量的要求估算——总字数除以每节约 900 字、\n'
    + '  向上取整；预设要求的固定部件（总结、选项等）计入总长。\n'
    + '- 节名：描述该节承担的写作任务（铺垫、推进、收束一类），不写具体\n'
    + '  剧情与专名——保持通用，预设内容小幅调整时名单依然适用。\n'
    + '- 按叙事顺序排列，覆盖从开场到收束。\n'
    + '\n'
    + '只输出 JSON：\n'
    + '{"sections":["节名1","节名2"]}';

// F3：调用一末尾的固定输入段（预设摘要 ≤16000 字符）。
const ANTITRUNC_SECTIONS_INPUT_HEAD = '预设内容（可能被截断，≤16000 字符）：\n"""\n';
const ANTITRUNC_SECTIONS_INPUT_TAIL = '\n"""';

// 调用二（次，结构分层）提示词：plugin-batch.md B2 节（ac646e5）逐字。
// 输入为全部条目（含已关闭）的编号清单；layers 的键＝清单里的条目编号。
export const ANTITRUNC_LAYERS_TRUNCATED_MARK = '〔已截断〕';

const ANTITRUNC_LAYERS_PROMPT_HEAD = '你是分类器。以下是角色扮演预设的编号条目清单（含已关闭的）。逐条\n'
    + '判断：修改或开关该条目之后，现有的节名单是否需要重新规划？需要 →\n'
    + 'structural；不需要 → content。值只能是 structural 或 content。\n'
    + '（典型 structural：约定回复组成/固定部件、长度、思考步骤、输出格式\n'
    + '的条目。）\n'
    + '\n'
    + '只输出 JSON，layers 的键＝条目编号：\n'
    + '{"layers":{"0":"structural","1":"content"}}\n'
    + '\n'
    + '条目清单（含已关闭，启用条目优先保留；≤16000 字符，截断处以\n'
    + '〔已截断〕标记）：\n'
    + '"""\n';

const ANTITRUNC_LAYERS_PROMPT_TAIL = '\n"""';

/** @param {unknown} value */
function setOwn(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

/** @param {unknown} value */
function isString(value) {
    return typeof value === 'string';
}

// ---- 摘要脱敏：key 名过滤 + 值模式替换（非穷尽，残余接受）----

const PRESET_SUMMARY_DROP_KEYS = new Set([
    'custom_url',
    'custom_include_body',
    'custom_include_headers',
    'custom_exclude_body',
    'proxy_password',
    'reverse_proxy',
]);
const PRESET_SUMMARY_CREDENTIAL_RE = /key|token|secret|password|auth/i;

const SECRET_VALUE_PATTERNS = Object.freeze([
    [/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]'],
    [/\b(?:api[_-]?key|key)\s*=\s*[^\s&"',;<>]+/gi, '[REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]'],
]);

/**
 * 把字符串里的常见密钥形态替换为占位符。非穷尽；调用方不得据此认为摘要
 * 一定不含凭据（README 已登记预设内容出本机的残余接受）。
 * @param {unknown} text
 */
export function redactSecretPatterns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let value = text;
    for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
        value = value.replace(pattern, replacement);
    }
    return value;
}

function redactPresetValue(value, depth) {
    if (depth > 6) return null;
    if (Array.isArray(value)) {
        return value.map((item) => redactPresetValue(item, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [fieldName, fieldValue] of Object.entries(value)) {
            if (PRESET_SUMMARY_DROP_KEYS.has(fieldName)
                || PRESET_SUMMARY_CREDENTIAL_RE.test(fieldName)) {
                continue;
            }
            setOwn(out, fieldName, redactPresetValue(fieldValue, depth + 1));
        }
        return out;
    }
    if (typeof value === 'string') {
        return redactSecretPatterns(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return value;
    }
    return null;
}

/**
 * 摘要投影：先剔除凭据类字段名，再对字符串值做密钥形态替换。返回新对象，
 * 不改写入参。
 * @param {unknown} value
 */
export function redactPresetForSummary(value) {
    return redactPresetValue(value, 0);
}

// ---- 预设条目模型（依据 SillyTavern 1.17.0 预设结构）----
//
// ST chat-completion 预设（preset-manager.js:getCompletionPresetByName 返回的
// 预设文件对象）：
//   prompts: [{ identifier, name, content?, marker?, system_prompt?, role }]
//   prompt_order: [{ character_id, order: [{ identifier, enabled }] }]
// 全局顺序槽的 character_id 是 100001（openai.js setupChatCompletionPromptManager
// 的 promptOrder.dummyId）。执行顺序由 prompt_order 决定，不是 prompts 数组
// 顺序：条目按全局槽 order 的实际顺序构建（identifier 为稳定键），只保留
// order 里出现的条目。形态不符/缺字段/悬空 identifier/重复一律返回空数组
// （fail-closed）。

/**
 * 按 ST 全局 prompt_order 的执行顺序返回条目；identifier 一并保留用于指纹。
 * @param {unknown} presetJson
 * @returns {Array<{identifier: string, name: string, content: string, enabled: boolean}>}
 */
export function presetEntries(presetJson) {
    if (!isPlainObject(presetJson)) return [];
    const prompts = presetJson.prompts;
    const orderList = presetJson.prompt_order;
    if (!Array.isArray(prompts) || prompts.length === 0) return [];
    if (!Array.isArray(orderList)) return [];

    const promptById = new Map();
    for (const prompt of prompts) {
        if (!isPlainObject(prompt)) return [];
        if (typeof prompt.identifier !== 'string' || prompt.identifier.length === 0) return [];
        if (promptById.has(prompt.identifier)) return [];
        if (typeof prompt.name !== 'string' || prompt.name.length === 0) return [];
        if (prompt.content !== undefined && typeof prompt.content !== 'string') return [];
        promptById.set(prompt.identifier, {
            name: prompt.name,
            content: typeof prompt.content === 'string' ? prompt.content : '',
        });
    }

    let globalOrder = null;
    for (const item of orderList) {
        if (!isPlainObject(item)) continue;
        if (String(item.character_id) === String(PRESET_GLOBAL_ORDER_ID)) {
            globalOrder = item;
            break;
        }
    }
    if (globalOrder === null || !Array.isArray(globalOrder.order)) return [];

    const entries = [];
    const seenIds = new Set();
    for (const ref of globalOrder.order) {
        if (!isPlainObject(ref)) return [];
        if (typeof ref.identifier !== 'string' || ref.identifier.length === 0) return [];
        if (typeof ref.enabled !== 'boolean') return [];
        if (seenIds.has(ref.identifier)) return [];
        const prompt = promptById.get(ref.identifier);
        // 悬空 identifier（order 指向不存在的 prompt）属形态漂移：fail-closed。
        if (!prompt) return [];
        seenIds.add(ref.identifier);
        entries.push({
            identifier: ref.identifier,
            name: prompt.name,
            content: prompt.content,
            enabled: ref.enabled,
        });
    }
    return entries;
}

// ---- 两段提示词构建器 ----

/**
 * 调用一：规格原文 + F3 输入段。摘要超过 16000 字符截断，并在输入块末尾
 * （关闭三引号之前）追加〔已截断〕；规格提示词其余部分保持全文。
 * @param {unknown} presetSummary
 */
export function buildSectionsPrompt(presetSummary) {
    const raw = typeof presetSummary === 'string' ? presetSummary : '';
    const truncated = raw.length > ANTITRUNC_SUMMARY_MAX_CHARS;
    const summary = truncated ? raw.slice(0, ANTITRUNC_SUMMARY_MAX_CHARS) : raw;
    const marker = truncated ? ANTITRUNC_LAYERS_TRUNCATED_MARK : '';
    return `${ANTITRUNC_SECTIONS_PROMPT}\n\n${ANTITRUNC_SECTIONS_INPUT_HEAD}${summary}${marker}${ANTITRUNC_SECTIONS_INPUT_TAIL}`;
}

// 名称与内容共用同一脱敏入口：字符串没有字段名，key 名过滤不适用，
// 但 sk-/Bearer/key=/api_key= 等值模式必须同样替换后再发送。
function redactEntryText(value) {
    return redactSecretPatterns(typeof value === 'string' ? value : '');
}

// 稳定下标＝条目在 entries（过滤后的全部条目，含已关闭）里的位置，layers
// 持久化用它，开关条目之间不漂移。调用二清单的输出编号按输出顺序 0..n-1，
// 并把启用条目排在前（预算截断时优先保留启用条目，规格要求）。
function layersEntryList(entries) {
    const list = [];
    if (!Array.isArray(entries)) return list;
    for (const entry of entries) {
        if (isPlainObject(entry)) list.push(entry);
    }
    return list;
}

function layersPriorityOrder(list) {
    const enabled = [];
    const disabled = [];
    for (let index = 0; index < list.length; index += 1) {
        if (list[index].enabled === true) enabled.push(index);
        else disabled.push(index);
    }
    return enabled.concat(disabled);
}

/**
 * 调用二输入：规格提示词 + 全部条目（含已关闭）的编号清单。清单编号按输出
 * 顺序 0..n-1（启用条目排在前），但插件仍按条目稳定下标保存 layers。
 * 清单预算默认 ≤16000 字符；启用条目优先保留，超预算处标〔已截断〕，其后
 * 条目不出现在清单（解析时默认 structural）。名称与内容经值模式脱敏后再发送。
 * 返回 prompt 与 truncatedIndexes（条目稳定下标；调用方解析 layers 时透传，
 * 强制截断条目按 structural 处理）。
 * @param {unknown} entries
 * @param {number} [maxChars]
 */
export function buildLayersPromptWithMeta(entries, maxChars = ANTITRUNC_LAYERS_INPUT_MAX_CHARS) {
    const budget = Number.isInteger(maxChars) && maxChars > 0
        ? maxChars
        : ANTITRUNC_LAYERS_INPUT_MAX_CHARS;
    const list = layersEntryList(entries);
    const order = layersPriorityOrder(list);
    const lines = [];
    const truncatedIndexes = [];
    let used = 0;
    for (let position = 0; position < order.length; position += 1) {
        const stableIndex = order[position];
        const entry = list[stableIndex];
        const name = redactEntryText(typeof entry.name === 'string' ? entry.name : '');
        const content = redactSecretPatterns(typeof entry.content === 'string' ? entry.content : '');
        const prefix = `[${position}] ${name}：`;
        const full = `${prefix}${content}\n`;
        if (used + full.length <= budget) {
            lines.push(full);
            used += full.length;
            continue;
        }
        const marked = `${prefix}${ANTITRUNC_LAYERS_TRUNCATED_MARK}\n`;
        if (used + marked.length <= budget) {
            const available = budget - used - marked.length;
            lines.push(`${prefix}${content.slice(0, Math.max(0, available))}${ANTITRUNC_LAYERS_TRUNCATED_MARK}\n`);
        }
        // 当前条目无论“放得下标记行”还是“连标记行都放不下”，都已被截断：
        // stableIndex 必须进 truncatedIndexes（U8）。
        truncatedIndexes.push(stableIndex);
        // 截断点之后的条目都不进清单：全部按 structural 兜底，防止模型对
        // 未列出的编号给出 content。
        for (let rest = position + 1; rest < order.length; rest += 1) {
            truncatedIndexes.push(order[rest]);
        }
        break;
    }
    const body = lines.join('').replace(/\n$/, '');
    const prompt = ANTITRUNC_LAYERS_PROMPT_HEAD + body + ANTITRUNC_LAYERS_PROMPT_TAIL;
    return { prompt, truncatedIndexes };
}

/**
 * 兼容入口：只要调用二提示词字符串。
 * @param {unknown} entries
 * @param {number} [maxChars]
 */
export function buildLayersPrompt(entries, maxChars = ANTITRUNC_LAYERS_INPUT_MAX_CHARS) {
    return buildLayersPromptWithMeta(entries, maxChars).prompt;
}

// ---- 校验器 / layers 解析 ----

/** 剥掉 ``` 或 ~~~ 围栏（含语言标记行）；无围栏时原样返回（仅 trim）。 */
export function stripCodeFence(text) {
    if (typeof text !== 'string') return '';
    let value = text.trim();
    let fence = null;
    if (value.startsWith('```')) fence = '```';
    else if (value.startsWith('~~~')) fence = '~~~';
    if (fence === null) return value;
    value = value.slice(fence.length);
    const firstNewline = value.indexOf('\n');
    if (firstNewline !== -1) {
        value = value.slice(firstNewline + 1);
    }
    const closing = value.lastIndexOf(fence);
    if (closing !== -1) {
        value = value.slice(0, closing);
    }
    return value.trim();
}

/**
 * 缓存/注入用名单校验：2~16 项、无重名、逐项已 trim、非空、单项 ≤64 UTF-8 字节。
 * @param {unknown} value
 */
export function isValidSectionList(value) {
    if (!Array.isArray(value)) return false;
    if (value.length < SECTION_MIN_COUNT || value.length > SECTION_MAX_COUNT) return false;
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string') return false;
        const trimmed = item.trim();
        if (trimmed.length === 0 || trimmed !== item) return false;
        if (SECTION_ENCODER.encode(trimmed).length > SECTION_MAX_BYTES) return false;
        if (seen.has(trimmed)) return false;
        seen.add(trimmed);
    }
    return true;
}

/**
 * 校验模型输出的节名单：剥围栏 → JSON.parse → sections 数组 → 逐项 string、
 * trim、去空 → 契约校验（有效项 ≥2、≤16、无重名、单项 ≤64 字节）。任何失败
 * 都返回 ok:false；无回退名单、无默认名单。
 * @param {unknown} text
 */
export function parseSections(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'sections_not_text', sections: [] };
    const stripped = stripCodeFence(text);
    if (stripped.length === 0) return { ok: false, reason: 'sections_empty', sections: [] };
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        return { ok: false, reason: 'sections_json_invalid', sections: [] };
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.sections)) {
        return { ok: false, reason: 'sections_shape_invalid', sections: [] };
    }
    const sections = [];
    const seen = new Set();
    for (const item of parsed.sections) {
        if (typeof item !== 'string') {
            return { ok: false, reason: 'sections_item_invalid', sections: [] };
        }
        const trimmed = item.trim();
        if (trimmed.length === 0) continue;
        if (SECTION_ENCODER.encode(trimmed).length > SECTION_MAX_BYTES) {
            return { ok: false, reason: 'sections_item_too_long', sections: [] };
        }
        if (seen.has(trimmed)) {
            return { ok: false, reason: 'sections_duplicate', sections: [] };
        }
        seen.add(trimmed);
        sections.push(trimmed);
    }
    if (sections.length < SECTION_MIN_COUNT) {
        return { ok: false, reason: 'sections_too_few', sections: [] };
    }
    if (sections.length > SECTION_MAX_COUNT) {
        return { ok: false, reason: 'sections_too_many', sections: [] };
    }
    return { ok: true, reason: null, sections };
}

/** 全部条目按 structural 处理的 layers（保守兜底；键＝条目编号）。 */
export function allStructuralLayers(entries) {
    const layers = {};
    const list = layersEntryList(entries);
    for (let index = 0; index < list.length; index += 1) {
        setOwn(layers, String(index), 'structural');
    }
    return layers;
}

/**
 * layers 解析（编号制）：剥围栏 → JSON.parse → layers 普通对象；键＝调用二
 * 清单里的输出编号（0..n-1，启用条目在前），按编号映射回条目稳定下标保存。
 * 值只能是 structural / content（其他值按 structural）。非法/越界编号
 * （对不上条目）、缺失键、被输入截断的条目（options.truncatedIndexes 为
 * 稳定下标）一律 structural——conservative 取向一致。
 * 解析失败 → ok:false 且全 structural（由上层重试一次后按此结果使用）。
 * @param {unknown} text
 * @param {unknown} entries
 * @param {{truncatedIndexes?: number[]}} [options]
 */
export function parseLayers(text, entries, options) {
    const list = layersEntryList(entries);
    const order = layersPriorityOrder(list);
    const truncated = new Set();
    if (isPlainObject(options) && Array.isArray(options.truncatedIndexes)) {
        for (const index of options.truncatedIndexes) {
            if (Number.isInteger(index) && index >= 0) truncated.add(index);
        }
    }
    const fallback = () => allStructuralLayers(entries);
    if (typeof text !== 'string') return { ok: false, reason: 'layers_not_text', layers: fallback() };
    const stripped = stripCodeFence(text);
    if (stripped.length === 0) return { ok: false, reason: 'layers_empty', layers: fallback() };
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        return { ok: false, reason: 'layers_json_invalid', layers: fallback() };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.layers)) {
        return { ok: false, reason: 'layers_shape_invalid', layers: fallback() };
    }
    const raw = parsed.layers;
    const layers = {};
    for (let position = 0; position < order.length; position += 1) {
        const stableIndex = order[position];
        const key = String(stableIndex);
        if (truncated.has(stableIndex)) {
            setOwn(layers, key, 'structural');
            continue;
        }
        const value = Object.hasOwn(raw, String(position)) ? raw[String(position)] : undefined;
        setOwn(layers, key, value === 'content' ? 'content' : 'structural');
    }
    return { ok: true, reason: null, layers };
}

// ---- 指纹（F1 分层方案）----

function entryDigestPart(entry) {
    // identifier 是 ST prompt_order 的稳定键；数组顺序即执行顺序。两者一起入
    // 指纹：仅拖动 prompt_order 顺序（名称/内容不变）也必须使两类指纹变化。
    // 名称/长度前缀防止 (name='a', content='bc') 与 (name='ab', content='c') 撞哈希。
    const identifier = typeof entry.identifier === 'string' ? entry.identifier : '';
    return `${identifier.length}:${identifier}|${entry.name.length}:${entry.name}${entry.content.length}:${entry.content}`;
}

async function sha256Hex(text) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return null;
    try {
        const digest = await subtle.digest('SHA-256', SECTION_ENCODER.encode(text));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

/**
 * 分层指纹：哈希全部条目（含已关闭）的名称＋内容。只用于决定何时重跑调用二；
 * 任何名称/内容变动都会变（启用/关闭不变，故纯开关不重跑）。
 * @param {unknown} entries
 * @returns {Promise<string | null>}
 */
export async function layeredFingerprint(entries) {
    if (!Array.isArray(entries)) return null;
    const parts = [];
    for (const entry of entries) {
        if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.content !== 'string') {
            return null;
        }
        parts.push(entryDigestPart(entry));
    }
    return sha256Hex(parts.join('\n'));
}

/**
 * 结构层指纹：哈希（启用中 ∩ structural）条目的名称＋内容。用于决定是否提醒
 * 重新生成。层按条目编号查（编号＝entries 过滤后数组下标，开关条目不改变
 * 编号）；缺失/非法标注、重名条目未标注的项一律按 structural。
 * @param {unknown} entries
 * @param {unknown} layers
 * @returns {Promise<string | null>}
 */
export async function structuralFingerprint(entries, layers) {
    if (!Array.isArray(entries)) return null;
    const list = layersEntryList(entries);
    for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (typeof entry.name !== 'string' || typeof entry.content !== 'string'
            || typeof entry.enabled !== 'boolean') {
            return null;
        }
    }
    const parts = [];
    for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry.enabled !== true) continue;
        const key = String(index);
        const layer = isPlainObject(layers) && Object.hasOwn(layers, key)
            ? layers[key]
            : undefined;
        if (layer === 'content') continue;
        parts.push(entryDigestPart(entry));
    }
    return sha256Hex(parts.join('\n'));
}

// ---- 守卫矩阵 ----

// 口径：api.md v1.32 放弃集原文（plugin-batch B2 ④，ac646e5）——
// tools / functions / function_call / response_format 任一、n 存在且非字面 1、
// messages 缺失·非数组·空。tool_choice 不在放弃集：网关激活时强制改写成
// 自有工具、客户端值被覆盖，单独出现不触发。
// json_schema 为插件自加（非 api.md 原文）：ST 1.17.0 后端会把 json_schema
// 映射成上游 response_format（chat-completions.js:2362-2370），最终请求因此
// 命中放弃集，必须在打包阶段拦住。
const GUARD_BLOCKED_KEYS = Object.freeze([
    'tools',
    'functions',
    'function_call',
    'response_format',
    'json_schema',
]);

/**
 * 检查打包完的请求形态（不区分谁开的 tools）。命中 → ok:false + reason。
 * n 必须字面 1 或缺席。messages 默认必须存在且为非空数组（对齐 api.md 放弃集：
 * 缺失/非数组/空都触发）；合并体检查传 {requireMessages:false}，此时仅
 * “存在但非法”才触发。
 * @param {unknown} settings
 * @param {{requireMessages?: boolean}} [options]
 */
export function checkAntitruncGuards(settings, options) {
    if (!isPlainObject(settings)) {
        return { ok: false, reason: 'antitrunc_settings_invalid' };
    }
    for (const key of GUARD_BLOCKED_KEYS) {
        if (settings[key] !== undefined) {
            return { ok: false, reason: `antitrunc_guard_${key}` };
        }
    }
    if (settings.n !== undefined && settings.n !== 1) {
        return { ok: false, reason: 'antitrunc_guard_n' };
    }
    const requireMessages = !(isPlainObject(options) && options.requireMessages === false);
    if (requireMessages) {
        if (!Array.isArray(settings.messages) || settings.messages.length === 0) {
            return { ok: false, reason: 'antitrunc_guard_messages' };
        }
    } else if (Object.hasOwn(settings, 'messages')
        && (!Array.isArray(settings.messages) || settings.messages.length === 0)) {
        return { ok: false, reason: 'antitrunc_guard_messages' };
    }
    return { ok: true, reason: null };
}

// ---- custom_include_body 清理与合并（#452 二轮 H7 / v3 暖审 bug1）----
//
// 两键 apercus_antitrunc / apercus_antitrunc_sections 归插件所有：合并前先
// 清除旧键，再写入本次名单。插件在内存里记住最近一次成功写入的完整 body
// （antitrunc.lastInjectedBody），用于区分“插件旧键”与用户改过的 body。

/** 解析 body 字符串为普通 JSON 对象；空/非法/非对象 → null。 */
function parseBodyObject(bodyString) {
    if (typeof bodyString !== 'string' || bodyString.trim().length === 0) return null;
    let parsed;
    try {
        parsed = JSON.parse(bodyString);
    } catch {
        return null;
    }
    return isPlainObject(parsed) ? parsed : null;
}

/**
 * body 是否为合法 JSON 对象且含有本插件两键之一。
 * @param {unknown} bodyString
 */
export function hasAntitruncKeys(bodyString) {
    const parsed = parseBodyObject(bodyString);
    if (parsed === null) return false;
    return Object.hasOwn(parsed, ANTITRUNC_BODY_FLAG)
        || Object.hasOwn(parsed, ANTITRUNC_BODY_SECTIONS);
}

function stripKeysFromObject(parsed) {
    const out = {};
    let remaining = 0;
    for (const [key, value] of Object.entries(parsed)) {
        if (key === ANTITRUNC_BODY_FLAG || key === ANTITRUNC_BODY_SECTIONS) continue;
        setOwn(out, key, value);
        remaining += 1;
    }
    return { out, remaining };
}

/**
 * 从 body 字符串中删除本插件两键并返回字符串。
 * - 合法 JSON 对象且含插件键 → 删除后重新序列化；删空后返回 ''（空体）。
 * - 合法 JSON 对象但无插件键 / 空串 / 非法 JSON / 非对象 → 原样返回。
 * - __proto__ 用 defineProperty 复制，不触发原型 setter。
 * @param {unknown} bodyString
 */
export function stripAntitruncKeys(bodyString) {
    const parsed = parseBodyObject(bodyString);
    if (parsed === null) return bodyString;
    if (!Object.hasOwn(parsed, ANTITRUNC_BODY_FLAG) && !Object.hasOwn(parsed, ANTITRUNC_BODY_SECTIONS)) {
        return bodyString;
    }
    const { out, remaining } = stripKeysFromObject(parsed);
    return remaining === 0 ? '' : JSON.stringify(out);
}

function jsonValueEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let index = 0; index < a.length; index += 1) {
            if (!jsonValueEqual(a[index], b[index])) return false;
        }
        return true;
    }
    if (isPlainObject(a)) {
        if (!isPlainObject(b)) return false;
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!Object.hasOwn(b, key) || !jsonValueEqual(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

/**
 * 当前 body 是否恰为插件上次写入的完整字符串（U6 收紧为严格相等）。
 * 只有完全一致时才把两键视为插件自有并清理；用户改过（哪怕只是键序/其他
 * 字段）都按用户内容处理，绝不总 strip 用户同名键。
 * @param {unknown} currentBodyString
 * @param {unknown} lastInjectedBodyString
 */
export function isStaleAntitruncBody(currentBodyString, lastInjectedBodyString) {
    if (typeof currentBodyString !== 'string' || typeof lastInjectedBodyString !== 'string') return false;
    if (!hasAntitruncKeys(currentBodyString)) return false;
    return currentBodyString === lastInjectedBodyString;
}

function hasDesiredAntitruncValues(parsed, sections) {
    if (!isPlainObject(parsed)) return false;
    if (parsed[ANTITRUNC_BODY_FLAG] !== true) return false;
    if (!Array.isArray(parsed[ANTITRUNC_BODY_SECTIONS])) return false;
    return jsonValueEqual(parsed[ANTITRUNC_BODY_SECTIONS], sections);
}

/**
 * 把两键合并进 custom_include_body 的 JSON 字符串。
 * - 仅当 existingBodyString 与 options.lastInjectedBody 完全相等时，才把两键
 *   视为插件自有：先移除再写入本次名单。
 * - 否则若存在同名键且值不同 → 用户优先：不写入、返回
 *   reason='antitrunc_body_user_override'（调用方提示并跳过注入），不得
 *   strip 或改写用户键。同名键值恰好等于本次名单 → 幂等放行、原样返回。
 * - 非空但解析不出 JSON 对象 → 不写入（含 ST 惯用 YAML 写法的情形）。
 * - 空串视为“无用户字段”的默认态，按空对象合并（否则 B2 永远无法首次注入）；
 *   报告将此作为对规格字面“空串不写入”的必要偏离。
 * @param {unknown} existingBodyString
 * @param {unknown} sections
 * @param {{lastInjectedBody?: string | null}} [options]
 */
export function mergeAntitruncBody(existingBodyString, sections, options) {
    if (!isValidSectionList(sections)) {
        return { ok: false, skipped: false, reason: 'antitrunc_sections_invalid', body: existingBodyString };
    }
    const lastInjectedBody = isPlainObject(options) && typeof options.lastInjectedBody === 'string'
        ? options.lastInjectedBody
        : null;
    let existing = {};
    if (typeof existingBodyString === 'string' && existingBodyString.trim().length > 0) {
        const parsed = parseBodyObject(existingBodyString);
        if (parsed === null) {
            return { ok: false, skipped: true, reason: 'antitrunc_body_unparseable', body: existingBodyString };
        }
        const hasKeys = Object.hasOwn(parsed, ANTITRUNC_BODY_FLAG)
            || Object.hasOwn(parsed, ANTITRUNC_BODY_SECTIONS);
        if (hasKeys && existingBodyString !== lastInjectedBody) {
            if (!hasDesiredAntitruncValues(parsed, sections)) {
                return {
                    ok: false,
                    skipped: true,
                    reason: 'antitrunc_body_user_override',
                    body: existingBodyString,
                };
            }
            // 同名键值已经就是本次名单：幂等放行，保留用户格式，不重写。
            // F6：幂等分支同样要对“合并后对象”跑守卫（用户 body 里可能还有
            // tools/functions/n/messages 等放弃集字段），守卫失败 → 不注入。
            const guard = checkAntitruncGuards(parsed, { requireMessages: false });
            if (!guard.ok) {
                return { ok: false, skipped: true, reason: guard.reason, body: existingBodyString };
            }
            return { ok: true, skipped: false, reason: null, body: existingBodyString };
        }
        existing = parsed;
    }
    const { out: merged } = stripKeysFromObject(existing);
    setOwn(merged, ANTITRUNC_BODY_FLAG, true);
    setOwn(merged, ANTITRUNC_BODY_SECTIONS, sections.slice());
    // 合并体不是 generate_data：messages 可以有或没有，只有“存在但非法”才触发。
    const guard = checkAntitruncGuards(merged, { requireMessages: false });
    if (!guard.ok) {
        return { ok: false, skipped: true, reason: guard.reason, body: existingBodyString };
    }
    return { ok: true, skipped: false, reason: null, body: JSON.stringify(merged) };
}

// ---- 面板五态 / 成本提示 ----

/**
 * 面板五态：守卫警告 > 生成失败 > 过期 > 有效 > 未生成。
 * @param {{cacheHit?: boolean, fingerprintExpired?: boolean, generationFailed?: boolean, guardBlocked?: boolean, guardReason?: string | null}} input
 */
export function antitruncPanelState(input) {
    const value = isPlainObject(input) ? input : {};
    let state;
    if (value.guardBlocked === true) state = ANTITRUNC_STATE.GUARDED;
    else if (value.generationFailed === true) state = ANTITRUNC_STATE.FAILED;
    else if (value.fingerprintExpired === true) state = ANTITRUNC_STATE.STALE;
    else if (value.cacheHit === true) state = ANTITRUNC_STATE.VALID;
    else state = ANTITRUNC_STATE.NOT_GENERATED;
    const message = state === ANTITRUNC_STATE.GUARDED
        ? antitruncGuardMessage(value.guardReason)
        : ANTITRUNC_STATE_MESSAGES[state];
    return { state, message };
}

/** 每节 max_tokens 地板 = 节数×1200+2000；非法入参 → null。 */
export function antitruncFloorTokens(sectionCount) {
    if (!Number.isInteger(sectionCount) || sectionCount < 1) return null;
    return sectionCount * 1200 + 2000;
}

// ---- 缓存 helpers（纯对象操作）----

export const ANTITRUNC_CACHE_MAX_PER_PRESET = 3;
export const ANTITRUNC_CACHE_MAX_GLOBAL = 20;

/**
 * 按分层指纹查找缓存条目。缓存键是结构层指纹，命中后返回
 * { key, sections, layers, layeredFingerprint }；形态不符/名单非法 → null。
 * 调用方仍须复核当前预设的结构指纹与分层指纹（缓存命中竞态，评审 H）。
 * @param {unknown} cache
 * @param {unknown} layeredFingerprintValue
 */
export function findAntitruncCacheEntry(cache, layeredFingerprintValue) {
    if (!isPlainObject(cache)
        || typeof layeredFingerprintValue !== 'string'
        || layeredFingerprintValue.length === 0) {
        return null;
    }
    for (const key of Object.keys(cache)) {
        const entry = cache[key];
        if (!isPlainObject(entry)) continue;
        if (entry.layeredFingerprint !== layeredFingerprintValue) continue;
        if (!isValidSectionList(entry.sections)) continue;
        if (!isPlainObject(entry.layers)) continue;
        return {
            key,
            sections: entry.sections.slice(),
            layers: { ...entry.layers },
            layeredFingerprint: entry.layeredFingerprint,
        };
    }
    return null;
}

function cacheEntryGroup(entry) {
    return typeof entry.presetName === 'string' && entry.presetName.length > 0 ? entry.presetName : '';
}

function cacheEntryLastUsed(entry) {
    return typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt)
        ? entry.lastUsedAt
        : 0;
}

function removeOldest(keys, cache, count) {
    let removed = 0;
    for (const key of keys) {
        if (removed >= count) break;
        delete cache[key];
        removed += 1;
    }
    return removed;
}

/**
 * 缓存数量上限（评审 G）：每预设 ≤3 条、全局 ≤20 条，按 lastUsedAt LRU 淘汰最旧。
 * 无 presetName 的旧条目共用一个分组（保守处理）。
 * @param {unknown} cache
 * @param {{maxPerPreset?: number, maxGlobal?: number}} [limits]
 * @returns {number} 淘汰条数
 */
export function enforceAntitruncCacheLimits(cache, limits) {
    if (!isPlainObject(cache)) return 0;
    const options = isPlainObject(limits) ? limits : {};
    const maxPerPreset = Number.isInteger(options.maxPerPreset) && options.maxPerPreset > 0
        ? options.maxPerPreset
        : ANTITRUNC_CACHE_MAX_PER_PRESET;
    const maxGlobal = Number.isInteger(options.maxGlobal) && options.maxGlobal > 0
        ? options.maxGlobal
        : ANTITRUNC_CACHE_MAX_GLOBAL;

    let removed = 0;
    const groups = new Map();
    for (const key of Object.keys(cache)) {
        const entry = cache[key];
        if (!isPlainObject(entry)) continue;
        const group = cacheEntryGroup(entry);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(key);
    }
    for (const keys of groups.values()) {
        if (keys.length <= maxPerPreset) continue;
        const ordered = keys.slice().sort((a, b) => cacheEntryLastUsed(cache[a]) - cacheEntryLastUsed(cache[b]));
        removed += removeOldest(ordered, cache, keys.length - maxPerPreset);
    }

    const all = Object.keys(cache).filter((key) => isPlainObject(cache[key]));
    if (all.length > maxGlobal) {
        const ordered = all.sort((a, b) => cacheEntryLastUsed(cache[a]) - cacheEntryLastUsed(cache[b]));
        removed += removeOldest(ordered, cache, all.length - maxGlobal);
    }
    return removed;
}

/**
 * 写缓存条目：仅接受合法名单 + 对象 layers + 非空 layeredFingerprint。
 * 同时记录 presetName（每预设上限分组）与 lastUsedAt（LRU），写后执行数量上限。
 * @param {Record<string, unknown>} cache
 * @param {unknown} structuralKey
 * @param {{sections?: unknown, layers?: unknown, layeredFingerprint?: unknown, presetName?: unknown, lastUsedAt?: unknown}} entry
 * @param {{maxPerPreset?: number, maxGlobal?: number, now?: number}} [options]
 */
export function writeAntitruncCacheEntry(cache, structuralKey, entry, options) {
    if (!isPlainObject(cache) || typeof structuralKey !== 'string' || structuralKey.length === 0) {
        return false;
    }
    if (!isPlainObject(entry) || !isValidSectionList(entry.sections)) return false;
    if (!isPlainObject(entry.layers)) return false;
    if (typeof entry.layeredFingerprint !== 'string' || entry.layeredFingerprint.length === 0) return false;
    const written = {
        sections: entry.sections.slice(),
        layers: { ...entry.layers },
        layeredFingerprint: entry.layeredFingerprint,
        lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt)
            ? entry.lastUsedAt
            : (isPlainObject(options) && typeof options.now === 'number' && Number.isFinite(options.now)
                ? options.now
                : Date.now()),
    };
    if (typeof entry.presetName === 'string' && entry.presetName.length > 0) {
        written.presetName = entry.presetName;
    }
    setOwn(cache, structuralKey, written);
    enforceAntitruncCacheLimits(cache, options);
    return true;
}

/** 缓存命中时刷新最近使用时间（LRU）。返回是否命中并更新。 */
export function touchAntitruncCacheEntry(cache, structuralKey, now) {
    if (!isPlainObject(cache) || typeof structuralKey !== 'string' || structuralKey.length === 0) {
        return false;
    }
    const entry = cache[structuralKey];
    if (!isPlainObject(entry)) return false;
    entry.lastUsedAt = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    return true;
}

/** 删除同一分层指纹下的旧缓存条目（避免同一预设多份）。返回删除数量。 */
export function pruneAntitruncCache(cache, layeredFingerprintValue) {
    if (!isPlainObject(cache) || typeof layeredFingerprintValue !== 'string'
        || layeredFingerprintValue.length === 0) {
        return 0;
    }
    let removed = 0;
    for (const key of Object.keys(cache)) {
        const entry = cache[key];
        if (isPlainObject(entry) && entry.layeredFingerprint === layeredFingerprintValue) {
            delete cache[key];
            removed += 1;
        }
    }
    return removed;
}

// ---- 注入目标闸（custom 源且固定网关域）----

/**
 * 当前补全源是否指向固定网关数据面：source 必须是 custom，custom_url 必须是
 * https://api.apercus.ai[/...]，且 URL 不得携带用户名/口令。其他目标安静跳过。
 * @param {unknown} settings
 */
export function isGatewayCustomTarget(settings) {
    if (!isPlainObject(settings)) return false;
    if (settings.chat_completion_source !== 'custom') return false;
    if (typeof settings.custom_url !== 'string' || settings.custom_url.length === 0) return false;
    let url;
    try {
        url = new URL(settings.custom_url);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.hostname !== GATEWAY_DATA_HOST) return false;
    if (url.port !== '' && url.port !== '443') return false;
    if (url.username.length > 0 || url.password.length > 0) return false;
    return true;
}

