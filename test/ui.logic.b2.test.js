'use strict';

// B2 防截断分节的纯逻辑锁定：两段提示词、预设条目模型、摘要脱敏、校验器、
// layers 解析、分层指纹、守卫矩阵、custom_include_body 合并、面板五态。
// 规格正本：plan/st-plugin-binding/plugin-batch.md B2 节（2026-11-19 重写）。

const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let L;

before(async () => {
    L = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'logic.mjs')));
});

function entry(name, content, enabled) {
    return { name, content, enabled: enabled === true };
}

// ===== 两段提示词 =====

test('call-one prompt keeps the spec text verbatim and appends the F3 input block', () => {
    const expected = '你是分节配置器。你的输出会作为节名单交给网关：网关把单次回复\n'
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
        + '{"sections":["节名1","节名2"]}'
        + '\n\n'
        + '预设内容（可能被截断，≤16000 字符）：\n"""\n'
        + 'SUMMARY-TEXT'
        + '\n"""';
    assert.equal(L.buildSectionsPrompt('SUMMARY-TEXT'), expected);
});

test('call-one prompt caps the preset summary at 16000 characters and marks truncation (F8)', () => {
    const head = 'a'.repeat(L.ANTITRUNC_SUMMARY_MAX_CHARS);
    const prompt = L.buildSectionsPrompt(`${head}TAIL-MUST-BE-CUT`);
    assert.equal(prompt.includes(head), true);
    assert.equal(prompt.includes('TAIL-MUST-BE-CUT'), false);
    // F8：截断标记在输入块末尾（关闭三引号之前），规格提示词其余部分全文保留。
    assert.equal(prompt.includes(`${head}${L.ANTITRUNC_LAYERS_TRUNCATED_MARK}\n"""`), true);
    assert.equal(prompt.startsWith('你是分节配置器。'), true);
    assert.ok(prompt.includes('{"sections":["节名1","节名2"]}'), true);

    const exactly = L.buildSectionsPrompt(head);
    assert.equal(exactly.includes(L.ANTITRUNC_LAYERS_TRUNCATED_MARK), false);

    const empty = L.buildSectionsPrompt(undefined);
    assert.ok(empty.includes('预设内容（可能被截断，≤16000 字符）：\n"""\n\n"""'));
});

test('call-two prompt keeps the numbered classifier text and JSON example verbatim', () => {
    const expectedHead = '你是分类器。以下是角色扮演预设的编号条目清单（含已关闭的）。逐条\n'
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
    const prompt = L.buildLayersPrompt([entry('Main Prompt', 'content-body', true)]);
    // 全文等值：固定提示词 + 单条目编号行。
    assert.equal(prompt, expectedHead + '[0] Main Prompt：content-body' + '\n"""');
    // 示例不得出现会被模型当字面值的 "structural 或 content"。
    assert.equal(prompt.includes('"structural 或 content"'), false);
});

test('call-two includes disabled entries, prioritizes enabled entries, and marks truncation', () => {
    const small = L.buildLayersPrompt([
        entry('Disabled Entry', 'DISABLED-CONTENT', false),
        entry('Enabled Entry', 'ENABLED-CONTENT', true),
    ]);
    // 清单编号按输出顺序 0..n-1；启用条目排在前（稳定下标仍由解析侧映射）。
    assert.ok(small.includes('[0] Enabled Entry：ENABLED-CONTENT'));
    assert.ok(small.includes('[1] Disabled Entry：DISABLED-CONTENT'));
    assert.ok(small.indexOf('[0] Enabled Entry') < small.indexOf('[1] Disabled Entry'));

    const huge = L.buildLayersPromptWithMeta([
        entry('Enabled Huge', 'E'.repeat(30000), true),
        entry('Disabled Tail', 'D', false),
    ], 500);
    assert.ok(huge.prompt.includes('[0] Enabled Huge：'));
    assert.equal(huge.prompt.includes('Disabled Tail'), false);
    assert.ok(huge.prompt.includes(L.ANTITRUNC_LAYERS_TRUNCATED_MARK));
    // 截断点及其后的条目全部标记：解析时强制 structural（含未列出的 Tail）。
    assert.deepEqual(huge.truncatedIndexes, [0, 1]);
    // 条目清单段受 500 字符预算约束；固定提示词只有几百字符。
    assert.ok(huge.prompt.length <= 500 + 700, `prompt too long: ${huge.prompt.length}`);
});

test('call-two marks the current stable index even when the truncation marker itself cannot fit (U8)', () => {
    const entries = [
        entry('Enabled Huge', 'E'.repeat(30000), true),
        entry('Disabled Tail', 'D', false),
    ];
    // 预算连“[0] Enabled Huge：〔已截断〕”都放不下。
    const tiny = L.buildLayersPromptWithMeta(entries, 5);
    assert.equal(tiny.prompt.includes('[0] Enabled Huge'), false);
    assert.deepEqual(tiny.truncatedIndexes, [0, 1]);

    const single = L.buildLayersPromptWithMeta([entries[0]], 1);
    assert.deepEqual(single.truncatedIndexes, [0]);
});

