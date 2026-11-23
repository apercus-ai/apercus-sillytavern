'use strict';

// ST 密钥库适配器（v3/F2）：信封写入、custom_keys 归属、getAllSecrets 全量清理
// （含 inactive 条目）、refreshKey 的 Custom 联动、fail-closed（导入/读写异常
// 绝不抛到路由层）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecretBindingAdapter } = require('../server/secrets-binding.js');

const DIRS = { root: '/u/alice' };
const RECORD = {
    loginCredential: 'cred_abc123',
    key: 'agw_key_abc',
    username: 'alice',
};

// 简化 ST 1.17.0 SecretManager：
// - 值是普通字符串时（旧形态）write 覆盖、read 返回字符串、delete 删除；
// - 值是条目数组时模拟真实行为：write 追加新条目并停用旧条目，read 返回
//   active 值，delete(name,id) 删指定 id（缺 id 时删 active），删空后删命名
//   空间，无 active 时重新激活第一条（secrets.js:203-247、373）。
// - getAllSecrets() 返回全部明文条目（含 inactive），供 F2 全量归属清理。
function makeManager(store, options) {
    const config = options || {};
    const events = { writes: [], deletes: [], deleteIds: [], writeIds: [], nextId: 1 };
    class Manager {
        constructor(directories) {
            this.directories = directories;
            events.instances = (events.instances || 0) + 1;
        }
        async readSecret(name) {
            if (config.readError) throw new Error('read failed');
            const current = store[name];
            if (Array.isArray(current)) {
                const active = current.find((entry) => entry.active);
                return active ? active.value : '';
            }
            return Object.hasOwn(store, name) ? store[name] : null;
        }
        async writeSecret(name, value, label) {
            events.writes.push({ name, value, label });
            if (typeof config.writeError === 'function' && config.writeError(name, value)) {
                throw new Error('write failed');
            }
            const id = events.nextId;
            events.nextId += 1;
            events.writeIds.push(id);
            if (Array.isArray(store[name])) {
                for (const entry of store[name]) entry.active = false;
                store[name].push({ id, value, label, active: true });
            } else {
                store[name] = value;
            }
            return id;
        }
        deleteSecret(name, id) {
            events.deletes.push(name);
            events.deleteIds.push(id);
            if (typeof config.deleteError === 'function' && config.deleteError(name, id)) {
                throw new Error('delete failed');
            }
            if (Array.isArray(store[name])) {
                const list = store[name];
                const index = id === undefined
                    ? list.findIndex((entry) => entry.active)
                    : list.findIndex((entry) => entry.id === id);
                if (index !== -1) list.splice(index, 1);
                if (list.length > 0 && !list.some((entry) => entry.active)) list[0].active = true;
                if (list.length === 0) delete store[name];
                return;
            }
            if (id === undefined || id === 'legacy') delete store[name];
        }
        getAllSecrets() {
            if (config.getAllError) throw new Error('getAllSecrets failed');
            const snapshot = {};
            for (const [name, value] of Object.entries(store)) {
                if (Array.isArray(value)) {
                    snapshot[name] = value.map((entry) => ({ ...entry }));
                } else {
                    snapshot[name] = [{ id: 'legacy', value, label: 'legacy', active: true }];
                }
            }
            return snapshot;
        }
    }
    return { Manager, events };
}

function makeAdapter(manager) {
    return createSecretBindingAdapter({
        stRoot: 'irrelevant',
        secretManagerLoader: async () => manager,
    });
}

function envelope(key, username = 'alice', credential = 'cred', customKeys) {
    const payload = {
        version: 1,
        login_credential: credential,
        key,
        username,
    };
    if (customKeys !== undefined) payload.custom_keys = customKeys;
    return JSON.stringify(payload);
}

function customList(...entries) {
    return entries.map((item) => ({
        id: item.id,
        value: item.value,
        label: item.label || 'custom',
        active: item.active === true,
    }));
}

test('readBinding parses the enveloped record (old records default customKeys to [])', async () => {
    const store = {
        apercus_gateway: envelope('key'),
    };
    const { Manager } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const record = await adapter.readBinding(DIRS);
    assert.deepEqual(record, {
        loginCredential: 'cred',
        key: 'key',
        username: 'alice',
        customKeys: [],
    });

    store.apercus_gateway = envelope('key2', 'alice', 'cred', ['old-a', 'old-b']);
    const withCustom = await adapter.readBinding(DIRS);
    assert.deepEqual(withCustom.customKeys, ['old-a', 'old-b']);

    store.apercus_gateway = '{bad';
    assert.equal(await adapter.readBinding(DIRS), null);

    // custom_keys 形态非法 → 整条记录不可用（坏归属列表不当作清理依据）。
    for (const bad of [
        'not-an-array',
        ['ok', 'a\nb'],
        [42],
        ['dup', 'dup'],
        Array.from({ length: 9 }, (_, index) => `k${index}`),
    ]) {
        store.apercus_gateway = JSON.stringify({
            version: 1,
            login_credential: 'cred',
            key: 'key',
            username: 'alice',
            custom_keys: bad,
        });
        assert.equal(await adapter.readBinding(DIRS), null, JSON.stringify(bad));
    }

    const failing = makeAdapter(makeManager(store, { readError: true }).Manager);
    assert.equal(await failing.readBinding(DIRS), null);

    assert.equal(await adapter.readBinding({ root: '' }), null);
    assert.equal(await adapter.readBinding(null), null);

    const missingClass = createSecretBindingAdapter({
        stRoot: 'x',
        secretManagerLoader: async () => null,
    });
    assert.equal(await missingClass.readBinding(DIRS), null);
});

