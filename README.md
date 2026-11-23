# Apercus SillyTavern 插件（未接通首版）

本仓库是 Apercus Gateway 面向 SillyTavern 的独立插件项目，当前是**可安装的基础骨架**，不是已登录、可用的网关客户端。

网关连接契约设计稿（v1.35：免输码官方网页授权＋插件登录凭据）**文档已合入网关 main（2026-11-19）**，但 **C1 尚未冻结**（留决③④⑤⑥⑦ 未闭）、**C2 后端与 C3 授权页未交付**；插件侧 P0–P3 已按 v3 设计在本地实现（stub 验收，未接真网关），P4 联调发布等待上述条件。当前真实网关连接、模型/余额取数仍 **blocked（未接通）**；界面如实显示未连接状态，不会伪装成功，也不会在浏览器侧保存任何原始 key。

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 插件安装 | 可安装 | UI 扩展与服务端插件均可手动复制安装，见下文 |
| 状态接口 | 可用 | `GET /api/plugins/apercus-gateway/status`：`not_connected / pending / authorized / invalid` 四态；`connected: false` 恒固定；`st_connection` 服务端恒 `unknown`，UI 另以 ST `onlineStatus` 派生酒馆侧显示 |
| 网关连接（v3） | 未接通 | 免输码网页授权流程已实现（stub 验收）；C1 未冻结、网关 C2/C3 未交付，授权端点未挂载 → `/connect` 502 fail-closed |
| Key 列表 / 退出登录 | 未接通 | `GET /keys` 无登录 409；`POST /logout` 幂等（无绑定也清理本地并返回 200，不报告远端撤销） |
| 模型选择 | 未接通 | `GET /models`（查询面投影）；确认弹窗后写 `custom_url`/`custom_model`（切源需确认） |
| 余额 / 阈值 | 未接通 | `GET /balance`（查询面，H/K 两字段；非法值显示"未知"） |
| 防截断分节（B2） | 已实现（stub） | 规划调用经插件服务端 `/plan`（Bearer 当前 key）；未授权时 409，默认关闭。生成时预设摘要与条目内容会发送到 `api.apercus.ai`（脱敏非穷尽，不是安全控制） |
| 上下文计量 | 已实现（stub） | 发送时/面板打开时估算；上限按 ST 聊天补全设置（1.17.0 口径） |
| Key 保存 / 凭据交付 | 未接通 | 仅经网关连接交付；不提供手填 key、共享 key 或任何替代入口 |
| 原生协议适配 | blocked | 本版没有已核实、已落地的原生适配器；选择模型不代表可连接 |
| 自动更新 / 下载 loader | 未实现 | 本版没有 updater 或下载安装器 |

不要把 `GET /status` 的 200 理解为登录成功：`connected` 恒为 `false`，三个协议面均为 `false`。「已授权」与「已连接」分层——已连接只在酒馆报告连接成功后显示。

### 插件路由（挂载在 `/api/plugins/apercus-gateway`）

`GET /status`、`POST /connect`、`GET /connect/status`、`POST /logout`、`GET /keys`、`GET /models`、`GET /balance`、`POST /plan`、`POST /apply-model`、`POST /release-custom-key`、`POST /login`（骨架，501）。

> 规格草案 §2 计「7 新＋1 改」；实现偏离：另增 `POST /apply-model`（模型接入确认）与 `POST /release-custom-key`（运行时清理插件写入的 Custom 凭据）；`GET /connect/status` 的 pending 响应附加 `write_retry:{attempt,max}`（写入重试态）；`GET /status` 附加 `connect_pending`（独立于 state 表示仍有存活连接请求，用于已授权后重新发起的连接在刷新后恢复轮询）与 invalid 状态的 `local_cleared` / `custom_cleared`（登录失效时信封与 Custom 源的清理结果，UI 据此清空或保留 Custom 设置）；v3 设计已无 `POST /login`，本仓仍保留骨架 501（待删）。以上待 C1 契约评审回写。

## 目录内容

| 路径 | 内容 |
|---|---|
| `ui/` | SillyTavern UI 扩展：`manifest.json`、`index.js`、`logic.mjs`、`style.css` |
| `server/` | SillyTavern 服务端插件：`index.js`、`core.js`、`package.json` |
| `test/` | `node:test` 测试：纯逻辑、固定路由、用户隔离、错误与泄密边界 |
| `LICENSE` | GNU AGPL v3 完整文本 |