test('call-two redacts secret-shaped values in entry names and contents before sending', () => {
    const prompt = L.buildLayersPrompt([
        entry('Main', 'use key=supersecret and sk-abcdef123456 and Bearer tok.123', true),
        entry('sk-nameabcdef123456', 'plain content', true),
        entry('api_key=name-secret', 'plain content', true),
    ]);
    for (const secret of ['supersecret', 'sk-abcdef123456', 'tok.123', 'sk-nameabcdef123456', 'name-secret']) {
        assert.equal(prompt.includes(secret), false, secret);
    }
    assert.ok(prompt.includes('[REDACTED]'));
    assert.ok(prompt.includes('[1] [REDACTED]：'));
});

// ===== 预设条目模型 =====

test('presetEntries follows the ST 1.17 prompt_order execution order (identifier is the stable key)', () => {
    const preset = {
        prompts: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'hello' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
            { identifier: 'extra', name: 'Extra', role: 'system', content: 'x' },
        ],
        prompt_order: [
            {
                character_id: 100000,
                order: [{ identifier: 'main', enabled: false }],
            },
            {
                character_id: 100001,
                order: [
                    // prompts 数组顺序是 main/chatHistory/extra；执行顺序由本槽
                    // 决定：chatHistory 在前，main 在后；extra 未列出 = 不执行。
                    { identifier: 'chatHistory', enabled: false },
                    { identifier: 'main', enabled: true },
                ],
            },
        ],
    };
    assert.deepEqual(L.presetEntries(preset), [
        { identifier: 'chatHistory', name: 'Chat History', content: '', enabled: false },
        { identifier: 'main', name: 'Main', content: 'hello', enabled: true },
    ]);
});

test('presetEntries fails closed on any unexpected shape, dangling identifier, or duplicate', () => {
    const validOrder = [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }];
    const validPrompt = [{ identifier: 'main', name: 'Main', content: 'x' }];
    const cases = [
        null,
        {},
        { prompts: [], prompt_order: validOrder },
        { prompts: 'nope', prompt_order: validOrder },
        { prompts: validPrompt },
        { prompts: validPrompt, prompt_order: {} },
        { prompts: validPrompt, prompt_order: [{ character_id: 100000, order: [] }] },
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: 'nope' }] },
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: [null] }] },
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: [{ identifier: '', enabled: true }] }] },
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: 'yes' }] }] },
        { prompts: [null], prompt_order: validOrder },
        { prompts: [{ identifier: '', name: 'Main', content: 'x' }], prompt_order: validOrder },
        { prompts: [{ identifier: 'main', name: '', content: 'x' }], prompt_order: validOrder },
        { prompts: [{ identifier: 'main', name: 'Main', content: 42 }], prompt_order: validOrder },
        { prompts: [{ identifier: 'main', name: 'Main', content: 'a' }, { identifier: 'main', name: 'Other', content: 'b' }], prompt_order: validOrder },
        // prompt_order 指向不存在的 identifier / 同一 identifier 重复出现。
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: [{ identifier: 'missing', enabled: true }] }] },
        { prompts: validPrompt, prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'main', enabled: false }] }] },
    ];
    for (const preset of cases) {
        assert.deepEqual(L.presetEntries(preset), [], JSON.stringify(preset));
    }
});

// ===== 摘要脱敏 =====

test('summary redaction drops credential-named fields and rewrites secret-shaped values', () => {
    const preset = {
        api_key: 'sk-live-abcdef123456',
        authToken: 'Bearer abc.def.ghi',
        proxy_password: 'p',
        custom_include_body: '{}',
        custom_url: 'https://example.invalid',
        keep: 42,
        nested: { password: 'p', token: 't', ok: 'fine' },
        prompts: [{
            identifier: 'main',
            name: 'Main',
            content: 'use key=supersecret and api_key=anothersecret and sk-abcdef123456 and Bearer tok.123',
        }],
    };
    const out = L.redactPresetForSummary(preset);
    for (const key of ['api_key', 'authToken', 'proxy_password', 'custom_include_body', 'custom_url']) {
        assert.equal(Object.hasOwn(out, key), false, key);
    }
    assert.equal(out.keep, 42);
    assert.deepEqual(out.nested, { ok: 'fine' });
    const content = out.prompts[0].content;
    for (const secret of ['supersecret', 'anothersecret', 'sk-abcdef123456', 'tok.123']) {
        assert.equal(content.includes(secret), false, secret);
    }
    assert.ok(content.includes('[REDACTED]'));
    // 原对象不被修改。
    assert.equal(preset.prompts[0].content.includes('supersecret'), true);
});

test('redactSecretPatterns covers sk-, Bearer, and key assignments', () => {
    const text = 'a sk-abcdef123456 b Bearer abc.def c key=value1 d api_key=value2';
    const out = L.redactSecretPatterns(text);
    for (const secret of ['sk-abcdef123456', 'abc.def', 'value1', 'value2']) {
        assert.equal(out.includes(secret), false, secret);
    }
});

// ===== 节名单校验器 =====

test('parseSections accepts plain and fenced JSON, trims, and drops empty strings', () => {
    const plain = L.parseSections('{"sections":["  A  ","","B"]}');
    assert.deepEqual(plain, { ok: true, reason: null, sections: ['A', 'B'] });

    const fenced = L.parseSections('```json\n{"sections":["A","B"]}\n```');
    assert.deepEqual(fenced, { ok: true, reason: null, sections: ['A', 'B'] });

    const tildes = L.parseSections('~~~\n{"sections":["A","B"]}\n~~~');
    assert.deepEqual(tildes, { ok: true, reason: null, sections: ['A', 'B'] });
});