test('I4: writeBinding writes only the new envelope and clears old plugin Custom entries', async () => {
    const store = {};
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const ok = await adapter.writeBinding(DIRS, RECORD);
    assert.equal(ok, true);
    // 无历史归属：保持旧信封形状（不写空 custom_keys）。
    assert.equal(store.apercus_gateway, JSON.stringify({
        version: 1,
        login_credential: 'cred_abc123',
        key: 'agw_key_abc',
        username: 'alice',
    }));
    assert.equal(store.api_key_custom, undefined);
    assert.deepEqual(events.writes.map((item) => item.name), ['apercus_gateway']);

    // A 账号写入过 Custom key；B approved 覆盖信封前必须先清掉 A 的插件值，
    // 且新信封不继承旧 custom_keys（否则 ST 生成会继续用 A 的 key）。
    store.apercus_gateway = envelope('key-a', 'alice', 'cred-a', ['key-a']);
    store.api_key_custom = customList(
        { id: 1, value: 'user-own-key', active: false },
        { id: 2, value: 'key-a', active: true },
    );
    const second = await adapter.writeBinding(DIRS, {
        loginCredential: 'cred-b',
        key: 'key-b',
        username: 'alice',
    });
    assert.equal(second, true);
    const parsed = JSON.parse(store.apercus_gateway);
    assert.equal(parsed.login_credential, 'cred-b');
    assert.equal(parsed.key, 'key-b');
    assert.equal(Object.hasOwn(parsed, 'custom_keys'), false);
    // A 的 Custom 条目（active 与 inactive 都按 id 删除）；用户自有值保留。
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key']);
    assert.deepEqual(
        events.deleteIds.filter((id) => id === 2),
        [2],
    );

    // J5：同账号同 key 重连（approved 重放/重复登录）不得清掉正在使用的
    // Custom key：保留旧 custom_keys 与 Custom 条目，仅重写信封（credential
    // 可更新）。否则重连后 ST Custom 源会立刻失去可用 key。
    store.apercus_gateway = envelope('key-same', 'alice', 'cred-old', ['key-same']);
    store.api_key_custom = customList(
        { id: 7, value: 'user-own-key', active: true },
        { id: 8, value: 'key-same', active: false },
    );
    const deletesBeforeSame = events.deleteIds.length;
    const sameKey = await adapter.writeBinding(DIRS, {
        loginCredential: 'cred-new',
        key: 'key-same',
        username: 'alice',
    });
    assert.equal(sameKey, true);
    // Custom 条目一条都不删（inactive 的插件 key 也保留供注销清理）。
    assert.deepEqual(events.deleteIds.slice(deletesBeforeSame), []);
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key', 'key-same']);
    const sameParsed = JSON.parse(store.apercus_gateway);
    assert.equal(sameParsed.login_credential, 'cred-new');
    assert.equal(sameParsed.key, 'key-same');
    assert.equal(sameParsed.username, 'alice');
    assert.deepEqual(sameParsed.custom_keys, ['key-same']);

    // 同 key 但 username 不同（账号切换）仍按 I4 清理旧归属。
    store.apercus_gateway = envelope('key-same', 'alice', 'cred-old', ['key-same']);
    store.api_key_custom = customList(
        { id: 9, value: 'user-own-key', active: true },
        { id: 10, value: 'key-same', active: false },
    );
    const switched = await adapter.writeBinding(DIRS, {
        loginCredential: 'cred-bob',
        key: 'key-same',
        username: 'bob',
    });
    assert.equal(switched, true);
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key']);
    assert.ok(events.deleteIds.includes(10));
});

test('I4: writeBinding fails closed when old envelope/custom ownership is unreadable or unclearable', async () => {
    // 旧信封损坏：归属未知，不覆盖信封。
    const corrupted = { apercus_gateway: '{bad' };
    const corruptedAdapter = makeAdapter(makeManager(corrupted).Manager);
    assert.equal(await corruptedAdapter.writeBinding(DIRS, {
        loginCredential: 'cred-b', key: 'key-b', username: 'alice',
    }), false);
    assert.equal(corrupted.apercus_gateway, '{bad');

    // 旧信封读失败：同样不覆盖（否则旧 Custom key 会失去归属依据）。
    const readFailStore = {
        apercus_gateway: envelope('key-a', 'alice', 'cred-a', ['key-a']),
    };
    const readFailAdapter = makeAdapter(makeManager(readFailStore, { readError: true }).Manager);
    assert.equal(await readFailAdapter.writeBinding(DIRS, {
        loginCredential: 'cred-b', key: 'key-b', username: 'alice',
    }), false);
    assert.equal(JSON.parse(readFailStore.apercus_gateway).key, 'key-a');

    // 旧 Custom 条目删不掉：不写新信封（旧归属原样保留供重试）。
    const store = {
        apercus_gateway: envelope('key-a', 'alice', 'cred-a', ['key-a']),
        api_key_custom: customList({ id: 1, value: 'key-a', active: true }),
    };
    const failingAdapter = makeAdapter(makeManager(store, {
        deleteError: (name) => name === 'api_key_custom',
    }).Manager);
    assert.equal(await failingAdapter.writeBinding(DIRS, {
        loginCredential: 'cred-b', key: 'key-b', username: 'alice',
    }), false);
    assert.equal(JSON.parse(store.apercus_gateway).key, 'key-a');
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'key-a');
});