UI 与 server 是两套独立安装单元，安装位置不同。

## 安装

以下步骤由 SillyTavern 用户自行执行；本仓库不会改动现有 SillyTavern 安装、用户配置或其他扩展。

### 1. UI 扩展

UI 扩展需要放在 SillyTavern 的用户扩展目录。按本地 SillyTavern 1.17.0 源码核实：

- 磁盘目录：`<SillyTavern>/data/<用户 handle>/extensions/<扩展目录名>`，默认用户为 `data/default-user/extensions/`
- 加载 URL 命名空间：`/scripts/extensions/third-party/<扩展目录名>`
- 全局安装的等价目录是 `<SillyTavern>/public/scripts/extensions/third-party/<扩展目录名>`

因此，把 `ui/` 内的**文件内容**复制到：

```text
<SillyTavern>/data/default-user/extensions/apercus-gateway/
```

多用户部署时，把 `<用户 handle>` 换成目标用户的真实 handle（例如 `data/<handle>/extensions/apercus-gateway/`）。目录名使用 `apercus-gateway`，与插件路由 ID 一致，便于识别。

> 不要用本仓库根 URL 在 SillyTavern 的“安装扩展”里直接克隆。Git 仓库根目录不是 UI 扩展仓库：`manifest.json` 在 `ui/` 子目录下，而 SillyTavern 的扩展安装器要求扩展仓库根目录直接包含 `manifest.json`。后续如需在线安装，应发布独立的 UI 扩展仓库或提供打包产物，而不是当前这个同时包含 `server/` 的仓库根。

### 2. 服务端插件

把 `server/` 内的**文件内容**复制到：

```text
<SillyTavern>/plugins/apercus-gateway/
```

然后在 SillyTavern 的 `config.yaml` 中设置：

```yaml
enableServerPlugins: true
```

保存后重启 SillyTavern。插件加载后路由挂载在 `/api/plugins/apercus-gateway`。这两处配置属于用户自己的 SillyTavern 安装，应由用户本人修改；本仓库不提供自动修改脚本。

## 固定上游与边界

服务端插件只访问两类编译期常量目标（两个 host），不接受请求方传入的 URL、Origin 或目标覆盖：

- 数据面 host `https://api.apercus.ai`：`/v1/chat/completions`（防截断规划转发，Bearer 当前 key）
- 网关 host `https://gw.apercus.ai`：`/api/connect/*`（连接授权：发起 / 轮询）、`/api/plugin/*`（查询面：`/me`、`/me/keys`、`/me/key`、`/me/models`、`/me/balance`、`/me/usage`、`/logout`）。当前插件消费 `/me/keys`、`/me/key`、`/me/models`、`/me/balance`、`/logout`；`/me` 与 `/me/usage` 未消费（usage 字段清单待 C1 冻结后接入）。

目录、余额与规划请求只使用当前 SillyTavern 用户的服务器端连接，不回落到默认用户；未连接时返回 `409 not_connected`。浏览器不保存原始 key、不读取共享 key、不显示 `Authorization`；服务端只把连接契约取得的 key 与登录凭据写入两个专用 secret 命名空间（见下）。

**防截断的披露与互斥**：

- 生成节名单会把预设内容发送到 `api.apercus.ai`：调用一发送摘要（截断 ≤16000 字符），调用二再发送全部条目（含已关闭）的名称与内容（预算 ≤16000 字符）。脱敏只覆盖常见密钥形态（字段名过滤 + `sk-` / `Bearer` / `key=` 等值模式），**不是安全控制**，不保证清除全部敏感内容。
- 防截断开关打开时，编辑预设可能触发自动重分层调用（消耗额度）；两次调用共用一个模型选择。
- 与 S喵 等社区防截断注入脚本**互斥使用**（同类注入会互相覆盖/冲突）。
- **B2 依赖 WebCrypto 安全上下文**（`https` 或 `localhost`）：局域网明文 `http://192.168.x.x` 直连时 `crypto.subtle` 不可用，B2 功能整体禁用（面板不渲染），属部署前置而非缺陷。
- `custom_include_body` 为空串时视为"无用户字段"并写入插件两键（首次注入的必要条件，与规格草案字面"空串不写入"的偏离已登记）；非法 JSON 不写入；用户同名键优先。

### 网关连接（v3，未接通）

Pass 是未来唯一的身份权威。网关连接契约（v1.35 草稿）采用**免输码官方网页授权**：

