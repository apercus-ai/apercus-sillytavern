'use strict';

// Apercus SillyTavern 服务端插件入口（CommonJS）。
//
// 已核实的 ST 生命周期（F:/SillyTavern/src/plugin-loader.js）：
//   - 目录插件读取 package.json.main，或 index.js/index.cjs/index.mjs；
//   - 模块须导出 info{id,name,description} 与 init(router)；
//   - init 收到的 router 最终挂载在 /api/plugins/<id>；
//   - 可选 exit()，本插件不需要。
// server-main.js 在认证中间件与 CSRF 之后、启动监听之前调用 loadPlugins；
// server.js:11 先 process.chdir(serverDirectory)，故 process.cwd() 即 ST 根。
//
// B1 连接边界（v3 网页授权，网关契约 v1.35 草稿）：网关 key 与插件登录凭据
// 只能来自网关连接契约（POST /api/connect/requests → 官方授权页批准 →
// POST /api/connect/requests/poll 恰一次领取 {login_credential, key, username}），
// 经 secrets-binding 适配器写入 ST 密钥库命名空间 apercus_gateway（信封
// {"version":1,"login_credential","key","username"}）。B3 起 connect/refresh 只写
// 信封；ST Custom 源读取的 api_key_custom 只在用户于模型选择确认弹窗确认后，
// 由 POST /apply-model 写入。logout 与查询面 401 仍清两命名空间。除此之外不写
// 任何 secret，不读共享 key、不接触 Passtoken，也不把 ST 外部 secret 当作用户
// 网关 key。该命名空间故意不加入 SECRET_KEYS 的公共提供商组。polling_secret /
// request_ref 只存服务端内存，绝不出服务端；登录凭据与 key 不进浏览器存储 /
// DOM / 日志。密钥库导入/读写任何失败都按未连接处理（fail-closed）。
// 「已授权」不等于「已连接」：酒馆侧连接只由酒馆自身结果表示。

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createCore, BINDING_SECRET_KEY } = require('./core');
const { createSecretBindingAdapter } = require('./secrets-binding');
const { createGatewayClient } = require('./gateway-client');

const info = Object.freeze({
    id: 'apercus-gateway',
    name: 'Apercus Gateway',
    description: 'Apercus 网关网页连接（v1.35 草稿存根）、查询面 key/模型/余额透传与防截断分节规划转发',
});

// 定位并校验既有 ST secrets 模块。失败即抛错，由 loader 记录并拒绝挂载路由。
async function loadStSecretsModule() {
    const stRoot = process.cwd();
    const packageFile = path.join(stRoot, 'package.json');
    const secretsFile = path.join(stRoot, 'src', 'endpoints', 'secrets.js');

    if (!fs.existsSync(packageFile) || !fs.existsSync(secretsFile)) {
        throw new Error('Apercus 插件：未能在 loader cwd 定位 SillyTavern 根目录');
    }

    const secrets = await import(pathToFileURL(secretsFile).href);
    if (typeof secrets.readSecret !== 'function') {
        throw new Error('Apercus 插件：ST secrets 模块缺少 readSecret');
    }
    if (!secrets.SECRET_KEYS || typeof secrets.SECRET_KEYS !== 'object') {
        throw new Error('Apercus 插件：ST secrets 模块缺少 SECRET_KEYS');
    }
    if (Object.values(secrets.SECRET_KEYS).includes(BINDING_SECRET_KEY)) {
        throw new Error('Apercus 插件：专用绑定命名空间不得并入公共提供商组');
    }
    return true;
}

// F1 部署配置：默认只允许 loopback Host（localhost / 127.0.0.1 / ::1）。
// 反代或自定义域名部署必须设置 APERCUS_ALLOWED_HOSTS（逗号分隔的精确 host，
// 可带端口；按 hostname 比较），否则插件路由会 403 host_not_allowed。ST 的
// hostWhitelist 建议同时开启并列出同一 host（插件这层是默认 deny-by-host 兜底，
// 不替代 ST 的宿主防护）。
function readAllowedHosts() {
    const raw = process.env.APERCUS_ALLOWED_HOSTS;
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

async function init(router) {
    await loadStSecretsModule();

    // 连接记录读写走 ST secrets 模块适配器（SecretManager 内部模块，未文档化
    // API，ST 升级回归点）：导入/读/写失败一律降级为未连接（readBinding 恒
    // null、写入恒 false），绝不抛出到路由层。每请求只接收 ST 注入的
    // req.user.directories，绝不回落到默认用户。
    const bindingAdapter = createSecretBindingAdapter({ stRoot: process.cwd() });
    const gatewayClient = createGatewayClient({ fetchImpl: globalThis.fetch });

    const core = createCore({
        readBinding: bindingAdapter.readBinding,
        readBindingState: bindingAdapter.readBindingState,
        writeBinding: bindingAdapter.writeBinding,
        clearBinding: bindingAdapter.clearBinding,
        refreshKey: bindingAdapter.refreshKey,
        writeCustomSourceKey: bindingAdapter.writeCustomSourceKey,
        clearCustomSourceKey: bindingAdapter.clearCustomSourceKey,
        hasCustomSourceEntries: bindingAdapter.hasCustomSourceEntries,
        retryCustomSync: bindingAdapter.retryCustomSync,
        allowedHosts: readAllowedHosts(),
        gatewayClient,
    });
    core.registerRoutes(router);
}

module.exports = { info, init };