test('writeBinding fails closed on bad records, bad directories, and write failure', async () => {
    const store = {};
    const { Manager } = makeManager(store);
    const adapter = makeAdapter(Manager);
    assert.equal(await adapter.writeBinding(DIRS, { ...RECORD, key: 'a\nb' }), false);
    assert.equal(await adapter.writeBinding(DIRS, { ...RECORD, customKeys: ['a\nb'] }), false);
    assert.equal(await adapter.writeBinding({ root: '' }, RECORD), false);

    const failing = makeAdapter(makeManager(store, {
        writeError: (name) => name === 'apercus_gateway',
    }).Manager);
    assert.equal(await failing.writeBinding(DIRS, RECORD), false);
    assert.equal(store.apercus_gateway, undefined);
    assert.equal(store.api_key_custom, undefined);
});

test('writeCustomSourceKey writes Custom, records ownership, and is idempotent for the same key', async () => {
    const store = {
        apercus_gateway: envelope('plugin-key', 'alice', 'cred'),
        api_key_custom: customList({ id: 1, value: 'user-own-key', active: true }),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);

    const first = await adapter.writeCustomSourceKey(DIRS, 'plugin-key', { expectedLoginCredential: 'cred' });
    assert.deepEqual(first, { ok: true, conflict: false, customWritten: true, envelopeWritten: true });
    const parsed = JSON.parse(store.apercus_gateway);
    assert.deepEqual(parsed.custom_keys, ['plugin-key']);
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'plugin-key');
    assert.equal(events.writes.filter((item) => item.name === 'api_key_custom').length, 1);
    // G1 顺序：先写归属信封，再写 Custom 值。
    assert.deepEqual(events.writes.map((item) => item.name), ['apercus_gateway', 'api_key_custom']);

    // 同一 key 再次确认：Custom active 已是它、信封已记录 → 不重复 append。
    const again = await adapter.writeCustomSourceKey(DIRS, 'plugin-key', { expectedLoginCredential: 'cred' });
    assert.deepEqual(again, { ok: true, conflict: false, customWritten: true, envelopeWritten: true });
    assert.equal(events.writes.filter((item) => item.name === 'api_key_custom').length, 1);
    assert.equal(store.api_key_custom.length, 2);

    // 账号已切换（expected credential 不符）→ 冲突，不写 Custom/信封。
    const conflict = await adapter.writeCustomSourceKey(DIRS, 'other-key', { expectedLoginCredential: 'old-cred' });
    assert.deepEqual(conflict, {
        ok: false, conflict: true, customWritten: false, envelopeWritten: false,
    });
    const writesBefore = events.writes.length;
    // 调用方 key 与重新读取的信封 key 不一致（慢请求落在 key 刷新后）→ 冲突。
    const staleKey = await adapter.writeCustomSourceKey(DIRS, 'other-key', { expectedLoginCredential: 'cred' });
    assert.deepEqual(staleKey, {
        ok: false, conflict: true, customWritten: false, envelopeWritten: false,
    });
    store.apercus_gateway = envelope('plugin-key', 'alice', 'cred_new');
    const stale = await adapter.writeCustomSourceKey(DIRS, 'other-key', { expectedLoginCredential: 'cred' });
    assert.deepEqual(stale, {
        ok: false, conflict: true, customWritten: false, envelopeWritten: false,
    });
    assert.equal(events.writes.length, writesBefore);

    // 非法 key / 非法目录 / 无信封（无法记录归属）/ 写入异常都 fail-closed。
    const unwritten = { ok: false, conflict: false, customWritten: false, envelopeWritten: false };
    assert.deepEqual(await adapter.writeCustomSourceKey(DIRS, 'a\nb'), unwritten);
    assert.deepEqual(await adapter.writeCustomSourceKey({ root: '' }, 'k'), unwritten);
    store.apercus_gateway = '{bad';
    assert.deepEqual(await adapter.writeCustomSourceKey(DIRS, 'k'), unwritten);
    // Custom 写失败、信封回滚成功 → 完全未写（可回滚的失败）。
    const failing = makeAdapter(makeManager(store, {
        writeError: (name) => name === 'api_key_custom',
    }).Manager);
    store.apercus_gateway = envelope('plugin-key', 'alice', 'cred');
    store.api_key_custom = customList({ id: 99, value: 'user-key', active: true });
    assert.deepEqual(await failing.writeCustomSourceKey(DIRS, 'plugin-key', {
        expectedLoginCredential: 'cred',
    }), {
        ok: false,
        conflict: false,
        customWritten: false,
        envelopeWritten: false,
        reason: 'custom_source_write_failed',
    });
    assert.deepEqual(JSON.parse(store.apercus_gateway).custom_keys, undefined);
});