- 面板「连接 Apercus」→ 插件服务端匿名发起连接请求 → 浏览器打开网关官方授权页（复用门户登录状态）→ 用户点「允许」→ 插件服务端后台轮询领取；无人工输码、无核对码；
- 领取交付两件套：插件登录凭据（`login_credential`）＋当前用户 key；保存到 ST 服务端 secret 的两个命名空间——`apercus_gateway`（信封 `{"version":1,"login_credential","key","username"}`，插件服务端直写；可含可选 `custom_keys` 归属列表 ≤8，用于只清理插件写入的 Custom 条目）与 `api_key_custom`（ST Custom 源读取的原始 key；**仅在用户确认接入 Custom 源时**按 ST 原生保存路径写入）。已按 ST 1.17.0 源码实证：`SECRET_KEYS.CUSTOM` 与前端 `writeSecret` 同路径、落服务端 secrets.json、浏览器零持久化（`allowKeysExposure` 开启时 ST 自带的 `/api/secrets/view` 可回显，属 ST 既有生态面）；两者写入均 fail-closed；
- 同一账号同时只保留一个插件登录：在另一设备/实例重新连接会撤销旧登录；
- 登录凭据 TTL＝滑动 7 天＋**绝对上限 30 天**（到期需重新网页授权）；网关 key 重置不断开连接——插件在 `/plan` 遇数据面 401 或周期性探活时凭登录凭据刷新 key，并同步更新插件写入的 Custom 源 key（用户自有的 Custom 凭据不动）；
- 断开：插件「退出登录」（仅撤销本次登录）或门户「退出所有酒馆插件」（撤销该账号全部插件登录凭据）；不改门户会话与 key；插件退出/登录失效时只清除**自己写入**的两个命名空间条目。

**授权端点尚未挂载（C1 未冻结、C2/C3 未交付）：真实 `/connect` 会 502 fail-closed；本仓实现为 stub 验收（合成 fixture 测试），不代表已接通。契约文档已随 v1.35 合入网关 main。**

**仿冒识别与自改免责**：官方插件**绝不**在自身 UI 内收集账号登录凭据（要求你在插件里输入登录码/密码的均为仿冒）；**如果你没有刚在酒馆里点「连接 Apercus」，不要批准任何弹出来的授权页**——授权页会交付完整账号 key 权限，请从自己发起的入口进入并逐项核对；安装渠道仅限本仓库发布；用户自行修改的版本不在支持与责任范围。

### 部署前置

部署前检查清单另见 [DEPLOYMENT.md](DEPLOYMENT.md)。

- **多用户隔离**：仅在 ST `enableUserAccounts: true` 下成立；反向代理认证只产生单一 principal，不能替代 ST 用户边界。
- **DNS rebinding / 宿主防护**：ST 默认单用户无认证边界且 `hostWhitelist` 默认关闭——「可信本机」不含本机浏览器中的不可信网页；须开启 `hostWhitelist` 并列出实际 host，或置于有认证的反向代理之后。插件自身另有一层 **Host 允许清单**：默认只接受 loopback 字面量（`localhost`/`127.0.0.1`/`::1`），非 loopback 部署须经 `APERCUS_ALLOWED_HOSTS`（逗号分隔精确 host）显式放行。DNS rebinding 一旦绕过同源闸，后果不止“读状态”：可用你的 key 发起模型调用消耗额度并读取输出、经 `/apply-model` 把原始 key 写入 ST 全局 Custom 凭据、再由 ST 自身的 Custom 生成把该 key 发往任意预设 URL，还可强制退出登录。务必按上述前置部署。
- **HTTPS 反代**：插件的写路由做精确同源校验；反向代理终止 TLS 时须设置 `X-Forwarded-Proto: https` 并透传原始 `Host`，否则写路由会 403（fail-closed）。
- **规划请求上限**：`/plan` 请求体上限 64KiB（为容纳 ≤16000 字符 CJK 预设摘要；规格草案的 16KiB 与该摘要上限自相矛盾，按 64KiB 实施并登记）。
- 多用户部署需同时满足上方多用户隔离条件，并满足 DNS rebinding 防护之一。
- **Custom 源凭据提醒**：接入模型后网关 key 会写入当前用户的 `api_key_custom`（ST Custom 源读取的按用户凭据，非全局共享）。若随后切换到 `custom_url` 指向非网关地址的预设/配置，ST 会把该 key 发往该地址（`bind_preset_to_connection` 默认开启）——请勿将网关 key 与第三方端点混用；插件在预设切换与生成前**尽力**清理自己写入的条目，但 ST 自身的 Connect/Test 状态检查、手动编辑 URL、清理失败窗口不在自动清理覆盖内（清理失败即意味着 key 可能已外送）。退出登录/登录失效时只清除自己写入的条目；清理后若 Custom 源 URL 仍指向网关，UI 会清空 Custom URL/模型（不猜旧地址，用户重新选择模型），避免 ST 删除活动条目后重新激活的用户自有 key 继续发往网关；登录失效按服务端 `custom_cleared`：Custom 清理未确认时强制清空 Custom URL，Custom 已清且用户 URL 为第三方地址时保留用户配置（清空落盘未确认时会显式提示）。接入切换窗口内，原先的第三方 Custom key 也可能被短暂发往网关；预设 `custom_include_headers`/`custom_include_body` 中的第三方凭据在切换到网关源时也可能随请求发出，接入前请自行清理。
- **Key 列表**：v1 恒一把 key，列表只读展示（名称/脱敏标识/状态）；多 key 选用交互待 C1 冻结后补。

