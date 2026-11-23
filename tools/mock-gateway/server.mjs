// Local mock of the Apercus gateway v1.35 ST-plugin contract.
//
// Scope: enough of /api/connect/*, /api/plugin/* and the /v1 data plane to
// exercise the plugin's real HTTP code paths in a local SillyTavern instance.
// It is NOT a gateway implementation and must never be deployed or treated as
// acceptance. It only generates fake credentials; real keys are never accepted.

import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 9100;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
// The plugin accepts a /plan body up to 64KiB, then wraps it with model
// messages/temperature/max_tokens. The forwarded data-plane body is therefore
// slightly larger than 64KiB; the mock accepts it.
const MAX_FORWARD_BODY_BYTES = 128 * 1024;
const CONNECT_TTL_MS = 15 * 60 * 1000;
const CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME = 'mock-user';

function now() { return Date.now(); }

function token(bytes = 24) {
    return randomBytes(bytes).toString('hex');
}

function makeState() {
    return {
        key: `sk-mock-${token(16)}`,
        requests: new Map(),          // request_ref -> request
        requestsByPoll: new Map(),    // polling_secret -> request
        credentials: new Map(),       // login_credential -> credential
        activeCredentialByUser: new Map(),
    };
}

function createMockGateway(options = {}) {
    const state = options.state || makeState();
    const port = options.port === undefined ? DEFAULT_PORT : options.port;
    let server = null;
    let actualPort = port;

    function baseUrl() {
        return `http://${HOST}:${actualPort}`;
    }

    function sendJson(res, status, payload, extraHeaders = {}) {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...extraHeaders,
        });
        res.end(body);
    }

    function sendHtml(res, status, body) {
        res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
        });
        res.end(body);
    }

    function sendEmpty(res, status) {
        res.writeHead(status, {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        });
        res.end();
    }

    function error(res, status, code, message) {
        sendJson(res, status, { error: { code, message } });
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function readBody(req, limit = MAX_BODY_BYTES) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    reject(new Error('body_too_large'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (raw.length === 0) return resolve({ raw: '', json: null });
                const type = String(req.headers['content-type'] || '');
                if (type.includes('application/x-www-form-urlencoded')) {
                    return resolve({ raw, form: new URLSearchParams(raw) });
                }
                try {
                    return resolve({ raw, json: JSON.parse(raw) });
                } catch {
                    return reject(new Error('invalid_json'));
                }
            });
            req.on('error', reject);
        });
    }

    function bearerCredential(req) {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const value = header.slice('Bearer '.length).trim();
        const credential = state.credentials.get(value);
        if (!credential || credential.revoked) return null;
        if (credential.expiresAtMs <= now()) return null;
        return credential;
    }

    function approveRequest(request) {
        if (request.cancelled || request.consumed || request.approved) return false;
        if (request.expiresAtMs <= now()) return false;
        // cap=1: a new delivery revokes the previous active credential.
        const previous = state.activeCredentialByUser.get(USERNAME);
        if (previous) {
            const old = state.credentials.get(previous);
            if (old) old.revoked = true;
        }
        const credentialValue = `cred_${token(24)}`;
        const credential = {
            value: credentialValue,
            username: USERNAME,
            key: state.key,
            createdAtMs: now(),
            expiresAtMs: now() + CREDENTIAL_TTL_MS,
            revoked: false,
        };
        state.credentials.set(credentialValue, credential);
        state.activeCredentialByUser.set(USERNAME, credentialValue);
        request.approved = true;
        request.credentialValue = credentialValue;
        return true;
    }

    function renderAuthorizePage(request) {
        const ref = escapeHtml(request.requestRef);
        return `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>Apercus mock 授权页</title>
<body style="font-family:system-ui;max-width:36rem;margin:2rem auto;line-height:1.6">
<h1>Apercus Gateway 本地 mock 授权</h1>
<p>这是本地测试用假授权页，不会连接真实网关，也不会交付真实 key。</p>
<p><strong>如果你没有刚在酒馆里点“连接 Apercus”，不要批准任何授权页。</strong></p>
<form method="post" action="/portal/authorize/approve" style="display:inline">
<input type="hidden" name="request_ref" value="${ref}">
<button type="submit">允许</button>
</form>
<form method="post" action="/portal/authorize/cancel" style="display:inline">
<input type="hidden" name="request_ref" value="${ref}">
<button type="submit">取消</button>
</form>
</body></html>`;
    }

    function planContent(body) {
        const text = Array.isArray(body && body.messages)
            ? body.messages.map((message) => {
                if (!message || typeof message.content !== 'string') return '';
                return message.content;
            }).join('\n')
            : '';
        if (text.includes('你是分节配置器')) {
            return JSON.stringify({ sections: ['开场', '推进', '收束'] });
        }
        if (text.includes('你是分类器')) {
            return JSON.stringify({
                layers: { 0: 'content', 1: 'structural', 2: 'content' },
            });
        }
        return 'MOCK_OK';
    }

    async function handle(req, res) {
        const url = new URL(req.url, baseUrl());
        const pathName = url.pathname;

        if (req.method === 'GET' && pathName === '/health') {
            return sendJson(res, 200, { status: 'ok' });
        }

        // ---- connect domain ----
        if (req.method === 'POST' && pathName === '/api/connect/requests') {
            let body;
            try {
                body = await readBody(req);
            } catch {
                return error(res, 422, 'invalid_request', '请求体必须是 JSON 对象');
            }
            if (!body.json || typeof body.json !== 'object' || Array.isArray(body.json)) {
                return error(res, 422, 'invalid_request', '请求体必须是 JSON 对象');
            }
            const requestRef = `req_${token(16)}`;
            const pollingSecret = `poll_${token(24)}`;
            const request = {
                requestRef,
                pollingSecret,
                createdAtMs: now(),
                expiresAtMs: now() + CONNECT_TTL_MS,
                approved: false,
                consumed: false,
                cancelled: false,
                credentialValue: null,
            };
            state.requests.set(requestRef, request);
            state.requestsByPoll.set(pollingSecret, request);
            return sendJson(res, 200, {
                request_ref: requestRef,
                polling_secret: pollingSecret,
                authorize_url: `${baseUrl()}/portal/authorize?request_ref=${encodeURIComponent(requestRef)}`,
                expires_at: new Date(request.expiresAtMs).toISOString(),
            });
        }

        if (req.method === 'POST' && pathName === '/api/connect/requests/poll') {
            let body;
            try {
                body = await readBody(req);
            } catch {
                return error(res, 422, 'invalid_request', '请求体必须是 JSON 对象');
            }
            const pollingSecret = body.json && body.json.polling_secret;
            if (typeof pollingSecret !== 'string') {
                return error(res, 422, 'invalid_request', '缺少 polling_secret');
            }
            const request = state.requestsByPoll.get(pollingSecret);
            if (!request
                || request.consumed
                || request.cancelled
                || request.expiresAtMs <= now()) {
                return error(res, 404, 'connect_request_not_found', '连接请求不存在或已失效');
            }
            if (!request.approved) {
                return sendJson(res, 200, { status: 'pending' });
            }
            const credential = state.credentials.get(request.credentialValue);
            if (!credential || credential.revoked) {
                return error(res, 404, 'connect_request_not_found', '连接请求不存在或已失效');
            }
            request.consumed = true;
            return sendJson(res, 200, {
                status: 'approved',
                connect: {
                    login_credential: credential.value,
                    key: credential.key,
                    username: credential.username,
                },
            });
        }

        if (req.method === 'GET' && pathName === '/portal/authorize') {
            const ref = url.searchParams.get('request_ref') || '';
            const request = state.requests.get(ref);
            if (!request || request.cancelled || request.consumed || request.expiresAtMs <= now()) {
                return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>连接请求不存在或已失效。</p>');
            }
            return sendHtml(res, 200, renderAuthorizePage(request));
        }

        if (req.method === 'POST'
            && (pathName === '/portal/authorize/approve' || pathName === '/portal/authorize/cancel')) {
            let body;
            try {
                body = await readBody(req);
            } catch {
                return sendHtml(res, 422, '<!doctype html><meta charset="utf-8"><p>请求体无效。</p>');
            }
            const ref = (body.form && body.form.get('request_ref'))
                || (body.json && body.json.request_ref)
                || '';
            const request = state.requests.get(ref);
            if (!request || request.expiresAtMs <= now()) {
                return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>连接请求不存在或已失效。</p>');
            }
            if (pathName.endsWith('/approve')) {
                // 契约：未知/已批准/已过期/并发抢批 → 404 connect_request_not_found。
                if (request.approved || request.cancelled || request.consumed) {
                    return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>连接请求不存在或已失效。</p>');
                }
                if (!approveRequest(request)) {
                    return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>连接请求不存在或已失效。</p>');
                }
                return sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><p>本地 mock：已允许。可以关闭此页面。</p>');
            }
            // 契约：取消只删除无主且未过期请求；已批准/已消费/重复取消 → 404。
            if (request.approved || request.cancelled || request.consumed) {
                return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>连接请求不存在或已失效。</p>');
            }
            request.cancelled = true;
            return sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><p>本地 mock：已取消。</p>');
        }

        if (req.method === 'POST' && pathName === '/api/portal/me/plugin-credentials/revoke-all') {
            for (const credential of state.credentials.values()) credential.revoked = true;
            state.activeCredentialByUser.clear();
            return sendEmpty(res, 204);
        }

        // ---- plugin query domain ----
        if (pathName.startsWith('/api/plugin/')) {
            const credential = bearerCredential(req);
            if (!credential) {
                return error(res, 401, 'unauthorized', '插件登录凭据无效或已失效');
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me') {
                return sendJson(res, 200, { username: credential.username });
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me/keys') {
                return sendJson(res, 200, {
                    keys: [{
                        id: 'key_1',
                        name: '默认 key',
                        masked: 'sk-****mock',
                        status: 'enabled',
                    }],
                });
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me/key') {
                return sendJson(res, 200, { key: credential.key, username: credential.username });
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me/models') {
                return sendJson(res, 200, {
                    object: 'list',
                    data: [
                        { id: 'deepseek-v4.1-flash', object: 'model', protocol_faces: ['chat'] },
                        { id: 'mock-chat-a', object: 'model', protocol_faces: ['chat'] },
                        { id: 'mock-chat-b', object: 'model', protocol_faces: ['chat'] },
                        { id: 'mock-responses-only', object: 'model', protocol_faces: ['responses'] },
                    ],
                });
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me/balance') {
                return sendJson(res, 200, {
                    permanent_balance: '100.000000',
                    debt: '0.000000',
                    daily_quota: '50.000000',
                    daily_quota_used: '1.500000',
                    daily_quota_remaining: '48.500000',
                    quota_date: new Date().toISOString().slice(0, 10),
                    needs_refresh: false,
                    observed_at: new Date().toISOString(),
                    penalty_input_threshold: '20000',
                    penalty_multiplier: '2500',
                });
            }
            if (req.method === 'GET' && pathName === '/api/plugin/me/usage') {
                return sendJson(res, 200, { usage: [] });
            }
            if (req.method === 'POST' && pathName === '/api/plugin/logout') {
                credential.revoked = true;
                if (state.activeCredentialByUser.get(credential.username) === credential.value) {
                    state.activeCredentialByUser.delete(credential.username);
                }
                return sendEmpty(res, 204);
            }
            return error(res, 404, 'not_found', '未知端点');
        }

        // ---- data plane (only for /plan and optional chat smoke) ----
        if (req.method === 'POST' && pathName === '/v1/chat/completions') {
            const header = req.headers.authorization;
            if (typeof header !== 'string' || header !== `Bearer ${state.key}`) {
                return error(res, 401, 'invalid_key', 'key 无效');
            }
            let body;
            try {
                body = await readBody(req, MAX_FORWARD_BODY_BYTES);
            } catch {
                return error(res, 422, 'invalid_request', '请求体无效');
            }
            const content = planContent(body.json);
            return sendJson(res, 200, {
                id: `chatcmpl-mock-${randomUUID()}`,
                object: 'chat.completion',
                created: Math.floor(now() / 1000),
                model: (body.json && body.json.model) || 'mock-chat-a',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
        }

        return error(res, 404, 'not_found', '未知端点');
    }

    function close() {
        return new Promise((resolve) => {
            if (!server) return resolve();
            server.close(() => resolve());
        });
    }

    async function start() {
        server = http.createServer((req, res) => {
            Promise.resolve(handle(req, res)).catch(() => {
                if (!res.headersSent) error(res, 500, 'internal_error', 'mock 内部错误');
            });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, HOST, () => {
                actualPort = server.address().port;
                resolve();
            });
        });
        return { server, port: actualPort, state, close };
    }

    return { start, state, close };
}

export { createMockGateway, makeState };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const portArg = Number(process.env.MOCK_GATEWAY_PORT || DEFAULT_PORT);
    const gateway = createMockGateway({ port: portArg });
    gateway.start().then(({ port }) => {
        // Only lifecycle info; never log request bodies or credentials.
        console.log(`mock gateway listening on http://${HOST}:${port}`);
    }).catch((error) => {
        console.error('mock gateway failed to start:', error.message);
        process.exitCode = 1;
    });
}