test('clearCustomSourceKey enumerates all entries (including inactive) and keeps user values', async () => {
    // 用户自有 + 插件同一 key 的三条历史（ST 每次 write 追加并停用旧条目）。
    const store = {
        api_key_custom: customList(
            { id: 1, value: 'user-own-key', active: false },
            { id: 2, value: 'plugin-key', active: true },
            { id: 3, value: 'plugin-key', active: false },
            { id: 4, value: 'user-own-key', active: false },
        ),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    assert.deepEqual(await adapter.clearCustomSourceKey(DIRS, ['plugin-key']), { ok: true, cleared: true });
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key', 'user-own-key']);
    assert.deepEqual(events.deleteIds, [2, 3]);
    // ST 重新激活第一条（用户自有值），插件值不再生效且不再残留。
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'user-own-key');

    // 多 key 归属（自定义 custom_keys ∪ 当前 key）+ inactive 条目一并删除。
    const multi = {
        api_key_custom: customList(
            { id: 10, value: 'key-a', active: true },
            { id: 11, value: 'key-b', active: false },
            { id: 12, value: 'user-key', active: false },
        ),
    };
    const multiAdapter = makeAdapter(makeManager(multi).Manager);
    assert.deepEqual(await multiAdapter.clearCustomSourceKey(DIRS, ['key-a', 'key-b']), { ok: true, cleared: true });
    assert.deepEqual(multi.api_key_custom.map((entry) => entry.value), ['user-key']);

    // 同名 key 40 条历史没有固定上限（只有值归属决定删哪些）。
    const many = {
        api_key_custom: Array.from({ length: 40 }, (_, index) => ({
            id: index + 1,
            value: 'plugin-key',
            label: 'custom',
            active: index === 39,
        })),
    };
    const manyAdapter = makeAdapter(makeManager(many).Manager);
    assert.deepEqual(await manyAdapter.clearCustomSourceKey(DIRS, ['plugin-key']), { ok: true, cleared: true });
    assert.equal(Object.hasOwn(many, 'api_key_custom'), false);

    // 空列表 = 无需清理；非法形态/目录 → ok:false。
    const invalid = { ok: false, cleared: false };
    assert.deepEqual(await adapter.clearCustomSourceKey(DIRS, []), { ok: true, cleared: true });
    assert.deepEqual(await adapter.clearCustomSourceKey(DIRS, ['a\nb']), invalid);
    assert.deepEqual(await adapter.clearCustomSourceKey({ root: '' }, ['k']), invalid);
    assert.deepEqual(
        await adapter.clearCustomSourceKey(DIRS, Array.from({ length: 10 }, (_, i) => `k${i}`)),
        invalid,
    );
});

test('clearCustomSourceKey fails closed when deletion or enumeration throws', async () => {
    const store = { api_key_custom: customList({ id: 1, value: 'plugin-key', active: true }) };
    const { Manager } = makeManager(store, {
        deleteError: (name) => name === 'api_key_custom',
    });
    const adapter = makeAdapter(Manager);
    assert.deepEqual(await adapter.clearCustomSourceKey(DIRS, ['plugin-key']), { ok: false, cleared: false });
    assert.equal(store.api_key_custom.length, 1);

    const noEnumeration = createSecretBindingAdapter({
        stRoot: 'x',
        secretManagerLoader: async () => {
            class Manager2 {
                async readSecret() { return 'plugin-key'; }
                async deleteSecret() {}
            }
            return Manager2;
        },
    });
    assert.deepEqual(
        await noEnumeration.clearCustomSourceKey(DIRS, ['plugin-key']),
        { ok: false, cleared: false },
    );
});

test('clearBinding cleans Custom first and keeps the envelope when Custom cleanup fails', async () => {
    const store = {
        apercus_gateway: envelope('old-key', 'alice', 'cred', ['old-key', 'old-other']),
        api_key_custom: customList(
            { id: 1, value: 'old-key', active: true },
            { id: 2, value: 'old-other', active: false },
            { id: 3, value: 'user-own-key', active: false },
        ),
    };
    const { Manager, events } = makeManager(store, {
        deleteError: (name) => name === 'api_key_custom',
    });
    const adapter = makeAdapter(Manager);
    const result = await adapter.clearBinding(DIRS);
    assert.deepEqual(result, { envelope: false, custom: false });
    // custom 失败：信封仍在（供下次重试识别归属），没有先删信封。
    assert.equal(store.apercus_gateway, envelope('old-key', 'alice', 'cred', ['old-key', 'old-other']));
    assert.equal(store.api_key_custom.length, 3);
    assert.equal(events.deletes.includes('apercus_gateway'), false);

    const okStore = {
        apercus_gateway: envelope('old-key', 'alice', 'cred', ['old-key', 'old-other']),
        api_key_custom: customList(
            { id: 1, value: 'old-key', active: true },
            { id: 2, value: 'old-other', active: false },
            { id: 3, value: 'user-own-key', active: false },
        ),
    };
    const okAdapter = makeAdapter(makeManager(okStore).Manager);
    assert.deepEqual(await okAdapter.clearBinding(DIRS), { envelope: true, custom: true });
    assert.equal(Object.hasOwn(okStore, 'apercus_gateway'), false);
    assert.deepEqual(okStore.api_key_custom.map((entry) => entry.value), ['user-own-key']);
});

test('W10: an absent envelope with remaining Custom entries is reported uncertain', async () => {
    const store = {
        api_key_custom: customList({ id: 1, value: 'user-or-stale-key', active: true }),
    };
    const { Manager } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const result = await adapter.clearBinding(DIRS);
    assert.deepEqual(result, { envelope: true, custom: true, customUncertain: true });
    // 无信封就没有归属依据；不删除用户/未知 Custom 条目。
    assert.equal(store.api_key_custom.length, 1);
});