test('parseSections enforces 2..16 unique items and 64 UTF-8 bytes each', () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => `S${index}`);
    assert.equal(L.parseSections(JSON.stringify({ sections: sixteen })).ok, true);
    assert.equal(L.parseSections(JSON.stringify({ sections: [...sixteen, 'S16'] })).ok, false);
    assert.equal(L.parseSections(JSON.stringify({ sections: ['only-one'] })).ok, false);
    assert.equal(L.parseSections(JSON.stringify({ sections: ['A', 'B', 'A'] })).ok, false);

    const at64 = 'a'.repeat(64);
    assert.equal(L.parseSections(JSON.stringify({ sections: ['A', at64] })).ok, true);
    assert.equal(L.parseSections(JSON.stringify({ sections: ['A', 'a'.repeat(65)] })).ok, false);

    // UTF-8 字节按编码计：21 个汉字 = 63B 通过；22 个 = 66B 拒绝。
    assert.equal(L.parseSections(JSON.stringify({ sections: ['A', '汉'.repeat(21)] })).ok, true);
    assert.equal(L.parseSections(JSON.stringify({ sections: ['A', '汉'.repeat(22)] })).ok, false);

    const allEmpty = L.parseSections('{"sections":["","  ","\\t"]}');
    assert.equal(allEmpty.ok, false);
    assert.deepEqual(allEmpty.sections, []);
});

test('parseSections reports every malformed shape without inventing a fallback list', () => {
    const cases = [
        [null, 'sections_not_text'],
        ['', 'sections_empty'],
        ['{not json', 'sections_json_invalid'],
        ['[]', 'sections_shape_invalid'],
        ['{"sections":"A"}', 'sections_shape_invalid'],
        ['{"sections":[1,2]}', 'sections_item_invalid'],
    ];
    for (const [text, reason] of cases) {
        const parsed = L.parseSections(text);
        assert.equal(parsed.ok, false, String(text));
        assert.equal(parsed.reason, reason, String(text));
        assert.deepEqual(parsed.sections, [], String(text));
    }
    assert.equal(Object.hasOwn(L, 'ANTITRUNC_FALLBACK_SECTIONS'), false);
});

// ===== layers 解析 =====

test('parseLayers maps by entry number and treats unknown values as structural', () => {
    const entries = [
        entry('A', 'ca', true),
        entry('B', 'cb', true),
        entry('C', 'cc', true),
        entry('Missing', 'cm', true),
    ];
    const parsed = L.parseLayers(
        '```json\n{"layers":{"0":"content","1":"structural","2":"bogus","99":"content","-1":"content","Unknown":"content"}}\n```',
        entries,
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.layers, {
        '0': 'content',
        '1': 'structural',
        '2': 'structural',
        '3': 'structural',
    });
    assert.equal(Object.hasOwn(parsed.layers, '99'), false);
    assert.equal(Object.hasOwn(parsed.layers, 'Unknown'), false);
});

test('parseLayers gives duplicate-name entries their own chapter by number', () => {
    const entries = [entry('Dup', 'one', true), entry('Dup', 'two', false)];
    const parsed = L.parseLayers('{"layers":{"0":"content","1":"structural"}}', entries);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.layers, { '0': 'content', '1': 'structural' });
});

test('parseLayers maps output numbers back to stable entry indexes across enable order', () => {
    // 输入顺序：禁用条目在稳定下标 0，启用条目在 1；清单输出把启用项排到 [0]。
    const entries = [entry('Disabled', 'd', false), entry('Enabled', 'e', true)];
    const parsed = L.parseLayers('{"layers":{"0":"content","1":"structural"}}', entries);
    assert.equal(parsed.ok, true);
    // [0]＝Enabled（稳定下标 1，content）；[1]＝Disabled（稳定下标 0，structural）。
    assert.deepEqual(parsed.layers, { '0': 'structural', '1': 'content' });
});

