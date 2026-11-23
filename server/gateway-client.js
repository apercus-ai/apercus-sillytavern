'use strict';

// Apercus Gateway 连接域（B1，v1.35）与插件查询面的服务端客户端。
//
// 本文件是全仓唯一允许出现 v1.35 connect / plugin 端点路径与响应字段名的文件：
// 所有响应字段解析集中于此，未知形态 fail-closed；契约漂移只改这一个文件。
//
// PORTAL_ORIGIN 在此独立定义而不从 core.js 导入（连接/查询/余额同属 gw 域），
// 避免循环依赖（core.js 依赖本文件）。编译期常量，不接受请求方覆盖。
//
// 错误边界：错误对象只带固定 code + 固定中文文案；URL、上游响应正文、
// polling_secret / login_credential / key 一概不进错误消息。零日志。
// 零重试——轮询本身就是重试机制（契约固定 5 秒，UI 到点再问），失败保留现场
// 由下一次查询自然重试。

const {
    isValidBindingKey,
    isValidLoginCredential,
    isValidUsername,
} = require('./binding-store');

const PORTAL_ORIGIN = 'https://gw.apercus.ai';
const START_CONNECT_PATH = '/api/connect/requests';
const POLL_CONNECT_PATH = '/api/connect/requests/poll';
const LOGOUT_PATH = '/api/plugin/logout';
const ME_PATH = '/api/plugin/me';
const KEYS_PATH = '/api/plugin/me/keys';
const ME_KEY_PATH = '/api/plugin/me/key';
const MODELS_PATH = '/api/plugin/me/models';
const BALANCE_PATH = '/api/plugin/me/balance';

const GATEWAY_HOST = 'gw.apercus.ai';
const DEFAULT_TIMEOUT_MS = 8000;
// 门户响应体上限：与 core.js 的 readBoundedBody（512KB）同口径——异常门户不得
// 把超大响应灌进内存。
const MAX_RESPONSE_BYTES = 524288;

const START_CODE = 'connect_start_failed';
const POLL_CODE = 'connect_poll_failed';
const LOGOUT_CODE = 'plugin_logout_failed';
const ME_CODE = 'plugin_me_fetch_failed';
const KEYS_CODE = 'plugin_keys_fetch_failed';
const ME_KEY_CODE = 'plugin_key_fetch_failed';
const MODELS_CODE = 'plugin_models_fetch_failed';
const BALANCE_CODE = 'plugin_balance_fetch_failed';

const MESSAGE_START_FAILED = '连接发起失败：网关不可用或响应无效，请稍后重试。';
const MESSAGE_POLL_FAILED = '连接状态查询失败：网关不可用或响应无效，请稍后重试。';
const MESSAGE_LOGOUT_FAILED = '退出登录请求失败：网关不可用或响应无效。';
const MESSAGE_ME_FAILED = '网关账户查询失败：网关不可用或响应无效。';
const MESSAGE_KEYS_FAILED = '网关 key 列表查询失败：网关不可用或响应无效。';
const MESSAGE_ME_KEY_FAILED = '网关 key 刷新失败：网关不可用或响应无效。';
const MESSAGE_MODELS_FAILED = '网关模型目录查询失败：网关不可用或响应无效。';
const MESSAGE_BALANCE_FAILED = '网关余额查询失败：网关不可用或响应无效。';

const MAX_QUERY_KEYS = 100;
const MAX_QUERY_MODELS = 500;
const MAX_MODEL_ID = 512;
const MAX_KEY_FIELD = 512;
const MAX_CAPABILITIES = 8192;
const MAX_CLASSIFICATION = 512;
const MAX_OBSERVED_AT = 64;

const PROTOCOL_FACES = new Set([
    'chat',
    'responses',
    'anthropic',
    'image',
    'tts',
    'embedding',
    'video',
]);

const MODALITIES = new Set(['text', 'image', 'embedding', 'tts', 'video']);
const AMOUNT_RE = /^\d+\.\d{6}$/;
const QUOTA_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 上游 key 列表契约禁止明文 key。即便网关契约漂移，明文形态字段名一旦出现
// 就整包拒绝（fail-closed），绝不把可能为明文的值序列化给浏览器。
const KEY_PLAINTEXT_FIELDS = Object.freeze(['key', 'secret', 'plaintext']);

