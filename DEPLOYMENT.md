# 部署注意事项（v3 插件批）

本文件是部署前检查清单；条款以 `AGENTS.md` 与 `README.md` 为准。

## 部署顺序

1. **先配置安全前置**（第 2 节）：`enableUserAccounts`、ST `hostWhitelist`、`APERCUS_ALLOWED_HOSTS`、反向代理头。`APERCUS_ALLOWED_HOSTS` 只在插件初始化时读取，必须在启动/重启前设置。
2. 安装 UI 与服务端插件（第 1 节），然后重启 SillyTavern。
3. 通过真实网页授权完成连接（第 0 节门控满足后），再验证状态与查询面。
4. 按第 7 节跑测试/检查；测试通过不等于验收。

## 0. 部署门控（必须先满足）

- **C1 契约已冻结**、**C2 后端已交付**、**C3 授权页已上线**，且真实 `gw.apercus.ai` 的 `/api/connect/*`、`/api/plugin/*` 已挂载。当前真实网关对这些路径返回 404；未满足前不得生产部署。
- 部署后先用真实网页授权走通「连接 → 门户批准 → 插件领取」；`GET /status` 的 200 不代表已登录，`connected` 恒 false，`state=authorized` 也不等于酒馆已连接。

## 1. 安装

- UI：复制 `ui/` 内容到 `<ST>/data/<handle>/extensions/apercus-gateway/`。
- Server：复制 `server/` 内容到 `<ST>/plugins/apercus-gateway/`，并在 `config.yaml` 设置 `enableServerPlugins: true` 后重启。
- 本仓库根不是 UI 扩展仓库，不能用仓库根 URL 直接安装。
- 仅按 SillyTavern **1.17.0** 源码核对并在本地实例冒烟；未核对/未声明支持 1.19.0。

## 2. 安全前置

- **多用户隔离**：仅 `enableUserAccounts: true` 成立；反向代理认证只产生单一 principal，不能替代 ST 用户边界。
- **DNS rebinding / 宿主防护**：开启 ST `hostWhitelist` 并列出实际 host，或置于认证反代之后。默认单用户 + 关闭 hostWhitelist 时，本机不可信网页可尝试绕过同源闸。
- **插件 Host 允许清单**：默认仅 loopback（`localhost`/`127.0.0.1`/`::1`）；非 loopback 部署必须用 `APERCUS_ALLOWED_HOSTS`（逗号分隔精确 host）显式放行。它不是 ST `hostWhitelist` / 认证反代的替代。
- **HTTPS 反代**：写路由做精确同源校验；终止 TLS 的代理需设置 `X-Forwarded-Proto: https` 并透传原始 `Host`，否则写路由 403 fail-closed。

## 3. 固定目标与凭据

- 服务端只访问两个编译期常量 host：`https://api.apercus.ai`（`/v1/chat/completions`）与 `https://gw.apercus.ai`（`/api/connect/*`、`/api/plugin/*`）；请求方不能覆盖。
- 插件只经网关连接契约取回 key；**不提供手填 key、共享 key 或替代凭据**。
- 服务端只写两个 ST secret 命名空间：`apercus_gateway` 与（用户确认接入 Custom 源时）`api_key_custom`；两者 fail-closed，不写其他 secret，不持久化原始请求头/请求体/上游错误正文。
- key 重置后的自动刷新只同步**插件自有**的 Custom 活动值（`custom_keys` ∪ 当前 key），不是新的手填/替代凭据入口；用户自有值不动。
- 浏览器不写 localStorage/sessionStorage，不保存/回显原始 key、Authorization、Cookie。

## 4. Custom 源风险

- 接入模型会把网关 key 写入当前用户的 `api_key_custom`。若随后把 `custom_url` 指向非网关地址（含预设 `bind_preset_to_connection` 默认开启），ST 会把该 key 发往该地址。插件在预设切换/生成前尽力清理，但 ST 自身 Connect/Test、手动改 URL、清理失败窗口不在覆盖内。
- 预设 `custom_include_headers`/`custom_include_body` 中的第三方凭据在切到网关源时也可能随请求发出；接入前自行清理。
- 退出登录/登录失效只清插件写入的条目，不动用户自有 Custom 凭据。
- 清理后若 Custom 源 URL 仍指向网关，UI 会清空 Custom URL/模型（不猜旧地址，用户重新选择模型），避免 ST `deleteSecret` 重新激活的用户自有 key 继续发往网关；清空落盘未确认时会显式提示。
- 登录失效按 `/status` 的 `custom_cleared` 处理：Custom 已清且 URL 指向网关 → 清空；Custom 清理未确认 → 强制清空 Custom URL，避免残留网关 key 外送；Custom 已清且 URL 是用户第三方地址时保留用户配置。
- Custom 清理不确定（`custom_cleared=false`）时持久失效标记保留，页面刷新/其他标签的 `/status` 仍会触发强制清空；`/release-custom-key` 在信封缺失但 Custom 仍有条目时返回 `cleared:false` / `read_failed`，不会宣称已清理。

## 5. B2 防截断

- 默认关闭；开启后生成节名单会把**脱敏后的预设摘要与条目内容**发送到 `api.apercus.ai`。脱敏非穷尽，不是安全控制。
- 两次 `/plan` 调用会消耗额度；与 S喵等社区防截断注入脚本互斥。
- `/plan` 请求体上限 64KiB；规划输出预算 `max_tokens=4096`（推理型模型会把预算先耗在 reasoning 上，600 会返回空 choices）。
- B2 依赖 WebCrypto 安全上下文（https 或 localhost）；局域网明文 http 直连时 B2 禁用。

## 6. 本地 mock（禁止生产）

- `tools/mock-gateway/` 只用于独立 ST 测试实例；不是网关实现、不是契约验收、不接收真实 key。
- `patch-test-instance.mjs` 只改部署副本，强制 loopback，拒绝指向本仓库；测完必须 `--restore` 并重启 ST。
- 不要在测试实例里使用真实 key；需要真实数据面验证时另行安排并轮换凭据。

## 7. 验收

```bash
node --test       # 335 tests, isolated stubs/mock
npm run check
```

测试通过不等于实机验收；仍需真实网关授权、查询、模型接入与 B2 联调。