test('parseLayers forces truncated entries to structural even if the model labels them', () => {
    const entries = [entry('A', 'a', true), entry('B', 'b', false)];
    const parsed = L.parseLayers('{"layers":{"0":"content","1":"content"}}', entries, {
        truncatedIndexes: [0],
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.layers, { '0': 'structural', '1': 'content' });
});

test('parseLayers falls back to all-structural on parse failure', () => {
    const entries = [entry('A', 'a', true), entry('B', 'b', false), entry('Dup', 'd1', true), entry('Dup', 'd2', true)];
    const allStructural = { '0': 'structural', '1': 'structural', '2': 'structural', '3': 'structural' };
    for (const text of [null, '', '{bad', '[]', '{"layers":[]}']) {
        const parsed = L.parseLayers(text, entries);
        assert.equal(parsed.ok, false, String(text));
        assert.deepEqual(parsed.layers, allStructural);
    }
    const emptyLayers = L.parseLayers('{"layers":{}}', entries);
    assert.equal(emptyLayers.ok, true);
    assert.deepEqual(emptyLayers.layers, allStructural);
});

test('isValidSectionList enforces the same contract on cached lists', () => {
    assert.equal(L.isValidSectionList(['A', 'B']), true);
    assert.equal(L.isValidSectionList([' A', 'B']), false);
    assert.equal(L.isValidSectionList(['A']), false);
    assert.equal(L.isValidSectionList(['A', 'A']), false);
    assert.equal(L.isValidSectionList(['A', 'a'.repeat(65)]), false);
    assert.equal(L.isValidSectionList('nope'), false);
});

// ===== 分层指纹 =====

test('layered vs structural fingerprint: content-layer edits only rerun call two', async () => {
    const layers = { '0': 'structural', '1': 'content' };
    const before = [entry('A', 'alpha', true), entry('B', 'beta', true)];
    const beforeLayered = await L.layeredFingerprint(before);
    const beforeStructural = await L.structuralFingerprint(before, layers);
    assert.match(beforeLayered, /^[0-9a-f]{64}$/);
    assert.match(beforeStructural, /^[0-9a-f]{64}$/);

    const contentEdit = [entry('A', 'alpha', true), entry('B', 'beta-changed', true)];
    assert.notEqual(await L.layeredFingerprint(contentEdit), beforeLayered);
    assert.equal(await L.structuralFingerprint(contentEdit, layers), beforeStructural);

    const structuralEdit = [entry('A', 'alpha-changed', true), entry('B', 'beta-changed', true)];
    assert.notEqual(await L.structuralFingerprint(structuralEdit, layers), beforeStructural);
});

test('fingerprints include prompt_order sequence: pure reorder changes both fingerprints (U5)', async () => {
    const prompts = [
        { identifier: 'main', name: 'Main', content: 'main-content' },
        { identifier: 'style', name: 'Style', content: 'style-content' },
    ];
    const presetA = {
        prompts,
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'main', enabled: true },
            { identifier: 'style', enabled: true },
        ] }],
    };
    const presetB = {
        prompts,
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'style', enabled: true },
            { identifier: 'main', enabled: true },
        ] }],
    };
    const entriesA = L.presetEntries(presetA);
    const entriesB = L.presetEntries(presetB);
    assert.deepEqual(entriesA.map((entry) => entry.identifier), ['main', 'style']);
    assert.deepEqual(entriesB.map((entry) => entry.identifier), ['style', 'main']);
    // 名称/内容/启用完全不变，只有执行顺序变化。
    assert.notEqual(await L.layeredFingerprint(entriesA), await L.layeredFingerprint(entriesB));
    const layers = { '0': 'structural', '1': 'structural' };
    assert.notEqual(await L.structuralFingerprint(entriesA, layers), await L.structuralFingerprint(entriesB, layers));
});

test('structural fingerprint excludes disabled entries and defaults unknown entries to structural', async () => {
    const layers = { '0': 'structural', '1': 'content' };
    const enabled = [entry('A', 'alpha', true), entry('B', 'beta', true)];
    const disabled = [entry('A', 'alpha', false), entry('B', 'beta', true)];
    assert.equal(await L.layeredFingerprint(disabled), await L.layeredFingerprint(enabled));
    assert.notEqual(await L.structuralFingerprint(disabled, layers), await L.structuralFingerprint(enabled, layers));

    const newEntry = [...enabled, entry('New', 'gamma', true)];
    assert.notEqual(await L.structuralFingerprint(newEntry, layers), await L.structuralFingerprint(enabled, layers));

    const newDisabled = [...enabled, entry('New', 'gamma', false)];
    assert.equal(await L.structuralFingerprint(newDisabled, layers), await L.structuralFingerprint(enabled, layers));

    // 重名条目按编号各盖各章：编号 1 标 content 时只排除第二项。
    const dup = [entry('Dup', 'one', true), entry('Dup', 'two', true)];
    assert.notEqual(
        await L.structuralFingerprint(dup, { '0': 'structural', '1': 'content' }),
        await L.structuralFingerprint(dup, { '0': 'structural', '1': 'structural' }),
    );
    // 未标注编号一律 structural。
    assert.equal(
        await L.structuralFingerprint(dup, { '0': 'structural' }),
        await L.structuralFingerprint(dup, { '0': 'structural', '1': 'structural' }),
    );
});

test('fingerprints are unambiguous across name/content boundaries', async () => {
    assert.notEqual(
        await L.layeredFingerprint([entry('a', 'bc', true)]),
        await L.layeredFingerprint([entry('ab', 'c', true)]),
    );
});

test('fingerprints fail closed when crypto.subtle is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
        assert.equal(await L.layeredFingerprint([entry('A', 'a', true)]), null);
        assert.equal(await L.structuralFingerprint([entry('A', 'a', true)], { A: 'structural' }), null);
    } finally {
        Object.defineProperty(globalThis, 'crypto', descriptor);
    }
});

// ===== 守卫矩阵 =====

test('guard matrix covers tools/functions/function_call/response_format/json_schema only', () => {
    assert.deepEqual(
        L.checkAntitruncGuards({ messages: [{ role: 'user', content: 'x' }] }),
        { ok: true, reason: null },
    );
    // json_schema 是插件自加：ST 后端会把它映射成上游 response_format，
    // 最终请求命中放弃集，因此守卫必须提前拦截。
    for (const key of ['tools', 'functions', 'function_call', 'response_format', 'json_schema']) {
        const result = L.checkAntitruncGuards({ [key]: [], messages: [] });
        assert.equal(result.ok, false, key);
        assert.equal(result.reason, `antitrunc_guard_${key}`);
    }
});

test('guard matrix: tool_choice alone does not trigger the abandon set', () => {
    assert.deepEqual(
        L.checkAntitruncGuards({ tool_choice: 'auto', messages: [{ role: 'user' }] }),
        { ok: true, reason: null },
    );
    assert.deepEqual(
        L.checkAntitruncGuards({ tool_choice: { type: 'function' }, messages: [{ role: 'user' }] }),
        { ok: true, reason: null },
    );
});