class GatewayClientError extends Error {
    constructor(code, message, options) {
        super(message);
        this.name = 'GatewayClientError';
        this.code = code;
        // 查询面 401：登录凭据失效（与数据面 key 401 区分）。core 据此清本地
        // 登录并返回 409 not_connected；这里只给布尔标记，不带上游正文。
        this.unauthorized = !!(options && options.unauthorized === true);
        // 响应形态不符合契约：core 映射为 502 upstream_invalid_response。
        this.invalidShape = !!(options && options.invalidShape === true);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !/[\r\n\x00-\x1f\x7f]/.test(value);
}

function requireBoundedString(value, maxLength, makeInvalid) {
    if (!isBoundedString(value, maxLength)) throw makeInvalid();
    return value;
}

// BILL-08 H/K 降级（S9）：服务端只校验字段存在且为 string，不因 “1.5”“-1”
// 等非法值整包拒绝（余额其余字段仍严格）。合法性由 UI 的
// parsePenaltyIntegerString 判定，非法/缺失显示“未知”，绝不显示为零。
function requireStringField(value, makeInvalid) {
    if (typeof value !== 'string') throw makeInvalid();
    return value;
}

function requireAmount(value, makeInvalid) {
    if (typeof value !== 'string' || !AMOUNT_RE.test(value)) throw makeInvalid();
    return value;
}

function requireQuotaDate(value, makeInvalid) {
    if (value === null) return null;
    if (typeof value !== 'string' || !QUOTA_DATE_RE.test(value)) throw makeInvalid();
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day) {
        throw makeInvalid();
    }
    return value;
}

function requireObservedAt(value, makeInvalid) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OBSERVED_AT
        || Number.isNaN(Date.parse(value))) {
        throw makeInvalid();
    }
    return value;
}

function uniqueFaces(value, makeInvalid) {
    if (!Array.isArray(value)) throw makeInvalid();
    const faces = [];
    for (const face of value) {
        if (typeof face !== 'string' || !PROTOCOL_FACES.has(face)) throw makeInvalid();
        if (!faces.includes(face)) faces.push(face);
    }
    return faces;
}