test('H6: clearBinding refuses a corrupt/unreadable envelope without deleting or claiming success', async () => {
    const store = {
        apercus_gateway: '{bad',
        api_key_custom: customList({ id: 1, value: 'user-own-key', active: true }),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    // 归属未知：不删信封、不触碰 Custom，也不报成功（logout → 502）。
    assert.deepEqual(await adapter.clearBinding(DIRS), { envelope: false, custom: false });
    assert.equal(store.apercus_gateway, '{bad');
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key']);
    assert.equal(events.deletes.includes('apercus_gateway'), false);
    assert.equal(events.deleteIds.filter((id) => id === 1).length, 0);

    // 读取抛错（error）同样是 fail-closed：不删、不报成功。
    const readStore = {
        apercus_gateway: envelope('plugin-key'),
        api_key_custom: customList({ id: 2, value: 'plugin-key', active: true }),
    };
    const failing = makeAdapter(makeManager(readStore, { readError: true }).Manager);
    assert.deepEqual(await failing.clearBinding(DIRS), { envelope: false, custom: false });
    assert.equal(readStore.apercus_gateway, envelope('plugin-key'));
    assert.deepEqual(readStore.api_key_custom.map((entry) => entry.value), ['plugin-key']);

    // 信封无插件 key 时 Custom 完全不动。
    const userStore = {
        apercus_gateway: envelope('plugin-key'),
        api_key_custom: customList({ id: 3, value: 'user-own-key', active: true }),
    };
    const userAdapter = makeAdapter(makeManager(userStore).Manager);
    assert.deepEqual(await userAdapter.clearBinding(DIRS), { envelope: true, custom: true });
    assert.deepEqual(userStore.api_key_custom.map((entry) => entry.value), ['user-own-key']);
});

test('I4 multi-account: B approval clears A Custom key before the envelope switch; logout keeps user key', async () => {
    const store = {
        apercus_gateway: envelope('key-a', 'alice', 'cred-a'),
        api_key_custom: customList(
            { id: 1, value: 'user-own-key', active: false },
            { id: 2, value: 'key-a', active: true },
        ),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);

    // A 接入：apply-model 把 key-a 追加到 Custom 并记入信封 custom_keys。
    assert.deepEqual(await adapter.writeCustomSourceKey(DIRS, 'key-a', { expectedLoginCredential: 'cred-a' }),
        { ok: true, conflict: false, customWritten: true, envelopeWritten: true });
    assert.deepEqual(JSON.parse(store.apercus_gateway).custom_keys, ['key-a']);

    // B approved 覆盖信封：先清掉 A 的 Custom 条目，新信封不带旧 custom_keys。
    // ST 不再可能用 A 的 key 生成记费。
    await adapter.writeBinding(DIRS, { loginCredential: 'cred-b', key: 'key-b', username: 'alice' });
    const afterB = JSON.parse(store.apercus_gateway);
    assert.equal(afterB.login_credential, 'cred-b');
    assert.equal(afterB.key, 'key-b');
    assert.equal(Object.hasOwn(afterB, 'custom_keys'), false);
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key']);
    assert.equal(events.deleteIds.filter((id) => id === 2).length, 1);

    // B 重新 apply 后 Custom 指向 key-b，归属只含 B 的 key。
    assert.deepEqual(await adapter.writeCustomSourceKey(DIRS, 'key-b', { expectedLoginCredential: 'cred-b' }),
        { ok: true, conflict: false, customWritten: true, envelopeWritten: true });
    assert.deepEqual(JSON.parse(store.apercus_gateway).custom_keys, ['key-b']);
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'key-b');

    // logout：清掉 B 的插件值；用户自有值保留。
    assert.deepEqual(await adapter.clearBinding(DIRS), { envelope: true, custom: true });
    assert.equal(Object.hasOwn(store, 'apercus_gateway'), false);
    assert.deepEqual(store.api_key_custom.map((entry) => entry.value), ['user-own-key']);
});

test('refreshKey updates envelope/custom_keys and syncs a plugin-owned Custom key (F2)', async () => {
    const store = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 1, value: 'old-key', active: true }),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const result = await adapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    });
    assert.deepEqual(result, { envelope: true, custom: true, conflict: false });
    const parsed = JSON.parse(store.apercus_gateway);
    assert.equal(parsed.login_credential, 'cred_keep');
    assert.equal(parsed.key, 'new-key');
    assert.equal(parsed.username, 'alice');
    // 旧 key 留在 custom_keys（ST 里会作为 inactive 条目继续存在）。
    assert.deepEqual(parsed.custom_keys, ['old-key', 'new-key']);
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'new-key');
    assert.deepEqual(events.writes.map((item) => item.name), ['apercus_gateway', 'api_key_custom']);
});

test('refreshKey never overwrites a user-owned Custom key, and keeps the envelope on custom failure', async () => {
    const store = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 1, value: 'user-own-key', active: true }),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const result = await adapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    });
    assert.deepEqual(result, { envelope: true, custom: true, conflict: false });
    assert.equal(JSON.parse(store.apercus_gateway).key, 'new-key');
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'user-own-key');
    assert.deepEqual(events.writes.map((item) => item.name), ['apercus_gateway']);

    // Custom 写失败：信封刷新保留（best-effort custom:false）。
    const failStore = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 1, value: 'old-key', active: true }),
    };
    const failAdapter = makeAdapter(makeManager(failStore, {
        writeError: (name) => name === 'api_key_custom',
    }).Manager);
    const failed = await failAdapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    });
    assert.deepEqual(failed, { envelope: true, custom: false, conflict: false });
    assert.equal(JSON.parse(failStore.apercus_gateway).key, 'new-key');
    assert.equal(failStore.api_key_custom.find((entry) => entry.active).value, 'old-key');
});