test('guard matrix: n must be literal 1; messages are required by default but optional in merged bodies', () => {
    assert.equal(L.checkAntitruncGuards({ n: 1, messages: [] }).ok, false);
    assert.equal(L.checkAntitruncGuards({ n: 1, messages: [{ role: 'user' }] }).ok, true);
    assert.equal(L.checkAntitruncGuards({ n: undefined, messages: [{ role: 'user' }] }).ok, true);
    assert.equal(L.checkAntitruncGuards({ n: 2, messages: [{ role: 'user' }] }).ok, false);
    assert.equal(L.checkAntitruncGuards({ n: '1', messages: [{ role: 'user' }] }).ok, false);
    assert.equal(L.checkAntitruncGuards({ n: 0, messages: [{ role: 'user' }] }).ok, false);

    // generate_data 口径：missing / non-array / empty 都触发。
    for (const settings of [{}, { messages: undefined }, { messages: [] }, { messages: 'nope' }, { messages: null }]) {
        assert.equal(L.checkAntitruncGuards(settings).ok, false, JSON.stringify(settings));
        assert.equal(L.checkAntitruncGuards(settings).reason, 'antitrunc_guard_messages', JSON.stringify(settings));
    }
    assert.deepEqual(
        L.checkAntitruncGuards({ messages: [{ role: 'user' }] }),
        { ok: true, reason: null },
    );

    // 合并体口径：messages 可以缺席；只有“存在但非法”才触发。
    assert.deepEqual(L.checkAntitruncGuards({}, { requireMessages: false }), { ok: true, reason: null });
    assert.equal(L.checkAntitruncGuards({ messages: [] }, { requireMessages: false }).ok, false);
    assert.equal(L.checkAntitruncGuards({ messages: 'nope' }, { requireMessages: false }).ok, false);
    assert.equal(L.checkAntitruncGuards({ messages: undefined }, { requireMessages: false }).ok, false);
    assert.equal(L.checkAntitruncGuards(null).ok, false);
});

// ===== custom_include_body 合并 =====

const SECTIONS = ['开场', '推进', '收束'];

test('merge writes the two keys into an empty body and preserves user fields', () => {
    const empty = L.mergeAntitruncBody('', SECTIONS);
    assert.equal(empty.ok, true);
    const emptyBody = JSON.parse(empty.body);
    assert.equal(emptyBody[L.ANTITRUNC_BODY_FLAG], true);
    assert.deepEqual(emptyBody[L.ANTITRUNC_BODY_SECTIONS], SECTIONS);

    const withUser = L.mergeAntitruncBody('{"temperature":0.5,"stop":["x"]}', SECTIONS);
    assert.equal(withUser.ok, true);
    const userBody = JSON.parse(withUser.body);
    assert.equal(userBody.temperature, 0.5);
    assert.deepEqual(userBody.stop, ['x']);
    assert.equal(userBody[L.ANTITRUNC_BODY_FLAG], true);
});

test('merge removes the plugin old keys and is idempotent for identical values', () => {
    const existing = JSON.stringify({
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: SECTIONS.slice(),
        keep: 'me',
    });
    const once = L.mergeAntitruncBody(existing, SECTIONS, { lastInjectedBody: existing });
    assert.equal(once.ok, true);
    const body = JSON.parse(once.body);
    assert.equal(body.keep, 'me');
    assert.equal(Object.keys(body).filter((key) => key === L.ANTITRUNC_BODY_FLAG).length, 1);
    assert.deepEqual(body[L.ANTITRUNC_BODY_SECTIONS], SECTIONS);

    const twice = L.mergeAntitruncBody(once.body, SECTIONS, { lastInjectedBody: once.body });
    assert.equal(twice.ok, true);
    assert.deepEqual(JSON.parse(twice.body), body);
});

test('merge treats the exact last-injected body as plugin-owned and rewrites it (U6)', () => {
    const cases = [
        JSON.stringify({ [L.ANTITRUNC_BODY_FLAG]: false, [L.ANTITRUNC_BODY_SECTIONS]: SECTIONS }),
        JSON.stringify({ [L.ANTITRUNC_BODY_FLAG]: true, [L.ANTITRUNC_BODY_SECTIONS]: ['旧名单'] }),
        JSON.stringify({ [L.ANTITRUNC_BODY_SECTIONS]: 'not-an-array' }),
        JSON.stringify({ [L.ANTITRUNC_BODY_SECTIONS]: '' }),
        JSON.stringify({ [L.ANTITRUNC_BODY_FLAG]: 'yes' }),
    ];
    for (const existing of cases) {
        const merged = L.mergeAntitruncBody(existing, SECTIONS, { lastInjectedBody: existing });
        assert.equal(merged.ok, true, existing);
        assert.equal(merged.skipped, false, existing);
        const body = JSON.parse(merged.body);
        assert.equal(body[L.ANTITRUNC_BODY_FLAG], true, existing);
        assert.deepEqual(body[L.ANTITRUNC_BODY_SECTIONS], SECTIONS, existing);
    }
});

