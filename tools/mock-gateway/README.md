# Local mock gateway (test only)

`server.mjs` 是 v1.35 ST 插件契约的**本地假网关**，用来在独立 SillyTavern 测试实例里跑通真实 HTTP 链路：发起连接 → 打开授权页 → 批准 → 轮询领取 → 查询 key/模型/额度 → 模型接入 → B2 `/plan` → 退出登录。

它不是网关实现，也不是契约验收，不接受/不输出真实凭据，**不得部署到生产**。

## 使用

1. 启动 mock（默认 9100，仅 loopback）：

   ```bash
   node tools/mock-gateway/server.mjs
   # 或 MOCK_GATEWAY_PORT=9100 node tools/mock-gateway/server.mjs
   ```

2. 把**测试实例**的部署副本指向 mock（只改部署目录，仓库固定 host 不变）：

   ```bash
   node tools/mock-gateway/patch-test-instance.mjs \
     --server <ST>/plugins/apercus-gateway \
     --ui <ST>/data/<user>/extensions/apercus-gateway \
     --base http://127.0.0.1:9100
   ```

   只接受 loopback + http；脚本会校验源码锚点存在，避免静默漏改。

3. 重启 SillyTavern（服务端插件模块需要重新加载）。

4. 在酒馆扩展面板点「连接 Apercus」；浏览器会打开本地 mock 授权页，点「允许」，插件轮询后应显示已授权。之后可刷新 Key 列表/模型/额度、选择模型、生成节名单、退出登录。

5. 测完恢复真实 host 部署副本，并重启 ST：

   ```bash
   node tools/mock-gateway/patch-test-instance.mjs --restore \
     --server <ST>/plugins/apercus-gateway \
     --ui <ST>/data/<user>/extensions/apercus-gateway
   ```

## 覆盖与边界

- 覆盖：连接请求/轮询/批准/取消、单凭据查询面（`me`、`keys`、`key`、`models`、`balance`、`usage`、`logout`）、revoke-all、cap=1 撤旧、数据面 `/v1/chat/completions`（按提示词返回 sections/layers 假结果）。
- 不覆盖：真实 Pass/门户会话、真实 key、真实目录/计费、C1 冻结后的字段语义、C2/C3 的并发/审计/迁移、ST 数据面生成（mock 只服务插件 `/plan`）。
- 测试检查了 `node --test` mock 契约用例；实机结果只能证明插件在假网关下可走通，**不能替代真实网关联调**。
- mock 只生成随机假 key 与假登录凭据，不读取 `MOCK_GATEWAY_KEY` / 不接受真实 key；不要把真实凭据放进 mock 或测试实例。
- `patch-test-instance.mjs` 只接受 loopback `--base`（`localhost` 会规范化为 `127.0.0.1`），并拒绝把部署目标指向本仓库内部。
