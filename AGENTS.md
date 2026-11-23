# AGENTS.md — Apercus SillyTavern 插件

本仓库是 Apercus Gateway 的 SillyTavern UI 扩展与服务端插件，当前为**未接通首版**。所有贡献者与 AI agent 遵守以下规则；更具体的流程以本文件为准。

## 当前范围（硬边界）

1. **统一 Pass**：Pass 是未来唯一的身份权威。登录、账户绑定、凭据交付只能来自网关侧批准的授权/交付契约（当前＝网关连接契约 v1.35 草稿：官方网页授权＋插件登录凭据；契约文档已合入网关 main，但 **C1 未冻结、授权端点未挂载**——连接与写路径不可达）。
2. **无后端授权就不假装成功**：网关授权/交付契约未落地前，不得实现真实登录、不得返回伪造的成功响应，不得把 501 改写成“已登录”，不得把本地状态展示成已连接。「已授权」与「已连接」分层——已连接只在酒馆报告连接成功后显示；契约交付前不得标记已授权。
3. **不手填 key、不使用共享 key**：不提供手填 key 输入框，不回退共享 key，不把 Pass 身份令牌当作网关 key，不引入任何替代凭据方案。插件只经网关连接契约取回 key；key 列表只查询与选用，不创建 / 删除 / 重置。
4. **无 raw key 持久化**：浏览器不写 localStorage/sessionStorage，不保存或回显原始 key、Authorization、Cookie 或上游凭据；服务端仅可把网关连接契约（v1.35 草稿）取得的 key 与插件登录凭据写入 ST 服务端 secret 的两个命名空间——`apercus_gateway`（信封 `{"version":1,"login_credential","key","username"}`，可选 `custom_keys` 归属列表 ≤8）与 `api_key_custom`（ST Custom 源读取的原始 key；**仅在用户确认接入 Custom 源时**按 ST 原生保存路径写入——已按 ST 1.17.0 源码实证：`SECRET_KEYS.CUSTOM` / 前端 `writeSecret` 同路径、服务端 secrets.json、浏览器零持久化）——不写其他 secret，两者写入均 fail-closed（写失败不标记已授权），不持久化原始请求头/请求体/上游错误正文。契约冻结前连接端点不存在，写路径不可达（本仓 stub 验收不改变该事实）。
5. **无 updater / download loader**：本阶段不实现自动更新或下载安装器。
6. **node tests**：测试使用 `node --test`，只依赖 Node 原生能力（Node >= 20），不引入 npm 运行时依赖。测试使用隔离 stub/fixture，不代表真实 Pass 或真实 SillyTavern 验收。
7. **未批准不得生产使用**：在网关连接契约通过批准、C2/C3 交付且 C1 冻结前，本插件不得用于生产环境。部署前置分开两条：① **多用户隔离**仅在 ST `enableUserAccounts: true` 下成立（反向代理认证只产生单一 principal，不能替代 ST 用户边界）；② **DNS rebinding / 宿主防护**须 `hostWhitelist` 开启并列出实际 host，或置于认证反代之后。多用户部署需同时满足 ①，并满足 ② 之一。默认单用户 ST（`enableUserAccounts: false`、`hostWhitelist` 关闭）下，本机不可信网页可经 DNS rebinding 绕过插件同源闸——「可信本机」不含本机浏览器中的不可信网页。插件自身另有 Host 允许清单兜底：默认仅 loopback 字面量，非 loopback 部署须经 `APERCUS_ALLOWED_HOSTS` 显式放行；该清单不是 ST `hostWhitelist`/认证反代的替代。
8. **不记录虚假支持版本**：只写实际核对过的版本。当前对照 SillyTavern 1.17.0 源码核对，并在本地 1.17.0 实例完成安装加载与 UI 冒烟（**冒烟不是验收**，未做真网关联调）；不得宣称支持 1.19.0 或其他未实测版本。

## 固定目标

服务端只访问两类编译期常量目标（两个 host），禁止请求方覆盖：

- 数据面 host `https://api.apercus.ai`：`/v1/chat/completions`（B2 规划转发，Bearer 当前 key）
- 网关 host `https://gw.apercus.ai`：`/api/connect/*`（连接授权：发起 / 轮询）、`/api/plugin/*`（查询面七端点（含退出登录））

身份只取 SillyTavern 注入的当前用户目录（`req.user.directories`），不读请求体/查询参数/请求头里的 user id，也不回落到默认用户或共享凭据。

## 目录与安装

- `ui/`：SillyTavern UI 扩展（`manifest.json`、`index.js`、`logic.mjs`、`style.css`）。
- `server/`：SillyTavern 服务端插件（`index.js`、`core.js`、`package.json`），路由挂载在 `/api/plugins/apercus-gateway`。
- `test/`：`node:test` 测试。
- 安装由用户手动完成：UI 复制到 `<ST>/data/<handle>/extensions/apercus-gateway/`；server 复制到 `<ST>/plugins/apercus-gateway/`，并由用户设置 `enableServerPlugins: true` 后重启。agent 不得修改用户的 SillyTavern 安装或配置。
- 本仓库根不是 UI 扩展仓库：`manifest.json` 在 `ui/` 下，不能直接用仓库根 URL 安装 UI 扩展。

## 协议声明

原生适配尚未落地。`chat` 是唯一候选协议面；`anthropic` 没有安全适配，保持禁用；`responses` 仅声明、未启用，responses-only 模型禁用。不得把目录展示或状态 200 解释为可连接。

## 校验

```bash
node --test
npm run check
```

`npm run check` 覆盖服务端与测试文件的 CommonJS 语法、`ui/logic.mjs` 以及 `ui/index.js` 的 ESM 语法。提交前两者都应通过；测试通过不等于实机验收。

## 变更纪律

- 不提交、不推送、不部署，除非用户明确要求。
- 不修改现有 SillyTavern 安装、用户配置或其他扩展。
- API 契约以 Apercus Gateway 仓库的 `docs/api/api.md` 为准；不得单方面新增字段、错误码或权限。