test('merge does not strip user-owned same-name keys with different values (U6)', () => {
    const userBody = JSON.stringify({
        temperature: 0.9,
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['用户名单'],
    });
    const merged = L.mergeAntitruncBody(userBody, SECTIONS);
    assert.equal(merged.ok, false);
    assert.equal(merged.skipped, true);
    assert.equal(merged.reason, 'antitrunc_body_user_override');
    assert.equal(merged.body, userBody);

    // lastInjectedBody 不同（插件重载/内存丢失）也按用户内容处理。
    const fromOtherPluginRun = JSON.stringify({
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['旧名单'],
    });
    const other = L.mergeAntitruncBody(fromOtherPluginRun, SECTIONS, { lastInjectedBody: '{"other":true}' });
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'antitrunc_body_user_override');
    assert.equal(other.body, fromOtherPluginRun);

    // 同名键值已等于本次名单：幂等放行，且不重写用户格式。
    const already = JSON.stringify({
        keep: 'me',
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: SECTIONS,
    });
    const idempotent = L.mergeAntitruncBody(already, SECTIONS);
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.body, already);
});

test('merge updates a stale old section list instead of misreading it as a user key', () => {
    const oldBody = JSON.stringify({
        temperature: 0.7,
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['旧-A', '旧-B'],
    });
    const merged = L.mergeAntitruncBody(oldBody, SECTIONS, { lastInjectedBody: oldBody });
    assert.equal(merged.ok, true);
    const body = JSON.parse(merged.body);
    assert.equal(body.temperature, 0.7);
    assert.deepEqual(body[L.ANTITRUNC_BODY_SECTIONS], SECTIONS);
});

test('merge refuses invalid JSON and invalid section lists without writing', () => {
    const invalidJson = L.mergeAntitruncBody('{not json', SECTIONS);
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.skipped, true);
    assert.equal(invalidJson.reason, 'antitrunc_body_unparseable');

    for (const sections of [null, [], ['only-one'], ['A', 'A'], ['A', 'a'.repeat(65)]]) {
        const merged = L.mergeAntitruncBody('{}', sections);
        assert.equal(merged.ok, false);
        assert.equal(merged.reason, 'antitrunc_sections_invalid');
    }
});

test('merge refuses to write when user fields would trigger the gateway guard', () => {
    const merged = L.mergeAntitruncBody('{"tools":[{"type":"function"}]}', SECTIONS);
    assert.equal(merged.ok, false);
    assert.equal(merged.skipped, true);
    assert.equal(merged.reason, 'antitrunc_guard_tools');
});

// ===== 插件旧键清理（评审 B）=====

test('hasAntitruncKeys only accepts JSON objects containing a plugin key', () => {
    assert.equal(L.hasAntitruncKeys(''), false);
    assert.equal(L.hasAntitruncKeys('   '), false);
    assert.equal(L.hasAntitruncKeys('nope'), false);
    assert.equal(L.hasAntitruncKeys('[]'), false);
    assert.equal(L.hasAntitruncKeys('null'), false);
    assert.equal(L.hasAntitruncKeys('{}'), false);
    assert.equal(L.hasAntitruncKeys('{"keep":1}'), false);
    assert.equal(L.hasAntitruncKeys(JSON.stringify({ [L.ANTITRUNC_BODY_FLAG]: false })), true);
    assert.equal(L.hasAntitruncKeys(JSON.stringify({ [L.ANTITRUNC_BODY_SECTIONS]: [] })), true);
});

test('stripAntitruncKeys removes plugin keys and keeps user fields; invalid input is untouched', () => {
    assert.equal(L.stripAntitruncKeys(''), '');
    assert.equal(L.stripAntitruncKeys('nope'), 'nope');
    assert.equal(L.stripAntitruncKeys('[]'), '[]');
    assert.equal(L.stripAntitruncKeys('{}'), '{}');
    assert.equal(L.stripAntitruncKeys('{"keep":1}'), '{"keep":1}');
    assert.equal(L.stripAntitruncKeys(JSON.stringify({ [L.ANTITRUNC_BODY_FLAG]: true })), '');
    assert.equal(L.stripAntitruncKeys(JSON.stringify({
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['A', 'B'],
    })), '');
    assert.deepEqual(
        JSON.parse(L.stripAntitruncKeys(JSON.stringify({
            temperature: 0.5,
            [L.ANTITRUNC_BODY_FLAG]: true,
            stop: ['x'],
            [L.ANTITRUNC_BODY_SECTIONS]: ['A', 'B'],
        }))),
        { temperature: 0.5, stop: ['x'] },
    );
});