test('H3: new envelope + old Custom self-heals through the /status probe retry', async () => {
    const store = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 1, value: 'old-key', active: true }),
    };
    let failCustom = true;
    const { Manager, events } = makeManager(store, {
        writeError: (name) => name === 'api_key_custom' && failCustom,
    });
    const adapter = makeAdapter(Manager);
    // 信封刷新成功、Custom 仍指向旧插件 key：custom:false 且记录待修复。
    const refreshed = await adapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    });
    assert.deepEqual(refreshed, { envelope: true, custom: false, conflict: false });
    assert.equal(JSON.parse(store.apercus_gateway).key, 'new-key');
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'old-key');

    // 下一次 /status 探活重试：新信封 + 旧 Custom → 自愈成新 key。
    failCustom = false;
    const healed = await adapter.retryCustomSync(DIRS);
    assert.deepEqual(healed, { pending: false, synced: true });
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'new-key');
    // 再次探活：已是新 key，不重复写（synced 表示“当前已同步”，不是“本次写入”）。
    const writesBefore = events.writes.filter((item) => item.name === 'api_key_custom').length;
    assert.deepEqual(await adapter.retryCustomSync(DIRS), { pending: false, synced: true });
    assert.equal(events.writes.filter((item) => item.name === 'api_key_custom').length, writesBefore);

    // 用户自值：refreshKey 不设待修复；retry 不触碰。
    const userStore = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 2, value: 'user-own-key', active: true }),
    };
    const userAdapter = makeAdapter(makeManager(userStore).Manager);
    assert.deepEqual(await userAdapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    }), { envelope: true, custom: true, conflict: false });
    assert.deepEqual(await userAdapter.retryCustomSync(DIRS), { pending: false, synced: false });
    assert.equal(userStore.api_key_custom.find((entry) => entry.active).value, 'user-own-key');
});

test('W3: custom sync self-heals after restart without the in-memory pending marker', async () => {
    // 模拟：refreshKey 已刷新信封、Custom 同步失败，随后 ST 重启（模块内存标记
    // 丢失）。新适配器第一次 /status 探活也必须按归属发现旧值并修复。
    const store = {
        apercus_gateway: envelope('new-key', 'alice', 'cred_keep', ['old-key', 'new-key']),
        api_key_custom: customList({ id: 1, value: 'old-key', active: true }),
    };
    const { Manager } = makeManager(store);
    const restarted = makeAdapter(Manager);
    assert.deepEqual(await restarted.retryCustomSync(DIRS), { pending: false, synced: true });
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'new-key');
});

test('I6: a Custom read failure during refreshKey sets pending and retryCustomSync heals after recovery', async () => {
    const store = {
        apercus_gateway: envelope('old-key', 'alice', 'cred_keep'),
        api_key_custom: customList({ id: 1, value: 'old-key', active: true }),
    };
    let failCustomRead = true;
    const { Manager } = makeManager(store);
    class FlakyManager extends Manager {
        async readSecret(name) {
            if (failCustomRead && name === 'api_key_custom') {
                failCustomRead = false;
                throw new Error('custom read failed');
            }
            return super.readSecret(name);
        }
    }
    const adapter = makeAdapter(FlakyManager);
    // 读失败：信封刷新保留，custom:false；旧 Custom 活动值归属未知 → 待修复。
    const refreshed = await adapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'cred_keep',
    });
    assert.deepEqual(refreshed, { envelope: true, custom: false, conflict: false });
    assert.equal(JSON.parse(store.apercus_gateway).key, 'new-key');
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'old-key');

    // 读取恢复后 /status 探活重试：仍是插件旧 key → 同步成信封 key。
    failCustomRead = false;
    assert.deepEqual(await adapter.retryCustomSync(DIRS), { pending: false, synced: true });
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'new-key');
});

test('refreshKey conflicts on a changed login credential and fails closed otherwise', async () => {
    const store = { apercus_gateway: envelope('old-key', 'alice', 'cred_keep') };
    const { Manager } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const conflict = await adapter.refreshKey(DIRS, 'new-key', 'alice', {
        expectedLoginCredential: 'other-cred',
    });
    assert.deepEqual(conflict, { envelope: false, custom: false, conflict: true });
    assert.equal(JSON.parse(store.apercus_gateway).key, 'old-key');

    assert.deepEqual(await adapter.refreshKey(DIRS, '', 'alice'), {
        envelope: false, custom: false, conflict: false,
    });
    assert.deepEqual(await adapter.refreshKey(DIRS, 'new-key', ''), {
        envelope: false, custom: false, conflict: false,
    });
    assert.deepEqual(await adapter.refreshKey({ root: '' }, 'new-key', 'alice'), {
        envelope: false, custom: false, conflict: false,
    });
    store.apercus_gateway = '{bad';
    assert.deepEqual(await adapter.refreshKey(DIRS, 'new-key', 'alice'), {
        envelope: false, custom: false, conflict: false,
    });

    const original = envelope('old-key', 'alice', 'cred_keep');
    const writeFailStore = { apercus_gateway: original, api_key_custom: 'old-key' };
    const writeFailAdapter = makeAdapter(makeManager(writeFailStore, {
        writeError: (name) => name === 'apercus_gateway',
    }).Manager);
    assert.deepEqual(await writeFailAdapter.refreshKey(DIRS, 'new-key', 'alice'), {
        envelope: false, custom: false, conflict: false,
    });
    assert.equal(writeFailStore.apercus_gateway, original);
});

