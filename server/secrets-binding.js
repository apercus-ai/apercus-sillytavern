'use strict';

// SillyTavern 服务端密钥库的网关连接记录适配器（B1 v3 网页授权）。
//
// 落位：apercus_gateway 命名空间（信封 JSON），经 ST 内部模块
// src/endpoints/secrets.js 的 SecretManager 读写（ST 1.17.0 口径：
// new SecretManager(directories).readSecret(name) / .writeSecret(name, value, label)
// / .deleteSecret(name)，value 必须是字符串）。writeSecret 每次追加新条目并
// 返回条目 id（secrets.js:203-221）；deleteSecret(name) 只删当前 active 条目，
// 并在仍有旧条目时重新激活其中一条。这是未文档化 API，ST 升级回归点；
// 导入结果缓存，进程内只裁决一次。
//
// 命名空间分工（B3 修订）：连接/刷新只写信封；ST Custom 源读取的原始 key
// （api_key_custom）只在用户于模型选择确认弹窗确认接入后，经
// writeCustomSourceKey 写入——不再随 connect/refresh 双写。logout 与查询面
// 401 仍清两命名空间（clearBinding），避免酒馆继续持有可用 key。
//
// 归属（S1/F2/I4）：api_key_custom 与其它 ST secret 共享命名空间，用户可能自己
// 填过 key。插件把写入过的 key 记在信封可选字段 custom_keys（≤8，string[]）；
// 清理用 getAllSecrets() 枚举全部条目（含 inactive），只删除“值 ∈ custom_keys
// ∪ 当前 key”的条目（deleteSecret(name, id)），用户自有值一律不动。
// I4：新 approved 覆盖信封前先按旧信封归属清掉插件自有 Custom 条目，新信封
// 不继承旧 custom_keys——否则换账号后 ST 仍用上一账号的 key 计费。refreshKey
// 是同一登录的 key 轮换，仍保留 custom_keys 供注销清理。信封损坏/读失败时
// 不猜归属、不触碰 Custom（approved 覆盖也 fail-closed）。writeSecret 返回的
// 条目 id 仍按 root 记在进程内 Map，但只作诊断，清理不再依赖 id。
//
// fail-closed 边界：stRoot 不存在 / 模块导入失败 / SecretManager 缺失 / 任何读写异常
// → readBinding 恒 null、write/clear/refresh 恒 false，绝不抛出到路由层。
// 写失败不置已授权。任何凭据值不进日志。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
    BINDING_NAMESPACE,
    CUSTOM_SOURCE_NAMESPACE,
    MAX_CUSTOM_KEYS,
    serializeBindingRecord,
    parseBindingRecord,
    normalizeCustomKeys,
    isValidBindingKey,
    isValidUsername,
} = require('./binding-store');

const SECRET_LABEL = 'apercus gateway binding';
const CUSTOM_SOURCE_LABEL = 'apercus gateway binding (custom source)';

// 默认加载器：动态 import ST 的 secrets 模块并取导出的 SecretManager 构造器；
// 未导出或形态不符返回 null。异常由调用方统一捕获（fail-closed）。
function defaultSecretManagerLoader(stRoot) {
    return async function load() {
        const moduleUrl = pathToFileURL(path.join(stRoot, 'src', 'endpoints', 'secrets.js')).href;
        const mod = await import(moduleUrl);
        const Manager = mod && mod.SecretManager;
        return typeof Manager === 'function' ? Manager : null;
    };
}

// directories 形态守卫：身份只来自 ST 注入的 req.user.directories（含非空 root），
// 其他形态一律拒绝。
function validDirectories(directories) {
    return directories !== null && typeof directories === 'object'
        && typeof directories.root === 'string' && directories.root.length > 0;
}