test('stripAntitruncKeys handles __proto__ without prototype pollution', () => {
    const body = '{"__proto__":{"polluted":true},"keep":1,"apercus_antitrunc":true}';
    const stripped = L.stripAntitruncKeys(body);
    const parsed = JSON.parse(stripped);
    assert.equal(parsed.keep, 1);
    assert.equal(Object.hasOwn(parsed, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.hasOwn(parsed, L.ANTITRUNC_BODY_FLAG), false);
});

test('isStaleAntitruncBody requires exact string equality (user edits are never stripped) (U6)', () => {
    const last = JSON.stringify({
        temperature: 0.5,
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['A', 'B'],
    });
    assert.equal(L.isStaleAntitruncBody(last, last), true);

    // 键序不同/仅解析后等价的 body 不再算插件自有（严格相等才清理）。
    const reordered = `{ "apercus_antitrunc_sections":["A","B"],"temperature":0.5,"apercus_antitrunc":true }`;
    assert.equal(L.isStaleAntitruncBody(reordered, last), false);

    // 用户改动其他字段 → 不清理。
    const changed = JSON.stringify({
        temperature: 0.6,
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: ['A', 'B'],
    });
    assert.equal(L.isStaleAntitruncBody(changed, last), false);

    // 当前 body 没有插件键 → 无需清理（不重写用户格式）。
    assert.equal(L.isStaleAntitruncBody('{"temperature":0.5}', last), false);
    // 非法/空值 → 不清理。
    assert.equal(L.isStaleAntitruncBody('{bad', last), false);
    assert.equal(L.isStaleAntitruncBody('', last), false);
    assert.equal(L.isStaleAntitruncBody(null, last), false);
    assert.equal(L.isStaleAntitruncBody(last, undefined), false);
});

// ===== 面板五态 + 地板 + 固定域 =====

test('panel state helper exposes five states and stable priority', () => {
    assert.deepEqual(L.antitruncPanelState({ cacheHit: true }), {
        state: '有效',
        message: '节名单有效，注入就绪。',
    });
    assert.equal(L.antitruncPanelState({ fingerprintExpired: true }).state, '过期');
    assert.equal(L.antitruncPanelState({ fingerprintExpired: true }).message,
        '预设结构已变动，点击重新生成；生成前防截断暂停。');
    assert.equal(L.antitruncPanelState({ generationFailed: true }).state, '生成失败');
    assert.equal(L.antitruncPanelState({ guardBlocked: true }).state, '守卫警告');
    assert.equal(L.antitruncPanelState({ guardBlocked: true }).message,
        '防截断不生效：检测到 网关放弃集字段。');
    assert.equal(L.antitruncPanelState({}).state, '未生成');
    assert.equal(L.antitruncPanelState(null).state, '未生成');

    // 守卫文案按 reason 显示具体字段（评审 I）。
    const guarded = L.antitruncPanelState({ guardBlocked: true, guardReason: 'antitrunc_guard_tools' });
    assert.equal(guarded.message, '防截断不生效：检测到 tools（工具）。');
    assert.equal(L.antitruncPanelState({
        guardBlocked: true, guardReason: 'antitrunc_guard_messages',
    }).message, '防截断不生效：检测到 messages（消息）缺失或为空。');
    assert.equal(L.antitruncPanelState({
        guardBlocked: true, guardReason: 'antitrunc_guard_n',
    }).message, '防截断不生效：检测到 n（候选数）不为 1。');
    assert.equal(L.antitruncPanelState({
        guardBlocked: true, guardReason: 'antitrunc_guard_function_call',
    }).message, '防截断不生效：检测到 function_call（函数调用）。');

    // 优先级：守卫 > 失败 > 过期 > 有效 > 未生成。
    assert.equal(L.antitruncPanelState({
        guardBlocked: true, generationFailed: true, fingerprintExpired: true, cacheHit: true,
    }).state, '守卫警告');
    assert.equal(L.antitruncPanelState({
        generationFailed: true, fingerprintExpired: true, cacheHit: true,
    }).state, '生成失败');
    assert.equal(L.antitruncPanelState({ fingerprintExpired: true, cacheHit: true }).state, '过期');
});

test('guard message names the exact blocked field for every reason', () => {
    const expectations = {
        'antitrunc_guard_tools': 'tools（工具）',
        'antitrunc_guard_functions': 'functions（函数）',
        'antitrunc_guard_function_call': 'function_call（函数调用）',
        'antitrunc_guard_response_format': 'response_format（输出格式）',
        'antitrunc_guard_json_schema': 'json_schema（结构化输出映射到 response_format）',
        'antitrunc_guard_n': 'n（候选数）不为 1',
        'antitrunc_guard_messages': 'messages（消息）缺失或为空',
    };
    for (const [reason, label] of Object.entries(expectations)) {
        assert.equal(L.antitruncGuardMessage(reason), `防截断不生效：检测到 ${label}。`, reason);
        assert.equal(L.antitruncGuardMessage(reason).includes('函数调用开启'), false, reason);
    }
    assert.equal(L.antitruncGuardMessage('antitrunc_settings_invalid'),
        '防截断不生效：请求设置无法识别。');
    assert.equal(L.antitruncGuardMessage('unknown'), '防截断不生效：检测到 网关放弃集字段。');
    assert.equal(L.antitruncGuardField('antitrunc_guard_tools'), 'tools');
    assert.equal(L.antitruncGuardField('nope'), null);
});

test('max_tokens floor is sectionCount * 1200 + 2000', () => {
    assert.equal(L.antitruncFloorTokens(1), 3200);
    assert.equal(L.antitruncFloorTokens(2), 4400);
    assert.equal(L.antitruncFloorTokens(16), 21200);
    for (const value of [0, -1, 1.5, '2', null, undefined]) {
        assert.equal(L.antitruncFloorTokens(value), null);
    }
});

test('gateway custom target gate requires custom source and the fixed https host', () => {
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'https://api.apercus.ai/v1',
    }), true);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'https://api.apercus.ai',
    }), true);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'openai',
        custom_url: 'https://api.apercus.ai/v1',
    }), false);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'https://api.apercus.ai.evil.example/v1',
    }), false);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'http://api.apercus.ai/v1',
    }), false);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'https://api.apercus.ai:8443/v1',
    }), false);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'https://user:pass@api.apercus.ai/v1',
    }), false);
    assert.equal(L.isGatewayCustomTarget({
        chat_completion_source: 'custom',
        custom_url: 'not a url',
    }), false);
    assert.equal(L.isGatewayCustomTarget(null), false);
});

