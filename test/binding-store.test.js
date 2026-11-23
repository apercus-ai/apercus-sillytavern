'use strict';

// v3 连接记录（apercus_gateway 命名空间）的序列化/解析锁定：三件套
// {version:1, login_credential, key, username}、严格版本、fail-closed。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    BINDING_NAMESPACE,
    CUSTOM_SOURCE_NAMESPACE,
    serializeBindingRecord,
    parseBindingRecord,
    normalizeCustomKeys,
    isValidBindingKey,
    isValidLoginCredential,
} = require('../server/binding-store.js');

const RECORD = {
    loginCredential: 'cred_abc123',
    key: 'agw_key_abc',
    username: 'alice',
};

test('namespace constants are the two fixed ST secret namespaces', () => {
    assert.equal(BINDING_NAMESPACE, 'apercus_gateway');
    assert.equal(CUSTOM_SOURCE_NAMESPACE, 'api_key_custom');
});

test('binding keys follow the existing length and control-character contract', () => {
    assert.equal(isValidBindingKey('agw_key'), true);
    assert.equal(isValidBindingKey('k'.repeat(4096)), true);
    assert.equal(isValidBindingKey('k'.repeat(4097)), false);
    assert.equal(isValidBindingKey(''), false);
    assert.equal(isValidBindingKey(42), false);
    assert.equal(isValidBindingKey('a\nb'), false);
    assert.equal(isValidBindingKey('a\u0000b'), false);
    assert.equal(isValidBindingKey('a\u007fb'), false);
});

test('login credentials must be non-empty, bounded, control-character-free strings', () => {
    assert.equal(isValidLoginCredential('cred'), true);
    assert.equal(isValidLoginCredential(''), false);
    assert.equal(isValidLoginCredential(42), false);
    assert.equal(isValidLoginCredential('cred\nx'), false);
    assert.equal(isValidLoginCredential('c'.repeat(4097)), false);
});

test('serialize writes the fixed v3 envelope with the three fields', () => {
    const serialized = serializeBindingRecord(RECORD);
    assert.equal(serialized, JSON.stringify({
        version: 1,
        login_credential: 'cred_abc123',
        key: 'agw_key_abc',
        username: 'alice',
    }));
});

test('serialize fails closed on any malformed record field', () => {
    for (const record of [
        null,
        'nope',
        [],
        { ...RECORD, loginCredential: '' },
        { ...RECORD, loginCredential: 42 },
        { ...RECORD, key: '' },
        { ...RECORD, key: 'a\nb' },
        { ...RECORD, username: '' },
        { ...RECORD, username: 42 },
        { ...RECORD, username: 'a\rb' },
    ]) {
        assert.equal(serializeBindingRecord(record), null, JSON.stringify(record));
    }
});

test('parse round-trips a valid envelope and freezes the result', () => {
    const parsed = parseBindingRecord(serializeBindingRecord(RECORD));
    assert.deepEqual(parsed, {
        loginCredential: 'cred_abc123',
        key: 'agw_key_abc',
        username: 'alice',
        customKeys: [],
    });
    assert.equal(Object.isFrozen(parsed), true);
});

test('parse is strict about version and every field', () => {
    const valid = serializeBindingRecord(RECORD);
    for (const value of [
        null,
        '',
        '{bad',
        '[]',
        'null',
        JSON.stringify({ version: 2, login_credential: 'c', key: 'k', username: 'u' }),
        JSON.stringify({ version: '1', login_credential: 'c', key: 'k', username: 'u' }),
        JSON.stringify({ version: 1, key: 'k', username: 'u' }),
        JSON.stringify({ version: 1, login_credential: '', key: 'k', username: 'u' }),
        JSON.stringify({ version: 1, login_credential: 'c', key: 'k\nx', username: 'u' }),
        JSON.stringify({ version: 1, login_credential: 'c', key: 'k', username: '' }),
    ]) {
        assert.equal(parseBindingRecord(value), null, String(value));
    }
    assert.notEqual(parseBindingRecord(valid), null);
});

test('unknown extra fields never leak through the parsed record', () => {
    const parsed = parseBindingRecord(JSON.stringify({
        version: 1,
        login_credential: 'cred',
        key: 'key',
        username: 'alice',
        secret_note: 'must-not-survive',
    }));
    assert.deepEqual(Object.keys(parsed), ['loginCredential', 'key', 'username', 'customKeys']);
    assert.equal(parsed.secret_note, undefined);
});

test('custom_keys is optional, strictly validated, deduplicated on write, capped at 8 (F2)', () => {
    // 旧记录缺失 → []。
    const legacy = parseBindingRecord(JSON.stringify({
        version: 1,
        login_credential: 'cred',
        key: 'key',
        username: 'alice',
    }));
    assert.deepEqual(legacy.customKeys, []);

    // 写入侧去重；解析侧严格拒绝重复（坏归属列表不可用）。
    const deduped = serializeBindingRecord({ ...RECORD, customKeys: ['k1', 'k1', 'k2'] });
    assert.deepEqual(JSON.parse(deduped).custom_keys, ['k1', 'k2']);
    assert.equal(parseBindingRecord(JSON.stringify({
        version: 1,
        login_credential: 'cred',
        key: 'key',
        username: 'alice',
        custom_keys: ['k1', 'k1'],
    })), null);

    // 逐项必须是合法 binding key；最多 8 个（去重后）。
    for (const customKeys of [
        'nope',
        [42],
        ['a\nb'],
        Array.from({ length: 9 }, (_, index) => `k${index}`),
    ]) {
        assert.equal(serializeBindingRecord({ ...RECORD, customKeys }), null, JSON.stringify(customKeys));
        assert.equal(parseBindingRecord(JSON.stringify({
            version: 1,
            login_credential: 'cred',
            key: 'key',
            username: 'alice',
            custom_keys: customKeys,
        })), null, JSON.stringify(customKeys));
    }

    const eight = Array.from({ length: 8 }, (_, index) => `k${index}`);
    const parsed = parseBindingRecord(serializeBindingRecord({ ...RECORD, customKeys: eight }));
    assert.deepEqual(parsed.customKeys, eight);
    assert.deepEqual(JSON.parse(serializeBindingRecord({ ...RECORD, customKeys: eight })).custom_keys, eight);

    // 空数组与缺省序列化等价（保持旧信封形状）。
    assert.equal(serializeBindingRecord({ ...RECORD, customKeys: [] }),
        serializeBindingRecord(RECORD));
});

test('normalizeCustomKeys is the lenient core-side normalizer', () => {
    assert.deepEqual(normalizeCustomKeys(undefined), []);
    assert.deepEqual(normalizeCustomKeys(['a', 'a', 'b']), ['a', 'b']);
    assert.equal(normalizeCustomKeys(['a\nb']), null);
    assert.equal(normalizeCustomKeys(Array.from({ length: 9 }, (_, index) => `k${index}`)), null);
});