function createSecretBindingAdapter(options) {
    const config = options || {};
    const stRoot = typeof config.stRoot === 'string' && config.stRoot.length > 0
        ? config.stRoot
        : path.resolve(__dirname, '..', '..'); // 插件位于 <ST>/plugins/apercus-gateway
    const secretManagerLoader = typeof config.secretManagerLoader === 'function'
        ? config.secretManagerLoader
        : defaultSecretManagerLoader(stRoot);

    // 进程内归属表：root → 最近一次 writeCustomSourceKey 写入的条目 id。
    // 不持久化、不进信封、不进日志；map 为空时仍按值比较清理。
    const customSourceWriteIds = new Map();
    // H3：Custom 同步待修复标记（root → true，仅内存）。refreshKey 已刷新信封、
    // 但把插件自有 Custom 活动值同步成新 key 失败时记录；后续 /status 探活
    // 调 retryCustomSync 重试，成功或确认无需同步（用户自值/已是新 key）后清除。
    const customSyncPending = new Map();

    // 导入 promise 缓存：并发首访共享同一 in-flight 导入；导入失败缓存 null
    // （fail-closed：恒未绑定、不半开），绝不抛出。
    let cachedLoad = null;
    function loadSecretManager() {
        if (!cachedLoad) {
            cachedLoad = Promise.resolve()
                .then(() => secretManagerLoader())
                .then((loaded) => (typeof loaded === 'function' ? loaded : null))
                .catch(() => null);
        }
        return cachedLoad;
    }

    // 读记录：信封 → parseBindingRecord → 冻结 {loginCredential,key,username} 或 null。
    async function readBinding(directories) {
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) return null;
        try {
            const manager = new Manager(directories);
            if (typeof manager.readSecret !== 'function') return null;
            const raw = await manager.readSecret(BINDING_NAMESPACE);
            return parseBindingRecord(raw);
        } catch {
            return null;
        }
    }

    // G8：需要区分“没有信封”（empty，幂等路径）与“读/解析失败”（不能把未知
    // 归属报成清理成功）。只供 /release-custom-key 这类需要如实回答的路径使用；
    // 其他读取仍走 readBinding 的 fail-closed null。
    async function readBindingState(directories) {
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) return { status: 'error' };
        try {
            const manager = new Manager(directories);
            if (typeof manager.readSecret !== 'function') return { status: 'error' };
            const raw = await manager.readSecret(BINDING_NAMESPACE);
            if (raw === null || raw === undefined || raw === '') return { status: 'empty' };
            const record = parseBindingRecord(raw);
            if (!record) return { status: 'invalid' };
            return { status: 'ok', record };
        } catch {
            return { status: 'error' };
        }
    }

    // 写记录（approved 领取后调用）：只写信封。api_key_custom 不在此写入——
    // 它只在 B3 模型接入确认路由（apply-model）里按用户确认写入。
    // I4 多账号：新 approved 覆盖活动信封前，先按旧信封 custom_keys ∪ 旧 key
    // 清掉插件自有的 Custom 条目（用户自有值不动）。否则 B 登录后信封指向 B，
    // ST Custom 仍持有 A 的 key，生成会继续记费到 A。新信封不再继承旧
    // custom_keys；旧信封损坏/读失败时归属未知，拒绝覆盖（fail-closed）。
    // J5：同账号同 key 重连（approved 重放/重复登录）例外——Custom 活动值可能
    // 正是这个 key，按旧归属清理会删掉刚确认可用的凭据；此时保留旧
    // custom_keys 与 Custom 条目、只重写信封（credential 可更新）。
    async function writeBinding(directories, record) {
        if (!record || typeof record !== 'object') return false;
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) return false;
        try {
            const manager = new Manager(directories);
            if (typeof manager.writeSecret !== 'function') return false;
            const requested = normalizeCustomKeys(record.customKeys);
            if (requested === null) return false;
            if (typeof manager.readSecret !== 'function') {
                // 无法读取旧信封 = 无法证明 Custom 归属：拒绝覆盖（fail-closed）。
                return false;
            }
            let previous = null;
            let raw;
            try {
                raw = await manager.readSecret(BINDING_NAMESPACE);
            } catch {
                // 旧信封读失败：无法证明 Custom 归属，覆盖会遗留旧 key。
                return false;
            }
            if (raw !== null && raw !== undefined && raw !== '') {
                previous = parseBindingRecord(raw);
                if (!previous) return false;
            }
            let sameKeySameUser = false;
            if (previous) {
                sameKeySameUser = previous.key === record.key
                    && previous.username === record.username;
                if (!sameKeySameUser) {
                    const oldKeys = [];
                    for (const key of [previous.key].concat(previous.customKeys)) {
                        if (isValidBindingKey(key) && !oldKeys.includes(key)) oldKeys.push(key);
                    }
                    let cleaned;
                    try {
                        cleaned = await clearCustomSourceEntries(manager, oldKeys);
                    } catch {
                        cleaned = { ok: false, cleared: false };
                    }
                    // 旧插件 key 未清干净：不覆盖信封（保留旧归属供重试/注销）。
                    if (!cleaned || cleaned.cleared !== true) return false;
                }
            }
            // J5：同 key 时保留旧归属（旧 Custom 条目未清理），信封必须继续记录
            // 这些 key，否则 logout/失效清理将失去归属依据。
            let envelopeKeys = requested;
            if (sameKeySameUser) {
                envelopeKeys = [];
                for (const key of previous.customKeys.concat(requested)) {
                    if (isValidBindingKey(key) && !envelopeKeys.includes(key)) envelopeKeys.push(key);
                }
            }
            const bounded = await boundCustomKeys(manager, envelopeKeys);
            // 淘汰清理失败且保留后装不下：拒绝写入并带 warn（旧信封原样保留）。
            if (!bounded.ok) return { ok: false, warn: bounded.warn };
            const serialized = serializeBindingRecord({
                loginCredential: record.loginCredential,
                key: record.key,
                username: record.username,
                customKeys: bounded.keys,
            });
            if (!serialized) return false;
            await manager.writeSecret(BINDING_NAMESPACE, serialized, SECRET_LABEL);
            // 部分淘汰清理失败但新信封已写入：返回结构化 warn 供调用方展示，
            // 语义仍是“已写入”（ok:true）。
            return bounded.warn ? { ok: true, warn: bounded.warn } : true;
        } catch {
            return false;
        }
    }

    // I8：信封命名空间按 id 逐条删除。ST 1.17.0 的 deleteSecret(name) 只删
    // active 条目，并在仍有旧条目时重新激活其中一条（secrets.js:203-247、
    // 373）——无 id 循环会在删除 active 后短暂/反复复活历史条目（崩溃残留）。
    // getAllSecrets() 枚举全部条目（含 inactive），先删 inactive、最后删
    // active，避免中途重新激活；删除/枚举失败一律报告失败，不假成功。
    async function deleteEnvelopeNamespace(manager) {
        if (typeof manager.getAllSecrets !== 'function'
            || typeof manager.deleteSecret !== 'function') {
            return false;
        }
        let secrets;
        try {
            secrets = manager.getAllSecrets();
        } catch {
            return false;
        }
        if (!secrets || typeof secrets !== 'object') return false;
        const entries = secrets[BINDING_NAMESPACE];
        if (entries === undefined || entries === null) return true;
        // 兼容简化的旧测试存储：整个命名空间就是一个活动字符串。
        if (typeof entries === 'string') {
            try {
                await manager.deleteSecret(BINDING_NAMESPACE);
            } catch {
                return false;
            }
        } else if (Array.isArray(entries)) {
            const targets = [];
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') return false;
                if (typeof entry.id !== 'string' && typeof entry.id !== 'number') return false;
                targets.push({ id: entry.id, active: entry.active === true });
            }
            // inactive 先删、active 最后：任何中间态都不会另选条目成为 active。
            targets.sort((a, b) => (a.active === b.active ? 0 : (a.active ? 1 : -1)));
            for (const target of targets) {
                try {
                    await manager.deleteSecret(BINDING_NAMESPACE, target.id);
                } catch {
                    return false;
                }
            }
        } else {
            return false;
        }
        // 删除后重新枚举确认命名空间已空；读失败不得报成功。
        try {
            secrets = manager.getAllSecrets();
        } catch {
            return false;
        }
        if (!secrets || typeof secrets !== 'object') return false;
        const remaining = secrets[BINDING_NAMESPACE];
        if (remaining === undefined || remaining === null) return true;
        if (typeof remaining === 'string') return remaining.length === 0;
        if (Array.isArray(remaining)) return remaining.length === 0;
        return false;
    }

    // F2 归属清理：用 getAllSecrets() 枚举 api_key_custom 的全部条目（含 ST 已
    // 停用的历史条目），按条目 id 调 deleteSecret(name, id) 删除“值 ∈ keys”的
    // 每一条。用户自有值（不在 keys 里）一律不动。删除后重新枚举确认没有插件
    // 值残留。
    // G8：返回 {ok, cleared} 区分“操作没做成”（ok:false，无法确认）与“做了但
    // 仍有残留”（ok:true, cleared:false）；任何读/枚举/删除失败都 fail-closed
    // 到 ok:false，不把未知状态报成清干净。
    async function clearCustomSourceEntries(manager, keys) {
        if (typeof manager.getAllSecrets !== 'function'
            || typeof manager.deleteSecret !== 'function') {
            return { ok: false, cleared: false };
        }
        let secrets;
        try {
            secrets = manager.getAllSecrets();
        } catch {
            return { ok: false, cleared: false };
        }
        if (!secrets || typeof secrets !== 'object') return { ok: false, cleared: false };
        const entries = secrets[CUSTOM_SOURCE_NAMESPACE];
        if (entries === undefined || entries === null) return { ok: true, cleared: true };
        const owned = new Set(keys);
        const targets = [];
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                if (entry && typeof entry === 'object'
                    && typeof entry.value === 'string' && owned.has(entry.value)) {
                    targets.push({ id: entry.id, value: entry.value });
                }
            }
        } else if (typeof entries === 'string' && owned.has(entries)) {
            // 兼容简化的旧测试存储：整个命名空间就是一个活动字符串。
            targets.push({ id: null, value: entries });
        } else {
            return { ok: false, cleared: false };
        }
        for (const target of targets) {
            try {
                if (target.id === undefined || target.id === null) {
                    await manager.deleteSecret(CUSTOM_SOURCE_NAMESPACE);
                } else {
                    await manager.deleteSecret(CUSTOM_SOURCE_NAMESPACE, target.id);
                }
            } catch {
                return { ok: false, cleared: false };
            }
        }
        // 重新枚举：只要还残留任一插件值（active 或 inactive）就算未清干净。
        try {
            secrets = manager.getAllSecrets();
        } catch {
            return { ok: false, cleared: false };
        }
        if (!secrets || typeof secrets !== 'object') return { ok: false, cleared: false };
        const remaining = secrets[CUSTOM_SOURCE_NAMESPACE];
        if (remaining === undefined || remaining === null) return { ok: true, cleared: true };
        if (Array.isArray(remaining)) {
            const clean = remaining.every((entry) => !(entry && typeof entry === 'object'
                && typeof entry.value === 'string' && owned.has(entry.value)));
            return { ok: true, cleared: clean };
        }
        return { ok: true, cleared: !(typeof remaining === 'string' && owned.has(remaining)) };
    }

    // G5：custom_keys 上限 MAX_CUSTOM_KEYS。淘汰最旧条目之前先清掉该值对应的
    // Custom secret 条目；清理失败（枚举/删除失败或仍有残留）时保留该 key，
    // 不丢归属。保留后若仍超过上限，则拒绝本次写入（{ok:false}，调用方不得
    // 序列化超限信封）。返回 {ok, keys, warn}。
    async function boundCustomKeys(manager, orderedKeys) {
        if (orderedKeys.length <= MAX_CUSTOM_KEYS) {
            return { ok: true, keys: orderedKeys.slice(), warn: null };
        }
        const overflow = orderedKeys.length - MAX_CUSTOM_KEYS;
        const candidates = orderedKeys.slice(0, overflow);
        const kept = orderedKeys.slice(overflow);
        const retained = [];
        let cleanupFailed = false;
        for (const key of candidates) {
            let result = { ok: false, cleared: false };
            try {
                result = await clearCustomSourceEntries(manager, [key]);
            } catch {
                result = { ok: false, cleared: false };
            }
            if (result && result.cleared === true) continue; // 已清掉，可安全淘汰
            cleanupFailed = true;
            retained.push(key); // 清不掉：保留归属
        }
        const bounded = retained.concat(kept);
        if (bounded.length > MAX_CUSTOM_KEYS) {
            // 保留了清不掉的旧 key，无法在不丢归属的前提下装进 schema。
            return { ok: false, keys: orderedKeys.slice(), warn: 'custom_keys_evict_failed' };
        }
        return {
            ok: true,
            keys: bounded,
            warn: cleanupFailed ? 'custom_keys_evict_failed' : null,
        };
    }

    // 公开入口：keys 只接受 string[]（单个合法 key 兼容为 [key]）；空列表视为
    // 无需清理。返回 {ok, cleared}（G8）；非法形态/目录/管理器 → ok:false。
    async function clearCustomSourceKey(directories, keys) {
        const list = typeof keys === 'string' ? [keys] : keys;
        if (!Array.isArray(list) || list.length > MAX_CUSTOM_KEYS + 1) {
            return { ok: false, cleared: false };
        }
        const unique = [];
        for (const key of list) {
            if (!isValidBindingKey(key)) return { ok: false, cleared: false };
            if (!unique.includes(key)) unique.push(key);
        }
        if (unique.length === 0) return { ok: true, cleared: true };
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) return { ok: false, cleared: false };
        try {
            const manager = new Manager(directories);
            const result = await clearCustomSourceEntries(manager, unique);
            if (result.cleared) {
                customSourceWriteIds.delete(directories.root);
                // H3：Custom 已清干净，没有待同步的插件值。
                customSyncPending.delete(directories.root);
            }
            return result;
        } catch {
            return { ok: false, cleared: false };
        }
    }

    // 退出登录 / 失效清理（F2）：先辨明信封状态，再按信封 custom_keys ∪ 当前
    // key 清 Custom 的插件自有条目；custom 清理失败 → 不删信封（保留归属依据
    // 供重试，返回 {envelope:false,custom:false}，绝不把“没清干净”报成成功）。
    // H6：信封损坏/读失败时无法识别 Custom 归属，不猜、不删信封——返回
    // {envelope:false,custom:false}（logout 因此 502，引导门户 revoke-all 兜底）。
    // 只有 empty（确实没有信封，Custom 无插件记录）才只删信封并报 custom:true。
    async function clearBinding(directories) {
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) {
            return { envelope: false, custom: false };
        }
        try {
            const manager = new Manager(directories);
            if (typeof manager.deleteSecret !== 'function') {
                return { envelope: false, custom: false };
            }
            const state = await readBindingState(directories);
            if (state.status !== 'ok' && state.status !== 'empty') {
                // invalid / error：归属未知，不删信封、不触碰 Custom。
                return { envelope: false, custom: false };
            }
            const keys = [];
            if (state.status === 'ok') {
                keys.push(state.record.key);
                for (const key of state.record.customKeys) {
                    if (!keys.includes(key)) keys.push(key);
                }
            }
            const custom = await clearCustomSourceEntries(manager, keys);
            if (custom.cleared !== true) {
                // custom 未清干净（失败或仍有残留）：信封必须保留（否则下次
                // 清理失去归属依据）。
                return { envelope: false, custom: false };
            }
            // W10：信封不存在时没有归属依据。若 Custom 命名空间仍有条目，
            // 无法证明其中没有残留的插件 key → 标记 uncertain；调用方据此
            // 报告 custom_cleared:false 并强制清空 URL，而不是假定已清。
            let customUncertain = false;
            if (state.status === 'empty' && typeof manager.getAllSecrets === 'function') {
                try {
                    const secrets = manager.getAllSecrets();
                    const entries = secrets && typeof secrets === 'object'
                        ? secrets[CUSTOM_SOURCE_NAMESPACE]
                        : undefined;
                    customUncertain = entries !== undefined && entries !== null
                        && !(Array.isArray(entries) && entries.length === 0);
                } catch {
                    customUncertain = true;
                }
            }
            const envelope = await deleteEnvelopeNamespace(manager);
            if (envelope) {
                // H3：信封已清，待同步标记不再有意义。
                customSyncPending.delete(directories.root);
            }
            return customUncertain
                ? { envelope, custom: true, customUncertain: true }
                : { envelope, custom: true };
        } catch {
            return { envelope: false, custom: false };
        }
    }

    // key 重置后刷新（F2/F3）：保留既有 login_credential（除非调用方要求核对
    // expectedLoginCredential），替换 key；custom_keys 并入新 key（保留旧 key，
    // 注销时能清掉 ST 里已 inactive 的旧条目）。
    // - credential 与 expected 不同 → {conflict:true}，不写任何东西（慢请求不得
    //   把上一账号的刷新落到新登录上）。
    // - 信封写失败 → {envelope:false,custom:false}，旧信封不动（fail-closed）。
    // - Custom 活动值属于插件 keys → 同步写新 key；同步失败只记 custom:false，
    //   信封刷新保留（core best-effort，不因此推翻登录刷新）。
    // 返回 {envelope, custom, conflict}。
    async function refreshKey(directories, key, username, options) {
        const expected = options && typeof options.expectedLoginCredential === 'string'
            ? options.expectedLoginCredential
            : null;
        if (!isValidBindingKey(key) || !isValidUsername(username)) {
            return { envelope: false, custom: false, conflict: false };
        }
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) {
            return { envelope: false, custom: false, conflict: false };
        }
        try {
            const manager = new Manager(directories);
            if (typeof manager.readSecret !== 'function'
                || typeof manager.writeSecret !== 'function') {
                return { envelope: false, custom: false, conflict: false };
            }
            const raw = await manager.readSecret(BINDING_NAMESPACE);
            const current = parseBindingRecord(raw);
            if (!current) return { envelope: false, custom: false, conflict: false };
            if (expected !== null && current.loginCredential !== expected) {
                return { envelope: false, custom: false, conflict: true };
            }
            const customKeys = [];
            for (const item of current.customKeys.concat([current.key, key])) {
                if (isValidBindingKey(item) && !customKeys.includes(item)) {
                    customKeys.push(item);
                }
            }
            // 保留最近使用的 MAX_CUSTOM_KEYS 个（新 key 必须在列；最旧的可被
            // 挤出，避免 schema 超限导致信封写不进去）。G5：挤出前先清掉该值
            // 对应的 Custom 条目；清不掉的 key 保留归属，装不下则拒绝写入。
            const boundedResult = await boundCustomKeys(manager, customKeys);
            if (!boundedResult.ok) {
                return {
                    envelope: false,
                    custom: false,
                    conflict: false,
                    warn: boundedResult.warn,
                };
            }
            const bounded = boundedResult.keys;
            const serialized = serializeBindingRecord({
                loginCredential: current.loginCredential,
                key,
                username,
                customKeys: bounded,
            });
            if (!serialized) return { envelope: false, custom: false, conflict: false };
            await manager.writeSecret(BINDING_NAMESPACE, serialized, SECRET_LABEL);

            let custom = true;
            let active = null;
            let activeReadable = true;
            try {
                active = await manager.readSecret(CUSTOM_SOURCE_NAMESPACE);
            } catch {
                activeReadable = false;
                custom = false;
                // I6：读失败时活动值归属未知（可能仍是插件旧 key）。信封已
                // 刷新为新 key，记录待修复；/status 探活在读取恢复后按归属
                // 同步（retryCustomSync）。
                customSyncPending.set(directories.root, true);
            }
            // 只在 Custom 活动值是插件自有 key 时同步；用户自取值不动。
            const customOwned = activeReadable && typeof active === 'string' && active.length > 0
                && (current.customKeys.includes(active) || active === current.key);
            if (customOwned) {
                if (active !== key) {
                    try {
                        const id = await manager.writeSecret(
                            CUSTOM_SOURCE_NAMESPACE, key, CUSTOM_SOURCE_LABEL,
                        );
                        if (id !== undefined && id !== null) {
                            customSourceWriteIds.set(directories.root, id);
                        } else {
                            customSourceWriteIds.delete(directories.root);
                        }
                        // H3：同步成功，待修复标记清除。
                        customSyncPending.delete(directories.root);
                    } catch {
                        custom = false;
                        // H3：信封已刷新但 Custom 仍是旧插件值；记录待修复，
                        // 后续 /status 探活重试（不因此推翻信封刷新）。
                        customSyncPending.set(directories.root, true);
                    }
                } else {
                    // 活动值已是新 key：无需同步。
                    customSyncPending.delete(directories.root);
                }
            } else if (activeReadable) {
                // 用户自有值 / 空值：不再有待同步的插件值。
                customSyncPending.delete(directories.root);
            }
            return boundedResult.warn
                ? { envelope: true, custom, conflict: false, warn: boundedResult.warn }
                : { envelope: true, custom, conflict: false };
        } catch {
            return { envelope: false, custom: false, conflict: false };
        }
    }

    // B3 模型接入确认：写 ST Custom 源读取的 api_key_custom，并把该 key 记入
    // 信封 custom_keys——注销/失效清理据此识别插件自有条目。
    //
    // G1 写入顺序与回滚：
    //   1. 重新读取当前信封，**以信封里的 key 为准**；调用方传入的 key 与它
    //      不一致（慢请求落在 key 刷新之后）→ conflict（409），不写任何东西。
    //   2. 先写归属：信封 custom_keys 先加入该 key（必要时先清理淘汰项）。
    //   3. 再写 Custom 值；若 Custom 写失败 → best-effort 把信封 custom_keys
    //      回滚到本次调用前的列表（本次写入前就已列出的，保留原归属）。
    // 返回 {ok, conflict, customWritten, envelopeWritten}：
    //   - ok:false + customWritten:false + envelopeWritten:false → 可回滚的
    //     完全未写；
    //   - ok:false + envelopeWritten:true → 归属已写/未能回滚，结果不确定
    //     （core 映射 502 custom_source_write_partial）。
    // - expectedLoginCredential 与当前信封不符 → conflict（F3）。
    // - key 已在 custom_keys 且 Custom 活动值就是它 → 幂等成功，不再调
    //   writeSecret（ST 同值重复 append 会累积历史条目）。
    // - 信封缺失/不可解析 → 失败（无归属记录，不写 Custom）。
    async function writeCustomSourceKey(directories, key, options) {
        const expected = options && typeof options.expectedLoginCredential === 'string'
            ? options.expectedLoginCredential
            : null;
        let envelopeWritten = false;
        let customWritten = false;
        if (!isValidBindingKey(key)) {
            return { ok: false, conflict: false, customWritten, envelopeWritten };
        }
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) {
            return { ok: false, conflict: false, customWritten, envelopeWritten };
        }
        try {
            const manager = new Manager(directories);
            if (typeof manager.readSecret !== 'function'
                || typeof manager.writeSecret !== 'function') {
                return { ok: false, conflict: false, customWritten, envelopeWritten };
            }
            const raw = await manager.readSecret(BINDING_NAMESPACE);
            const current = parseBindingRecord(raw);
            if (!current) {
                return { ok: false, conflict: false, customWritten, envelopeWritten };
            }
            if (expected !== null && current.loginCredential !== expected) {
                return { ok: false, conflict: true, customWritten, envelopeWritten };
            }
            // G1：当前信封 key 才是要写入 Custom 的值；调用方 key 只做一致性
            // 核对。账号切换/刷新后慢请求的参数 key 不得落进新登录。
            const bindingKey = current.key;
            if (key !== bindingKey) {
                return { ok: false, conflict: true, customWritten, envelopeWritten };
            }
            let active = null;
            try {
                active = await manager.readSecret(CUSTOM_SOURCE_NAMESPACE);
            } catch {
                return { ok: false, conflict: false, customWritten, envelopeWritten };
            }
            const alreadyListed = current.customKeys.includes(bindingKey);
            const originalCustomKeys = current.customKeys.slice();
            // 第一步：写归属（custom_keys），再写 Custom 值。
            if (!alreadyListed) {
                const desired = originalCustomKeys.concat(bindingKey);
                const bounded = await boundCustomKeys(manager, desired);
                if (!bounded.ok) {
                    return {
                        ok: false,
                        conflict: false,
                        customWritten: false,
                        envelopeWritten: false,
                        reason: bounded.warn,
                        warn: bounded.warn,
                    };
                }
                const serialized = serializeBindingRecord({
                    loginCredential: current.loginCredential,
                    key: bindingKey,
                    username: current.username,
                    customKeys: bounded.keys,
                });
                if (!serialized) {
                    return { ok: false, conflict: false, customWritten, envelopeWritten };
                }
                await manager.writeSecret(BINDING_NAMESPACE, serialized, SECRET_LABEL);
                envelopeWritten = true;
            } else {
                // 归属此前已记录（本次没有新增信封写入），但仍是“已归属”。
                envelopeWritten = true;
            }
            // 第二步：写 Custom 值。
            if (active !== bindingKey) {
                try {
                    const id = await manager.writeSecret(
                        CUSTOM_SOURCE_NAMESPACE, bindingKey, CUSTOM_SOURCE_LABEL,
                    );
                    if (id !== undefined && id !== null) {
                        customSourceWriteIds.set(directories.root, id);
                    } else {
                        customSourceWriteIds.delete(directories.root);
                    }
                    customWritten = true;
                    // H3：Custom 已指向当前信封 key，没有待修复项。
                    customSyncPending.delete(directories.root);
                } catch {
                    // H3：Custom 活动值仍是插件旧 key 时记录待修复（下一次
                    // /status 探活重试）；用户自有值失败不设待修复标记。
                    if (typeof active === 'string' && active.length > 0
                        && (current.customKeys.includes(active) || active === current.key)) {
                        customSyncPending.set(directories.root, true);
                    }
                    // Custom 写失败：best-effort 回滚本次新增的归属记录。
                    let rolledBack = alreadyListed;
                    if (!alreadyListed) {
                        let rollbackSerialized = null;
                        try {
                            rollbackSerialized = serializeBindingRecord({
                                loginCredential: current.loginCredential,
                                key: bindingKey,
                                username: current.username,
                                customKeys: originalCustomKeys,
                            });
                        } catch {
                            rollbackSerialized = null;
                        }
                        if (rollbackSerialized) {
                            try {
                                await manager.writeSecret(
                                    BINDING_NAMESPACE, rollbackSerialized, SECRET_LABEL,
                                );
                                rolledBack = true;
                            } catch {
                                rolledBack = false;
                            }
                        } else {
                            rolledBack = false;
                        }
                    }
                    return {
                        ok: false,
                        conflict: false,
                        customWritten: false,
                        // 回滚成功 → 归属回到调用前状态（可回滚的失败）；
                        // 回滚失败或归属此前已存在 → 结果不确定（partial）。
                        envelopeWritten: rolledBack ? false : true,
                        reason: 'custom_source_write_failed',
                    };
                }
            } else {
                customWritten = true;
                customSyncPending.delete(directories.root);
            }
            return { ok: true, conflict: false, customWritten, envelopeWritten };
        } catch {
            // 异常可能发生在信封写入之后：按当前已观察到的写入状态如实返回
            // （未知即可能 partial），绝不谎报完全未写。
            return { ok: false, conflict: false, customWritten, envelopeWritten };
        }
    }

    // W10：无信封时判断 Custom 命名空间是否仍有条目。返回 {known,present}；
    // known=false（读失败/管理器不可用）时调用方不得声称已清。
    async function hasCustomSourceEntries(directories) {
        const Manager = await loadSecretManager();
        if (!Manager || !validDirectories(directories)) {
            return { known: false, present: false };
        }
        try {
            const manager = new Manager(directories);
            if (typeof manager.getAllSecrets !== 'function') {
                return { known: false, present: false };
            }
            const secrets = manager.getAllSecrets();
            if (!secrets || typeof secrets !== 'object') {
                return { known: false, present: false };
            }
            const entries = secrets[CUSTOM_SOURCE_NAMESPACE];
            if (entries === undefined || entries === null) return { known: true, present: false };
            if (Array.isArray(entries)) return { known: true, present: entries.length > 0 };
            if (typeof entries === 'string') return { known: true, present: entries.length > 0 };
            return { known: false, present: false };
        } catch {
            return { known: false, present: false };
        }
    }

    // 单独停用 Custom 源（logout / 查询面 401 用 clearBinding；本方法留给
    // 需要按 key 归属清理的路径）。必须传插件写入的 key；不整命名空间清空。
    async function clearCustomSourceKeyPublic(directories, key) {
        return clearCustomSourceKey(directories, key);
    }

    // H3/W3：Custom 同步自愈。refreshKey 只在“信封已刷新、Custom 活动值仍是
    // 插件旧 key、同步写新 key 失败”时置 pending；但该标记是内存态，ST 重启
    // 后丢失。因此本方法不依赖标记：每次 /status 探活都按归属核对一次——
    // - 信封不可用/已无 Custom 值/用户改回自值/活动值已是信封 key → 无需修复；
    // - 活动值属于插件自有（custom_keys ∪ 当前 key）且不等于信封 key →
    //   重试写信封 key（重启后也能发现刷新中断留下的旧值）。
    // 不猜归属、不动用户自有值。返回 {pending, synced}（诊断/测试用）。
    async function retryCustomSync(directories) {
        if (!validDirectories(directories)) return { pending: false, synced: false };
        const root = directories.root;
        const Manager = await loadSecretManager();
        if (!Manager) return { pending: true, synced: false };
        try {
            const manager = new Manager(directories);
            if (typeof manager.readSecret !== 'function'
                || typeof manager.writeSecret !== 'function') {
                return { pending: true, synced: false };
            }
            const record = parseBindingRecord(await manager.readSecret(BINDING_NAMESPACE));
            if (!record) {
                // 信封已清/损坏：没有可同步的目标，待修复标记失效。
                customSyncPending.delete(root);
                return { pending: false, synced: false };
            }
            const active = await manager.readSecret(CUSTOM_SOURCE_NAMESPACE);
            if (typeof active !== 'string' || active.length === 0) {
                customSyncPending.delete(root);
                return { pending: false, synced: false };
            }
            const pluginOwned = record.customKeys.includes(active) || active === record.key;
            if (!pluginOwned) {
                // 用户改回自有值：不再有插件待同步项。
                customSyncPending.delete(root);
                return { pending: false, synced: false };
            }
            if (active === record.key) {
                customSyncPending.delete(root);
                return { pending: false, synced: true };
            }
            const id = await manager.writeSecret(
                CUSTOM_SOURCE_NAMESPACE, record.key, CUSTOM_SOURCE_LABEL,
            );
            if (id !== undefined && id !== null) {
                customSourceWriteIds.set(root, id);
            } else {
                customSourceWriteIds.delete(root);
            }
            customSyncPending.delete(root);
            return { pending: false, synced: true };
        } catch {
            return { pending: true, synced: false };
        }
    }

    return {
        readBinding,
        readBindingState,
        writeBinding,
        clearBinding,
        refreshKey,
        writeCustomSourceKey,
        clearCustomSourceKey: clearCustomSourceKeyPublic,
        hasCustomSourceEntries,
        retryCustomSync,
    };
}

module.exports = { createSecretBindingAdapter };