test('cache helpers round-trip by layered fingerprint and prune duplicates', () => {
    const cache = {};
    const layers = { A: 'structural', B: 'content' };
    assert.equal(L.writeAntitruncCacheEntry(cache, 'key-1', {
        sections: SECTIONS,
        layers,
        layeredFingerprint: 'layered-1',
    }), true);
    assert.equal(L.writeAntitruncCacheEntry(cache, 'key-2', {
        sections: ['A', 'B'],
        layers,
        layeredFingerprint: 'layered-1',
    }), true);
    assert.equal(L.pruneAntitruncCache(cache, 'layered-1'), 2);
    assert.deepEqual(cache, {});

    L.writeAntitruncCacheEntry(cache, 'key-1', {
        sections: SECTIONS,
        layers,
        layeredFingerprint: 'layered-1',
    });
    const found = L.findAntitruncCacheEntry(cache, 'layered-1');
    assert.deepEqual(found, {
        key: 'key-1',
        sections: SECTIONS,
        layers,
        layeredFingerprint: 'layered-1',
    });
    found.sections[0] = 'mutated';
    assert.equal(cache['key-1'].sections[0], '开场');
    assert.equal(L.findAntitruncCacheEntry(cache, 'layered-2'), null);
    assert.equal(L.writeAntitruncCacheEntry(cache, 'key-3', {
        sections: ['bad'],
        layers,
        layeredFingerprint: 'layered-3',
    }), false);
});

test('cache limits: at most 3 entries per preset with LRU eviction', () => {
    const cache = {};
    const layers = { A: 'structural' };
    for (let index = 0; index < 4; index += 1) {
        L.writeAntitruncCacheEntry(cache, `p-${index}`, {
            sections: ['A', 'B'],
            layers,
            layeredFingerprint: `layered-p-${index}`,
            presetName: 'Preset P',
            lastUsedAt: 100 + index,
        });
    }
    assert.deepEqual(Object.keys(cache).sort(), ['p-1', 'p-2', 'p-3']);

    // touch 最旧条目后写入新条目：被淘汰的是未 touch 的最旧项。
    assert.equal(L.touchAntitruncCacheEntry(cache, 'p-1', 500), true);
    L.writeAntitruncCacheEntry(cache, 'p-4', {
        sections: ['A', 'B'],
        layers,
        layeredFingerprint: 'layered-p-4',
        presetName: 'Preset P',
        lastUsedAt: 600,
    });
    assert.deepEqual(Object.keys(cache).sort(), ['p-1', 'p-3', 'p-4']);
});

test('cache limits: global cap is 20 entries across presets', () => {
    const cache = {};
    const layers = { A: 'structural' };
    for (let index = 0; index < 21; index += 1) {
        L.writeAntitruncCacheEntry(cache, `g-${index}`, {
            sections: ['A', 'B'],
            layers,
            layeredFingerprint: `layered-g-${index}`,
            presetName: `Preset ${index}`,
            lastUsedAt: 1000 + index,
        });
    }
    const keys = Object.keys(cache);
    assert.equal(keys.length, 20);
    assert.equal(keys.includes('g-0'), false);
    assert.equal(keys.includes('g-20'), true);
});

test('cache limit defaults are exported and can be tightened for tests', () => {
    assert.equal(L.ANTITRUNC_CACHE_MAX_PER_PRESET, 3);
    assert.equal(L.ANTITRUNC_CACHE_MAX_GLOBAL, 20);
    const cache = {};
    const layers = { A: 'structural' };
    for (let index = 0; index < 3; index += 1) {
        L.writeAntitruncCacheEntry(cache, `t-${index}`, {
            sections: ['A', 'B'],
            layers,
            layeredFingerprint: `layered-t-${index}`,
            presetName: 'Tight',
            lastUsedAt: index,
        }, { maxPerPreset: 2, maxGlobal: 20 });
    }
    assert.deepEqual(Object.keys(cache).sort(), ['t-1', 't-2']);
});

test('merge runs guards on the idempotent same-name-key branch too (F6)', async () => {
    const already = JSON.stringify({
        keep: 'me',
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: SECTIONS,
    });
    const cases = [
        // 幂等同名键分支同样检查合并后对象的放弃集字段。
        [{ ...JSON.parse(already), tools: [] }, 'antitrunc_guard_tools'],
        [{ ...JSON.parse(already), functions: [] }, 'antitrunc_guard_functions'],
        [{ ...JSON.parse(already), n: 2 }, 'antitrunc_guard_n'],
        [{ ...JSON.parse(already), n: '1' }, 'antitrunc_guard_n'],
        [{ ...JSON.parse(already), messages: [] }, 'antitrunc_guard_messages'],
        [{ ...JSON.parse(already), messages: 'nope' }, 'antitrunc_guard_messages'],
    ];
    for (const [parsed, reason] of cases) {
        const body = JSON.stringify(parsed);
        const merged = L.mergeAntitruncBody(body, SECTIONS);
        assert.equal(merged.ok, false, body);
        assert.equal(merged.skipped, true, body);
        assert.equal(merged.reason, reason, body);
        assert.equal(merged.body, body, body);
    }

    // 幂等分支守卫通过：原样放行，不重写用户格式。
    const clean = JSON.stringify({
        temperature: 0.9,
        [L.ANTITRUNC_BODY_FLAG]: true,
        [L.ANTITRUNC_BODY_SECTIONS]: SECTIONS,
    });
    const ok = L.mergeAntitruncBody(clean, SECTIONS);
    assert.equal(ok.ok, true);
    assert.equal(ok.body, clean);
});