test('the secrets module is imported once and import failures stay fail-closed', async () => {
    let loads = 0;
    const store = {};
    const { Manager } = makeManager(store);
    const adapter = createSecretBindingAdapter({
        stRoot: 'x',
        secretManagerLoader: async () => {
            loads += 1;
            return Manager;
        },
    });
    await adapter.readBinding(DIRS);
    await adapter.readBinding(DIRS);
    await adapter.writeBinding(DIRS, RECORD);
    assert.equal(loads, 1);

    const throwing = createSecretBindingAdapter({
        stRoot: 'x',
        secretManagerLoader: async () => {
            throw new Error('import failed');
        },
    });
    assert.equal(await throwing.readBinding(DIRS), null);
    assert.equal(await throwing.writeBinding(DIRS, RECORD), false);
    assert.deepEqual(await throwing.clearBinding(DIRS), { envelope: false, custom: false });
    assert.deepEqual(await throwing.refreshKey(DIRS, 'k', 'u'), {
        envelope: false, custom: false, conflict: false,
    });
    assert.deepEqual(await throwing.writeCustomSourceKey(DIRS, 'k'), {
        ok: false, conflict: false, customWritten: false, envelopeWritten: false,
    });
    assert.deepEqual(await throwing.clearCustomSourceKey(DIRS, ['k']), { ok: false, cleared: false });
});

test('G1: a Custom write failure rolls the envelope custom_keys back (fully unwritten)', async () => {
    const store = {
        apercus_gateway: envelope('plugin-key', 'alice', 'cred'),
        api_key_custom: customList({ id: 1, value: 'user-key', active: true }),
    };
    const { Manager } = makeManager(store, {
        writeError: (name) => name === 'api_key_custom',
    });
    const adapter = makeAdapter(Manager);
    const result = await adapter.writeCustomSourceKey(DIRS, 'plugin-key', {
        expectedLoginCredential: 'cred',
    });
    assert.deepEqual(result, {
        ok: false,
        conflict: false,
        customWritten: false,
        envelopeWritten: false,
        reason: 'custom_source_write_failed',
    });
    // 回滚后信封不含新 key 归属；Custom 仍是用户自有值。
    assert.equal(JSON.parse(store.apercus_gateway).custom_keys, undefined);
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'user-key');
});

test('G1: a failed envelope rollback reports the partial/unknown state', async () => {
    const store = {
        apercus_gateway: envelope('plugin-key', 'alice', 'cred'),
        api_key_custom: customList({ id: 1, value: 'user-key', active: true }),
    };
    let envelopeWrites = 0;
    const { Manager } = makeManager(store, {
        writeError: (name) => {
            if (name === 'apercus_gateway') {
                envelopeWrites += 1;
                return envelopeWrites >= 2; // 首次写归属成功，回滚写失败
            }
            return name === 'api_key_custom';
        },
    });
    const adapter = makeAdapter(Manager);
    const result = await adapter.writeCustomSourceKey(DIRS, 'plugin-key', {
        expectedLoginCredential: 'cred',
    });
    assert.deepEqual(result, {
        ok: false,
        conflict: false,
        customWritten: false,
        envelopeWritten: true,
        reason: 'custom_source_write_failed',
    });
    // 归属已落盘（回滚失败）：信封保留 key 记录，便于 logout 识别清理。
    assert.deepEqual(JSON.parse(store.apercus_gateway).custom_keys, ['plugin-key']);
    assert.equal(store.api_key_custom.find((entry) => entry.active).value, 'user-key');
});

