'use strict';

// 网关连接记录（SillyTavern 密钥库 apercus_gateway 命名空间）的序列化与解析。
// 纯函数、零依赖、无副作用：写入方（secrets-binding 适配器）与测试共用同一形态。
//
// v3 记录形态（网关连接契约 v1.35 §connect-0.2：approved 恰一次交付
// login_credential ＋ key ＋ username）：{"version":1,"login_credential":...,
// "key":...,"username":...}。整体序列化为字符串写入 SecretValue.value
// （ST secrets 为数组 schema，value 只收字符串）；禁止直写扁平 JSON。
// 解析 fail-closed：密钥库里的手改坏数据/版本漂移一律返回 null，绝不变成可用绑定。

const BINDING_NAMESPACE = 'apercus_gateway';
// ST Custom OpenAI-compatible 源生成鉴权读取的命名空间（chat-completions.js
// readSecret(directories, SECRET_KEYS.CUSTOM)）——"用户只填 URL、key 由连接交付"
// 口径的落位。
const CUSTOM_SOURCE_NAMESPACE = 'api_key_custom';

// 绑定 key 的写/读双侧统一校验：非空 string、≤4096、无控制字符（CRLF 等会进
// Authorization 被拒，也会破坏 JSON 信封外的使用面）。
function isValidBindingKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= 4096
        && !/[\r\n\x00-\x1f\x7f]/.test(key);
}

// 插件登录凭据同口径：非空 string、≤4096、无控制字符（它要进 Bearer 头）。
function isValidLoginCredential(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096
        && !/[\r\n\x00-\x1f\x7f]/.test(value);
}

function isValidUsername(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512
        && !/[\r\n\x00-\x1f\x7f]/.test(value);
}

// custom_keys 是插件写入过 api_key_custom 的历史 key 列表（≤8），用于注销/
// 失效清理时按值识别插件自有条目（含 ST 里已 inactive 的旧条目）。旧信封没有
// 该字段 → []。序列化侧去重（同一 key 重复写不累积）；解析侧更严格：重复项
// 直接判坏（fail-closed，绝不把坏列表当归属依据）。
const MAX_CUSTOM_KEYS = 8;

function normalizeCustomKeysForSerialize(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_CUSTOM_KEYS) return null;
    const keys = [];
    for (const item of value) {
        if (!isValidBindingKey(item)) return null;
        if (!keys.includes(item)) keys.push(item);
    }
    return keys;
}

function parseCustomKeys(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_CUSTOM_KEYS) return null;
    const keys = [];
    const seen = new Set();
    for (const item of value) {
        if (!isValidBindingKey(item)) return null;
        if (seen.has(item)) return null;
        seen.add(item);
        keys.push(item);
    }
    return keys;
}

// 放宽校验入口（core 归一化测试 stub 记录用）：非法 → null；合法 → 去重数组。
function normalizeCustomKeys(value) {
    return normalizeCustomKeysForSerialize(value);
}

// 三字段均合法；可选 custom_keys 严格校验（string[]、去重、≤8、逐项合法）。
// 输出键序固定 version/login_credential/key/username/custom_keys（列表为空时
// 省略该字段，保持旧信封形状）。任何非法入参返回 null（不写入密钥库）。
function serializeBindingRecord(record) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        return null;
    }
    const loginCredential = record.loginCredential;
    const key = record.key;
    const username = record.username;
    if (!isValidLoginCredential(loginCredential)) return null;
    if (!isValidBindingKey(key)) return null;
    if (!isValidUsername(username)) return null;
    const customKeys = normalizeCustomKeysForSerialize(record.customKeys);
    if (customKeys === null) return null;
    const payload = {
        version: 1,
        login_credential: loginCredential,
        key,
        username,
    };
    if (customKeys.length > 0) payload.custom_keys = customKeys;
    return JSON.stringify(payload);
}

// string → JSON.parse → plain object → version === 1（严格）→ 三字段合法
// → 返回冻结 { loginCredential, key, username }；任何一步失败返回 null（fail-closed）。
function parseBindingRecord(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    if (parsed.version !== 1) return null;
    if (!isValidLoginCredential(parsed.login_credential)) return null;
    if (!isValidBindingKey(parsed.key)) return null;
    if (!isValidUsername(parsed.username)) return null;
    const customKeys = parseCustomKeys(parsed.custom_keys);
    if (customKeys === null) return null;
    return Object.freeze({
        loginCredential: parsed.login_credential,
        key: parsed.key,
        username: parsed.username,
        customKeys: Object.freeze(customKeys),
    });
}

module.exports = {
    BINDING_NAMESPACE,
    CUSTOM_SOURCE_NAMESPACE,
    MAX_CUSTOM_KEYS,
    serializeBindingRecord,
    parseBindingRecord,
    normalizeCustomKeys,
    isValidBindingKey,
    isValidLoginCredential,
    isValidUsername,
};
