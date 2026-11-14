# 任务单：ST 插件绑定契约批 + 插件批（两人分工）

- 依据：[plugin-batch.md](plugin-batch.md)（插件批设计稿）、[contract-batch.md](contract-batch.md)（契约批设计稿），均在本目录；契约落地（api.md v1.33）在网关私有仓执行（预取 v1.33，未取号）。
- 分工逻辑：接缝＝C1 契约冻结；人甲只碰网关仓（私有）、人乙只碰本公开仓，零共享文件。
- 前置：本任务单随公开仓 docs PR 评审；签核后开 Linear 票——批A（契约批）入 Apercusgateway 项目，批B（插件批）入 apercus-sillytavern 新项目（Linear 新建，对应本公开仓）；之后每项工作先开分支、走 PR、填 Worklog。

## 人甲（网关侧：Go + 契约文档 + 门户页）

- [ ] **C1 契约 docs PR**（最先飞；contract-in-flight 一次一个）：`docs/api/api.md`（新「绑定」域三操作 + BalanceSnapshot 增列 + 头部 v1.33）、`docs/api/openapi.yaml` 0.11.98、`docs/api-changelog.md` v1.33 行、`docs/term-glossary.md` 词条、`scripts/contract/error-contract.mjs` 重锁、`plan/README.md` 索引登记。
  验收：契约评审门（含留决四项落地）＋ 脚本门禁（plan-refs / comment-hygiene / strict-yaml-validate）。
- [ ] **C2 后端实现 PR**：migration 0053、绑定服务（CSPRNG、独立限频器、CAS、consume-once、key_hash 失效联动、no-store、DTO 脱敏）、BalanceSnapshot 两字段贯通、审批计配审计（用户发起形态）、Go 测试（并发恰一、approve→重置→poll 404、approve→禁用→poll 404）。
  验收：`go test ./internal/store -count=1` 起步；HTTP 回归＝契约批设计稿 §6（本目录 [contract-batch.md](contract-batch.md)，含全部安全断言）；独立 reviewer-1。
- [ ] **C3 门户批准页**：plugin 页面（手动输码、后果全文、比对指令、无自动批准路径）＋ SPA `frame-ancestors 'none'`/`X-Frame-Options: DENY` ＋ 批准路由 `Referrer-Policy: no-referrer`。
  验收：打开页面零副作用断言；无框嵌套测试。
  依赖：与 C2 收尾并行（同一批准端点契约）；C1 必须最先完成。

## 人乙（插件侧：JS + node:test）

- [ ] **P0 插件仓 docs PR**：AGENTS/README"签名绑定记录"前提放宽为 `version:1` 无签名（契约批 D2）。
- [ ] **P1＝B1 绑定**：`POST /pair`、`GET /pair/status`、启用门控、密钥库写入、失效 UX。依赖：C1 字段冻结（开发期合成绑定，不接真网关）。
- [ ] **P2＝B2 防截断**：`PRESET_CHANGED` 检测（仅 chat 预设）、惰性指纹、`POST /plan` 代理、校验与兜底、指纹缓存、注入、工具/响应格式守卫。
- [ ] **P3＝B3 计量**：余额 + 阈值条（BigInt fail-closed，K 仅展示）、上下文计量（单一计量路径）、模型选择（与规划调用共用）。
- [ ] **P4 联调与发布**（门控＝v1.33 合并）：真网关联调（配对全流程 + plan call）、消费方冒烟、发布。
  验收：`pnpm test` 全绿 ＋ `pnpm check`；ST 冒烟清单见 plugin-batch.md §3；独立 reviewer-1。

## 跨人协调点

1. C1 评审中任何字段变更，甲主动同步乙；乙不接受未通知的字段漂移。
2. 门户批准页路由（留决④）由甲在 C1/C3 定稿，乙对齐插件"打开批准页"常量。
3. key 重置失效联动两侧各测：甲测网关断言（contract-batch.md §6），乙测插件失效 UX（plugin-batch.md B1）。
4. 留决四项（批准 step-up / 配对码参数 / K 是否暴露 / 页面文案）在 C1 契约评审中定，结论回写两份设计稿。