test('G5: refresh eviction clears the oldest Custom value before slicing; logout leaves no plugin residue', async () => {
    // I4 之后 writeBinding 每次 approved 都会清掉上一账号的 Custom 值，
    // custom_keys 不再跨登录累积；G5 的超限淘汰路径由同一登录的 refreshKey
    // 触发（手动/API 重置后同一 credential 轮换 key 仍保留历史归属）。
    const store = {
        apercus_gateway: envelope('key-1', 'alice', 'cred-1', [
            'key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8',
        ]),
        api_key_custom: customList(
            { id: 1, value: 'key-1', active: false },
            { id: 2, value: 'key-8', active: true },
            { id: 3, value: 'user-own-key', active: false },
        ),
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    const result = await adapter.refreshKey(DIRS, 'key-9', 'alice', {
        expectedLoginCredential: 'cred-1',
    });
    assert.deepEqual(result, { envelope: true, custom: true, conflict: false });
    const parsed = JSON.parse(store.apercus_gateway);
    // 上限 8：最旧的 key-1 在淘汰前已从 Custom 删除，信封只保留 key-2..key-9。
    assert.deepEqual(parsed.custom_keys, ['key-2', 'key-3', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8', 'key-9']);
    assert.equal(store.api_key_custom.some((entry) => entry.value === 'key-1'), false);
    assert.deepEqual(events.deleteIds.filter((id) => id === 1), [1]);

    assert.deepEqual(await adapter.clearBinding(DIRS), { envelope: true, custom: true });
    assert.deepEqual(
        store.api_key_custom ? store.api_key_custom.map((entry) => entry.value) : [],
        ['user-own-key'],
    );
});

test('G5: an uncleanable evicted key keeps ownership and refuses the write (fail-closed)', async () => {
    const store = {
        api_key_custom: customList(
            { id: 1, value: 'key-1', active: false },
            { id: 2, value: 'user-own-key', active: true },
        ),
        apercus_gateway: envelope('key-9', 'alice', 'cred-9', [
            'key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8',
        ]),
    };
    const { Manager } = makeManager(store, {
        deleteError: (name) => name === 'api_key_custom',
    });
    const adapter = makeAdapter(Manager);
    const result = await adapter.writeCustomSourceKey(DIRS, 'key-9', {
        expectedLoginCredential: 'cred-9',
    });
    assert.deepEqual(result, {
        ok: false,
        conflict: false,
        customWritten: false,
        envelopeWritten: false,
        reason: 'custom_keys_evict_failed',
        warn: 'custom_keys_evict_failed',
    });
    // 旧信封原样保留（key-1 归属未丢），也没有写入 key-9 的 Custom 值。
    assert.deepEqual(JSON.parse(store.apercus_gateway).custom_keys,
        ['key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8']);
    assert.equal(store.api_key_custom.some((entry) => entry.value === 'key-9'), false);
});

test('I8: clearBinding removes envelope history by id too (ST deleteSecret only removes one entry)', async () => {
    const store = {
        apercus_gateway: [
            { id: 1, value: envelope('plugin-key', 'alice', 'old-cred'), active: false },
            { id: 2, value: envelope('plugin-key', 'alice', 'current-cred'), active: true },
        ],
        api_key_custom: [
            { id: 3, value: 'plugin-key', active: false },
            { id: 4, value: 'plugin-key', active: true },
        ],
    };
    const { Manager, events } = makeManager(store);
    const adapter = makeAdapter(Manager);
    assert.deepEqual(await adapter.clearBinding(DIRS), { envelope: true, custom: true });
    assert.equal(store.apercus_gateway, undefined);
    assert.equal(store.api_key_custom, undefined);
    // 信封按 id 逐个删除：inactive(1) 先、active(2) 最后（不会中途复活旧条目）。
    const envelopeIds = events.deleteIds.filter((id) => id === 1 || id === 2);
    assert.deepEqual(envelopeIds, [1, 2]);
});

test('I8: envelope deletion failure is fail-closed and never reports a fake success', async () => {
    // 删 active 条目（id 2）失败：返回 envelope:false，残留条目保持 active。
    const store = {
        apercus_gateway: [
            { id: 1, value: envelope('plugin-key', 'alice', 'old-cred'), active: false },
            { id: 2, value: envelope('plugin-key', 'alice', 'current-cred'), active: true },
        ],
    };
    const { Manager } = makeManager(store, {
        deleteError: (name, id) => name === 'apercus_gateway' && id === 2,
    });
    const adapter = makeAdapter(Manager);
    assert.deepEqual(await adapter.clearBinding(DIRS), { envelope: false, custom: true });
    assert.deepEqual(store.apercus_gateway.map((entry) => entry.id), [2]);
    assert.equal(store.apercus_gateway[0].active, true);

    // 删除后复核枚举失败：不得报成功（即使条目实际已删）。
    const cleanupStore = {
        apercus_gateway: [
            { id: 5, value: envelope('plugin-key', 'alice', 'old-cred'), active: false },
            { id: 6, value: envelope('plugin-key', 'alice', 'current-cred'), active: true },
        ],
        // 有插件 Custom 条目 → clearCustomSourceEntries 先枚举+复核两次，
        // 之后 deleteEnvelopeNamespace 的“删除后复核”是第 4 次枚举。
        api_key_custom: customList({ id: 7, value: 'plugin-key', active: true }),
    };
    const { Manager: BaseManager } = makeManager(cleanupStore);
    let getAllCalls = 0;
    class FlakyManager extends BaseManager {
        getAllSecrets() {
            getAllCalls += 1;
            if (getAllCalls === 4) throw new Error('post-delete read failed');
            return super.getAllSecrets();
        }
    }
    const flaky = makeAdapter(FlakyManager);
    assert.deepEqual(await flaky.clearBinding(DIRS), { envelope: false, custom: true });
    // 条目实际已删，但复核读失败 → 结果不得是 envelope:true。
    assert.equal(Object.hasOwn(cleanupStore, 'apercus_gateway'), false);
});

test('G8: readBindingState distinguishes empty, invalid, ok, and read errors', async () => {
    const store = {};
    const { Manager } = makeManager(store);
    const adapter = makeAdapter(Manager);
    assert.deepEqual(await adapter.readBindingState(DIRS), { status: 'empty' });

    store.apercus_gateway = envelope('key');
    const ok = await adapter.readBindingState(DIRS);
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.record, {
        loginCredential: 'cred',
        key: 'key',
        username: 'alice',
        customKeys: [],
    });

    store.apercus_gateway = '{bad';
    assert.deepEqual(await adapter.readBindingState(DIRS), { status: 'invalid' });

    const failing = makeAdapter(makeManager(store, { readError: true }).Manager);
    assert.deepEqual(await failing.readBindingState(DIRS), { status: 'error' });
    assert.deepEqual(await adapter.readBindingState({ root: '' }), { status: 'error' });
});