// 授权页地址白名单：https + 固定网关域 + 无内嵌凭据 + 默认端口。浏览器与
// 服务端共用同一判定口径（UI 侧另有一份纯函数实现）。返回 boolean，不抛。
function isGatewayAuthorizeUrl(value) {
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

// 非 200 响应体主动 cancel：不读取、不回显，释放连接。cancel() 返回 Promise——
// 流已 errored 时会以 stored error 拒绝，未处理的 rejection 会击穿 ST 的
// uncaughtException 处理器（exitProcess），故与 core.js 的 cancelBodyQuietly 同口径吞掉。
function cancelBody(response) {
    try {
        if (response && response.body && typeof response.body.cancel === 'function') {
            Promise.resolve(response.body.cancel()).catch(() => {});
        }
    } catch {
        // cancel 失败不影响错误语义。
    }
}

function createGatewayClient(deps) {
    const options = deps || {};
    const fetchImpl = options.fetchImpl;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('createGatewayClient requires a fetch implementation');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('timeoutMs must be a positive integer');
    }

    // 200 响应体有界读取（512KB 上限；response.text() 无上限）。
    async function responseText(response, makeError) {
        if (!response || !response.body || typeof response.body.getReader !== 'function') {
            throw makeError();
        }
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value ? value.length : 0;
            if (total > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // cancel 失败不影响错误语义。
                }
                throw makeError();
            }
            chunks.push(value);
        }
        const parts = [];
        for (const chunk of chunks) {
            parts.push(Buffer.from(chunk));
        }
        return Buffer.concat(parts).toString('utf8');
    }

    // 单次调用：固定 URL + redirect:error + AbortController 总超时。
    // 期望状态码 → 有界读取 + JSON.parse；其他状态码 → cancel 正文后返回
    // { ok:false, status }；网络/超时 → makeError，坏 JSON → makeParseError。
    async function requestJson(url, init, makeError, expectedStatus, makeParseError) {
        const parseError = typeof makeParseError === 'function' ? makeParseError : makeError;
        const controller = new AbortController();
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(makeError());
            }, timeoutMs);
        });
        try {
            const response = await Promise.race([
                Promise.resolve().then(() => fetchImpl(url, {
                    ...init,
                    redirect: 'error',
                    signal: controller.signal,
                })),
                timeoutPromise,
            ]);
            if (!response) {
                throw makeError();
            }
            if (response.status !== expectedStatus) {
                cancelBody(response);
                return { ok: false, status: response.status };
            }
            const text = await Promise.race([
                responseText(response, makeError),
                timeoutPromise,
            ]);
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw parseError();
            }
            return { ok: true, parsed };
        } catch (error) {
            if (error instanceof GatewayClientError) throw error;
            throw makeError();
        } finally {
            clearTimeout(timer);
        }
    }

    // 无正文请求（logout）：只关心状态码，任何响应都 cancel 正文。
    async function requestStatus(url, init, makeError) {
        const controller = new AbortController();
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(makeError());
            }, timeoutMs);
        });
        try {
            const response = await Promise.race([
                Promise.resolve().then(() => fetchImpl(url, {
                    ...init,
                    redirect: 'error',
                    signal: controller.signal,
                })),
                timeoutPromise,
            ]);
            if (!response) throw makeError();
            cancelBody(response);
            return response.status;
        } catch (error) {
            if (error instanceof GatewayClientError) throw error;
            throw makeError();
        } finally {
            clearTimeout(timer);
        }
    }

    // POST /api/connect/requests，请求体恰 '{}'。200 → 严格解析四字段；
    // polling_secret 是取件凭据：只随返回值交给 core 的内存会话表，绝不入日志/响应。
    async function startConnect() {
        const makeError = () => new GatewayClientError(START_CODE, MESSAGE_START_FAILED);
        const outcome = await requestJson(
            `${PORTAL_ORIGIN}${START_CONNECT_PATH}`,
            {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: '{}',
            },
            makeError,
            200,
        );
        if (!outcome.ok) throw makeError();
        const payload = outcome.parsed;
        if (!isPlainObject(payload)) throw makeError();
        const requestRef = payload.request_ref;
        const pollingSecret = payload.polling_secret;
        const authorizeUrl = payload.authorize_url;
        const expiresAt = payload.expires_at;
        if (typeof requestRef !== 'string' || requestRef.length === 0 || requestRef.length > 4096
            || typeof pollingSecret !== 'string' || pollingSecret.length === 0 || pollingSecret.length > 4096
            || typeof expiresAt !== 'string' || expiresAt.length === 0 || expiresAt.length > 128
            || !isGatewayAuthorizeUrl(authorizeUrl)) {
            throw makeError();
        }
        return { requestRef, pollingSecret, authorizeUrl, expiresAt };
    }

    // POST /api/connect/requests/poll，请求体恰 {"polling_secret": ...}。
    // 200 pending / approved（connect.login_credential / key / username 严格校验）；
    // 404 → { status:'invalid' }（不存在/已消费/已过期/失效联动/已取消，不可区分）；
    // 其余形态 → 固定错误，fail-closed。
    async function pollConnect(pollingSecret) {
        const makeError = () => new GatewayClientError(POLL_CODE, MESSAGE_POLL_FAILED);
        if (typeof pollingSecret !== 'string' || pollingSecret.length === 0 || pollingSecret.length > 4096) {
            throw makeError();
        }
        const outcome = await requestJson(
            `${PORTAL_ORIGIN}${POLL_CONNECT_PATH}`,
            {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ polling_secret: pollingSecret }),
            },
            makeError,
            200,
        );
        if (!outcome.ok) {
            if (outcome.status === 404) {
                return { status: 'invalid' };
            }
            throw makeError();
        }
        const payload = outcome.parsed;
        if (!isPlainObject(payload)) throw makeError();
        if (payload.status === 'pending') {
            return { status: 'pending' };
        }
        if (payload.status === 'approved') {
            const connect = payload.connect;
            if (!isPlainObject(connect)
                || !isValidLoginCredential(connect.login_credential)
                || !isValidBindingKey(connect.key)
                || !isValidUsername(connect.username)) {
                throw makeError();
            }
            return {
                status: 'approved',
                connect: {
                    loginCredential: connect.login_credential,
                    key: connect.key,
                    username: connect.username,
                },
            };
        }
        throw makeError();
    }

    // POST /api/plugin/logout，Bearer 登录凭据；204 视为成功；401 表示该凭据
    // 已失效/已撤销（H12：等价于远端已撤销，成功返回，不当作失败）；其他状态
    // → 固定错误。v1.35 connect-0.5：204 响应无 body；网关对非空请求体/未知
    // 字段回 422，因此本请求不发送 body、不发送 content-type（只带 accept 与
    // authorization）。本地清理由调用方无条件执行，不依赖本函数结果。
    async function logout(loginCredential) {
        const makeError = () => new GatewayClientError(LOGOUT_CODE, MESSAGE_LOGOUT_FAILED);
        if (!isValidLoginCredential(loginCredential)) {
            throw makeError();
        }
        const status = await requestStatus(
            `${PORTAL_ORIGIN}${LOGOUT_PATH}`,
            {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${loginCredential}`,
                },
            },
            makeError,
        );
        if (status === 204) {
            return { status: 'logged_out' };
        }
        if (status === 401) {
            return { ok: true, alreadyRevoked: true };
        }
        throw makeError();
    }

    // GET /api/plugin/me/key，Bearer 登录凭据；200 → {key, username} 严格校验。
    // 401 也走固定错误，但带 unauthorized 标记：查询面凭据失效属登录失效，
    // 与数据面 key 401 区分由 core 的注释说明。
    async function fetchMeKey(loginCredential) {
        const makeError = () => new GatewayClientError(ME_KEY_CODE, MESSAGE_ME_KEY_FAILED);
        if (!isValidLoginCredential(loginCredential)) {
            throw makeError();
        }
        const outcome = await requestJson(
            `${PORTAL_ORIGIN}${ME_KEY_PATH}`,
            {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${loginCredential}`,
                },
            },
            makeError,
            200,
            () => new GatewayClientError(ME_KEY_CODE, MESSAGE_ME_KEY_FAILED, { invalidShape: true }),
        );
        if (!outcome.ok) {
            if (outcome.status === 401) {
                throw new GatewayClientError(ME_KEY_CODE, MESSAGE_ME_KEY_FAILED, { unauthorized: true });
            }
            throw makeError();
        }
        const payload = outcome.parsed;
        if (!isPlainObject(payload)
            || !isValidBindingKey(payload.key)
            || !isValidUsername(payload.username)) {
            throw new GatewayClientError(ME_KEY_CODE, MESSAGE_ME_KEY_FAILED, { invalidShape: true });
        }
        return { key: payload.key, username: payload.username };
    }

    // 查询面通用 GET：固定 URL、Bearer 登录凭据、严格解析；401 → unauthorized
    // 标记（core 清本地登录），其他失败 → 固定错误。响应体仍走 512KB 有界读取。
    async function queryGet(path, loginCredential, code, message, project) {
        const makeError = () => new GatewayClientError(code, message);
        const makeInvalid = () => new GatewayClientError(code, message, { invalidShape: true });
        if (!isValidLoginCredential(loginCredential)) throw makeError();
        const outcome = await requestJson(
            `${PORTAL_ORIGIN}${path}`,
            {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${loginCredential}`,
                },
            },
            makeError,
            200,
            makeInvalid,
        );
        if (!outcome.ok) {
            if (outcome.status === 401) {
                throw new GatewayClientError(code, message, { unauthorized: true });
            }
            throw makeError();
        }
        return project(outcome.parsed, makeInvalid);
    }

    // GET /api/plugin/me：账号确认（登录状态探活）。
    async function fetchMe(loginCredential) {
        return queryGet(ME_PATH, loginCredential, ME_CODE, MESSAGE_ME_FAILED, (payload, invalid) => {
            if (!isPlainObject(payload) || !isValidUsername(payload.username)) throw invalid();
            return { username: payload.username };
        });
    }

    // GET /api/plugin/me/keys：{keys:[{id,name,masked,status}]}，不含明文。
    // v1 恒一把；结构按多 key 向后兼容（条数上限 100，超限整包拒绝）。
    async function fetchKeys(loginCredential) {
        return queryGet(KEYS_PATH, loginCredential, KEYS_CODE, MESSAGE_KEYS_FAILED, (payload, invalid) => {
            if (!isPlainObject(payload) || !Array.isArray(payload.keys)
                || payload.keys.length > MAX_QUERY_KEYS) {
                throw invalid();
            }
            const keys = payload.keys.map((item) => {
                if (!isPlainObject(item)) throw invalid();
                // 防御上游字段漂移：任何明文 key 形态字段出现即整包拒绝。
                for (const field of KEY_PLAINTEXT_FIELDS) {
                    if (Object.hasOwn(item, field)) throw invalid();
                }
                return {
                    id: requireBoundedString(item.id, MAX_KEY_FIELD, invalid),
                    name: requireBoundedString(item.name, MAX_KEY_FIELD, invalid),
                    masked: requireBoundedString(item.masked, MAX_KEY_FIELD, invalid),
                    status: requireBoundedString(item.status, MAX_KEY_FIELD, invalid),
                };
            });
            return { keys };
        });
    }

    // GET /api/plugin/me/models：{object:"list", data:[{id, object, protocol_faces, ...}]}。
    // 插件线形状统一为 {items:[{name:<id>, protocol_faces, 可选 modality/
    // capabilities/classification_name}]}，与既有目录行渲染口径对齐；未知协议面
    // 整包拒绝（fail-closed），未知字段丢弃。
    async function fetchModels(loginCredential) {
        return queryGet(MODELS_PATH, loginCredential, MODELS_CODE, MESSAGE_MODELS_FAILED, (payload, invalid) => {
            if (!isPlainObject(payload) || payload.object !== 'list'
                || !Array.isArray(payload.data) || payload.data.length > MAX_QUERY_MODELS) {
                throw invalid();
            }
            const items = payload.data.map((item) => {
                if (!isPlainObject(item)) throw invalid();
                const name = requireBoundedString(item.id, MAX_MODEL_ID, invalid);
                const projected = {
                    name,
                    protocol_faces: uniqueFaces(item.protocol_faces, invalid),
                };
                if (item.modality !== undefined) {
                    if (typeof item.modality !== 'string' || !MODALITIES.has(item.modality)) throw invalid();
                    projected.modality = item.modality;
                }
                if (item.capabilities !== undefined) {
                    if (typeof item.capabilities !== 'string' || item.capabilities.length > MAX_CAPABILITIES) {
                        throw invalid();
                    }
                    projected.capabilities = item.capabilities;
                }
                if (item.classification_name !== undefined) {
                    projected.classification_name = requireBoundedString(
                        item.classification_name,
                        MAX_CLASSIFICATION,
                        invalid,
                    );
                }
                return projected;
            });
            return { items };
        });
    }

    // GET /api/plugin/me/balance：BalanceSnapshot（query §2 字段集 + BILL-08
    // 两必填字段）。H/K 仅要求存在且为 string（S9 降级；非法值由 UI 显示
    // “未知”），不因 H/K 非法整包拒绝。其余数值字段仍严格。
    async function fetchBalance(loginCredential) {
        return queryGet(BALANCE_PATH, loginCredential, BALANCE_CODE, MESSAGE_BALANCE_FAILED, (payload, invalid) => {
            if (!isPlainObject(payload) || typeof payload.needs_refresh !== 'boolean') throw invalid();
            return {
                permanent_balance: requireAmount(payload.permanent_balance, invalid),
                debt: requireAmount(payload.debt, invalid),
                daily_quota: requireAmount(payload.daily_quota, invalid),
                daily_quota_used: requireAmount(payload.daily_quota_used, invalid),
                daily_quota_remaining: requireAmount(payload.daily_quota_remaining, invalid),
                quota_date: requireQuotaDate(payload.quota_date, invalid),
                needs_refresh: payload.needs_refresh,
                observed_at: requireObservedAt(payload.observed_at, invalid),
                penalty_input_threshold: requireStringField(payload.penalty_input_threshold, invalid),
                penalty_multiplier: requireStringField(payload.penalty_multiplier, invalid),
            };
        });
    }

    return {
        startConnect,
        pollConnect,
        logout,
        fetchMe,
        fetchKeys,
        fetchMeKey,
        fetchModels,
        fetchBalance,
    };
}

module.exports = {
    createGatewayClient,
    PORTAL_ORIGIN,
    isGatewayAuthorizeUrl,
    GatewayClientError,
};