### 协议声明

UI 状态栏声明 `chat`、`anthropic`、`responses` 三个协议面，但**原生适配没有落地**：

- `chat`：唯一候选协议面；仍需服务端绑定和已核实适配，当前不可连接；
- `anthropic`：不提供安全适配，明确禁用；
- `responses`：仅声明，未启用；responses-only 模型保持禁用；
- 其他协议面（image、tts、embedding、video）不参与连接选择。

未连接网关时 `GET /models` 返回 `409 not_connected`，扩展无法取得目录，因此现在不会展示任何模型条目。连接接通后仍必须实现经过核实的安全协议适配；选择模型不代表可连接，也不会静默修改 SillyTavern 的模型或来源。

## 测试与校验

测试使用 `node:test`，只依赖 Node 原生能力，不需要安装第三方依赖：

```bash
node --test
```

测试全部使用隔离的 stub/fixture（合成绑定、假 fetch、假 ST 路由），**不是真实 Pass 服务，也不是运行中的 SillyTavern**。它们验证映射、状态门禁、固定路由、每用户隔离、错误处理和不泄露凭据等边界，但不构成真实 Pass/ST 验收，也不证明实机可用。

语法检查覆盖 CommonJS 服务端、测试文件、UI 纯逻辑 ESM，以及 `ui/index.js` 的 ESM 解析：

```bash
npm run check
```

`ui/index.js` 在浏览器中由 SillyTavern 作为扩展模块加载；仓库根 `package.json` 不设 `"type": "module"`（测试与服务端插件仍走 CommonJS），因此检查脚本用 `node --input-type=module --check` 读取它的 ESM 语法。

### 本地 mock 联调（仅测试）

`tools/mock-gateway/` 提供 v1.35 连接/查询/数据面的最小本地假网关，用于在**独立 SillyTavern 测试实例**里跑通真实 HTTP 链路（连接 → 授权页 → 批准 → 轮询领取 → key/模型/额度 → 模型接入 → B2 `/plan` → 退出登录）。使用方式见该目录 README。

边界：mock 不是网关实现、不接收真实 key、不得用于生产或真实联调；`patch-test-instance.mjs` 只改部署副本并强制 loopback，仓库内固定 host 常量不变；测完用 `--restore` 恢复。mock 测试通过不等于真实网关验收。

## 版本与安全

- 代码对照本地 SillyTavern **1.17.0** 源码核对（`getContext`、事件名、custom source、secrets、`#leftSendForm`），并在本地 1.17.0 实例完成安装加载与 UI 冒烟；冒烟不是验收，未做真网关联调。**1.19.0 未核对**。本仓库不声明支持未验证的版本。
- 部署前置：多用户隔离需 ST `enableUserAccounts: true`（反代认证不能替代）；DNS rebinding / 宿主防护需 `hostWhitelist` 或认证反代（详见「部署前置」）。不要直接暴露到公网，也不要以此插件替代 SillyTavern 自身的登录保护。
- 插件不解除 Apercus Gateway 的数据面公网暴露闸门；网关部署约束以其仓库的 `docs/runtime-security.md` 为准。
- 在 C1 契约冻结、C2/C3 交付前，本插件**不得用于生产**（授权端点未挂载、联调未完成）。

## 许可

GNU Affero General Public License v3.0，完整文本见 [LICENSE](LICENSE)。
