# ST 插件绑定交付 + 惩罚阈值暴露契约批（草稿 v2，待签核）

- 状态：三份设计稿（契约批 / 插件批 / 任务单）随公开插件仓 apercus-sillytavern `plan/st-plugin-binding/` docs PR 提交评审；v1.33/0.11.98 未取号（取号随网关侧 C1 契约 PR）。网关侧实现（migration、绑定服务、批准页）在网关私有仓执行。
- 契约版本：预取 **v1.33 / 0.11.98**（v1.31/0.11.96 为 #433 排期预约未实占；v1.32/0.11.97 已随 #443 合入）。
- 下游批：apercus-sillytavern 插件批（设计稿见同目录 [plugin-batch.md](plugin-batch.md)）；契约落地（api.md v1.33 等）仍随网关侧 C1 契约 PR 在私有仓执行。
- 安全：涉及用户 key 出网关（新凭据交付面），按协作规则 9 强制安全评审；本稿已并入 sec 评审两处阻断修复（§2.4 批准页防钓鱼、§2.2 key_hash 失效联动）。
- 关联背景：门户登录正迁移见微通行证（`origin/pass-add`，APE-80，已签核执行）；本契约只依赖"门户已登录会话"，对登录方式（邮箱码 / Pass）不可见，迁移不破坏本契约。

## 0. 背景与目标

apercus-sillytavern（酒馆插件 = ST UI 扩展 + ST 服务端插件）需要：

1. 代表用户持有网关服务 key，调用数据面（`/v1`、`/catalog/models`）与查询面（`/api/user/balance`）。插件仓 AGENTS 明文：绑定交付契约批准前禁止一切登录与 key 录入——本批即该契约。
2. 实现"接近大输入惩罚阈值提醒"，需要用户侧可读 BILL-08 的阈值 H 与倍率 K（当前仅 `GET/PUT /api/admin/settings` 可见）。

非目标：按客户端放行 / 客户端头准入（v0.47 挂账独立批次）；子 key / 作用域 key（D2）；绑定实体列表与管理面（D5）；`/v1` 数据面任何行为变化；数据面公共暴露闸门（runtime-security.md 五项确认）不变。

## 1. 决策记录

- **D1 设备配对（device pairing），不做浏览器回调或插件直连通行证。** 插件服务端发起配对，用户在门户页手动输入用户码并点"批准"，插件服务端轮询取件。理由：插件若挂靠任一登录形态（邮箱码 / Pass RP 跳转）都会被 pass-add 迁移打破；配对批准只依赖门户已登录会话，登录方式对契约不可见；也无 CORS / 跨站 Cookie 问题（插件服务端 ↔ 网关为服务间调用）。
- **D2 绑定承载＝现有用户 key（一把制），不发明子 key，v1 不做签名记录。** key 自证（错 key → 401 `invalid_key`），伪造本地记录只能得到 401，无攻击收益；签名机制留待出现真实威胁时引入。插件仓 AGENTS"签名绑定记录"前提以记录 `version` 字段方式放宽（v1 = 无签名；未来若出现 version:2 签名形态，不得把无签名 v1 视为签名有效）。已登记接受项：ST 服务端 secret 命名空间对同机其他 server 插件可读，绑定即全量 key 权限，作为生态既认风险记录。
- **D3 批准面走门户写接口既有规则**：portal 会话 + 精确同源 Origin（`403 origin_forbidden`）。与"查看 key"（`GET /api/portal/me/key`，会话级）同级、不额外 step-up——sec 评审结论：该同级别论证仅覆盖会话窃取轴，对钓鱼轴不成立，故**防钓鱼的主控是 §2.4 的批准页加固**，step-up 仅作纵深防御备选（Pass 迁移后用 Pass 重认证实现，已删邮箱码端点不可用）。
- **D4 凭据只回一次（consume-once），以行删除实现。** 批准后首个成功 poll 在同一事务校验并删除配对行、返回绑定；无独立 `consumed` 状态；响应丢失需重新配对。device_code 即取件凭据（CSPRNG ≥128bit，15 分钟 TTL）。
- **D5 绑定无独立实体、无列表 / 撤销接口。** 撤销＝门户 key 重置（既有语义：整把重置、旧 key 立即失效、撤销全部 portal 会话、7 天冷却）。失效联动见 §2.2：key 重置 / 账号禁用后，已批准未取件的配对取件失败（poll 校验 key_hash 快照与账号状态）。
- **D6 配对状态落库而非内存**（migration `0053_plugin_pairings`），批准与审计同事务（协作规则 3）。哈希口径分级：`device_code` 高熵（≥128bit）存普通 sha256；`user_code` 低熵（~39.6bit），按项目既有低熵码口径存 **HMAC-SHA256(KEK, 域分隔串)**（对齐 `emailCodeHash`），库 / 备份泄漏不可枚举活码。

## 2. 契约变更一：绑定配对（新域「绑定」）

### 2.1 `POST /api/bindings/pairings` —— 发起配对（匿名）

- 请求：`{}`（空对象；拒绝未知字段 422）。
- 200 响应（`Cache-Control: no-store`）：`{"device_code": string, "user_code": string, "expires_at": <UTC date-time>}`
  - `device_code`：CSPRNG ≥128bit URL 安全串，即取件凭据，TTL 15 分钟，单次消费（D4）。
  - `user_code`：8 字符，字符集沿用门户邮箱验证码字符集（`23456789ABCDEFGHJKMNPQRSTUVWXYZ`，31^8 ≈ 8.5×10^11），展示为 `XXXX-XXXX`；**同为 CSPRNG、逐位均匀采样**（复用 `cryptoRandInt` 拒绝采样；测试断言字符集 / 长度 / 均匀性）。
  - 轮询间隔：契约固定 5 秒（非协商字段，不进响应）。
- 限频：**独立限频器实例**（不与 v1/登录桶共用，避免跨面配额挤兑）；发起按可信 IP 5 次/分；存活配对上限 500，超限 `429 rate_limited`。创建时顺带删除本用户无主过期行（惰性清理，**无后台清扫器**）。运维注：现部署 `trusted_proxies` 默认为空，"按 IP"实际退化为全局限速——此为可用性权衡而非安全边界，随批提请 ops 知悉。

### 2.2 `POST /api/bindings/pairings/poll` —— 轮询取件（匿名，凭 device_code）

- 请求：`{"device_code": string}`；响应 `Cache-Control: no-store`；**匿名路由不得读取、不得记录 portal cookie 与请求头**（pass-add 后 cookie `Path=/` 会到达本路由）。
- 200 响应：
  - 未批准：`{"status": "pending"}`
  - 已批准（恰一次）：`{"status": "approved", "binding": {"key": string, "username": string}}`。同事务 CAS：`DELETE ... WHERE device_code_hash=? AND user_id IS NOT NULL`，`RowsAffected≠1` 视为 404；行删除即消费（D4），批准历史由审计行承载。
- **失效联动（sec 阻断修复）**：取件事务内读取当前 `users.key_hash` 与账号状态，与批准时快照（§2.3）不一致或 `status!='enabled'` → **404 且不消费**（不删行，避免耗尽取件机会的竞态被用来探测状态；行随 TTL 惰性消亡）。效果：key 重置 / 账号禁用后，已批准未取件的配对拿不到任何 key（含重置后的新 key）。
- 错误（收敛为单一 404）：`404 pairing_not_found`（不存在 / 未批准 / 已消费 / 已过期 / 失效联动，一概同码不可区分）；`429 rate_limited`（按 device_code ≥5 秒 + 按可信 IP 30 次/分，独立限频器）；`422`。
- 载体 DTO 带 key，须实现 `String()`/`GoString()` 脱敏；禁止在服务与处理器日志出现请求 / 响应体与任何码值。

### 2.3 `POST /api/portal/me/bindings/pairings/approve` —— 批准（门户会话）

- 鉴权：portal 会话 + 精确同源 Origin（D3）。
- 请求：`{"user_code": string}`；响应 `{"status": "approved"}`（`Cache-Control: no-store`）。
- 行为（CAS，sec 修复）：`UPDATE ... SET user_id=?, key_hash_snapshot=<当前 users.key_hash> WHERE user_code_hash=? AND user_id IS NULL AND expires_at>now`，`RowsAffected=0` → `404 pairing_not_found`（覆盖未知 / 已批准 / 已过期 / 并发抢批，恰一 200）。批准不改变 key 本身、不产生新凭据行。
- 审计（同事务）：用户发起的批准复用现有审计表，`admin_id=NULL`、`admin_name="user:<用户名>"`、`object_type="binding"`、`object_id=<配对行 id>`，摘要不含任何码值；随批更新数据字典。
- 错误：`401 unauthorized/session_expired`、`403 user_disabled/permission_denied/origin_forbidden`、`404 pairing_not_found`、`422`、`429 rate_limited`（按用户 10 次/分 + 按可信 IP 30 次/分，独立限频器）、`500`。
- **并发测试**：双 approve 恰一 200；approve 与 poll 消费并发恰一返回绑定。

### 2.4 门户批准页（防钓鱼加固，sec 阻断修复；非契约件但随批实现）

- 页面**打开即展示**：将授权的账号用户名、授权后果全文（"本操作把你的**完整 API key** 交给第三方应用；撤销只能通过门户重置 key，重置有 7 天冷却"）、用户码显著展示、以及比对指令："与你的插件面板上显示的码**逐字核对**；如果你的插件没有在请求绑定、或码不一致，请停止"。
- **无任何自动批准路径**；user_code **手动输入**（不做 URL 预填——预填消除比对步骤，是钓鱼助剂；登录跳转回跳亦不得经 return URL / cookie 携带码值）。
- 门户 SPA 增加 `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY`（现网缺失，sec 已核）；批准路由 `Referrer-Policy: no-referrer`（码不进代理 / Referer 日志）。
- 测试：打开页面绝无副作用；预填 / 自动提交路径不存在；无框嵌套。

## 3. 契约变更二：BalanceSnapshot 增列（BILL-08 用户侧暴露）

`GET /api/user/balance` 与 `GET /api/portal/me/balance` 的 BalanceSnapshot 追加两个**必填**字段（命名与 system_settings KV 键一致）：

| 字段 | 形态 | 语义 |
|---|---|---|
| `penalty_input_threshold` | 非负十进制整数字符串 | 大输入惩罚触发阈值 H（token 数）；可信输入 token 数**严格大于** H 才追加费，等于不追加（BILL-08 口径） |
| `penalty_multiplier` | 十进制整数字符串 | 倍率 K（毫率，K≥1000，1000=1 倍）；超阈值追加＝ceil(B×(K−1000)/1000) 微度，B 为该请求基础费。**仅展示用**，客户端不做追加额计算 |

- 两键为 0001 种子 fail-closed 占位、恒有值，故必填；字符串形态与 admin settings 一致（不经浮点，≤MaxInt64）。消费者（插件）以 BigInt / 整数校验解析，非法值按"未知"展示（MaxInt64 超出 JS Number 精度）。
- 观察口径：随 `observed_at` 快照，语义为"观察时点生效的 BILL-08 配置"（H/K 短 TTL 组件，正常期陈旧上界 5 秒）。
- 零新错误码（200 形态增列）；`/v1` 与目录不动。

## 4. 数据与迁移

`0053_plugin_pairings`（簿记最小面，oracle 修订）：`id, device_code_hash(uniq, sha256), user_code_hash(uniq, HMAC-KEK 域分隔), user_id(NULL=未批准), key_hash_snapshot(NULL=未批准), expires_at`。无 `status` / 无簿记时间戳列（批准历史在审计行）；消费＝删行；过期行读时视同不存在、创建时顺带删除。哈希口径见 D6。随批更新 `docs/db-schema.md` / `docs/db-data-dictionary.md`（表数 22→23）与审计表用户发起形态说明。

## 5. 本批实现清单（执行批 PR 面）

契约件：`docs/api/api.md`（新「绑定」域三操作 + query §2 增列 + 头部 v1.33）、`docs/api/openapi.yaml`（路径 + 0.11.98）、`docs/api-changelog.md`（v1.33 行）、`docs/term-glossary.md`（绑定 / 设备码 / 用户码 / key_hash 快照失效联动 词条）、`scripts/contract/error-contract.mjs`（新操作 + SHA 重锁）。
实现件：migration 0053；绑定服务（发起 / 轮询 / 批准 / 惰性过期，CSPRNG、独立限频器、CAS、consume-once、key_hash 失效联动、no-store、DTO 脱敏）；BalanceSnapshot 两字段贯通（store→catalogservice→catalogadapter→server）；门户批准页（§2.4 全部加固项 + SPA frame 头 + Referrer-Policy）；审批计配审计（用户发起形态）。
门禁：`node scripts/checks/plan-refs.mjs`、`comment-hygiene.mjs`、`strict-yaml-validate.mjs`；`go test ./internal/store -count=1`。

## 6. 验收口径

- HTTP 回归（Apifox CLI / 仓库场景，批准的隔离测试环境）：发起→pending→批准→approved（二次 poll 404，行已删）；批准面无 Origin 拒绝、未登录 401；限频 429；余额两端点新字段存在且为合法整数字符串。负面：未知 user_code/device_code、过期、未批准即 poll、空体、未知字段——一概 404/422/429 不可区分语义。
- 安全断言（sec 修复项）：approve→poll 得 key；**approve→key 重置→poll 404 且行未删**；**approve→账号禁用→poll 404**；并发双 approve 恰一 200；approve 与 poll 并发恰一交付；批准页打开零副作用、无预填路径；三条路由响应 `no-store`、日志无码值、DTO 脱敏生效。
- 独立 reviewer-1 核对覆盖率与断言；Go 集成测试覆盖事务性（批准 + 审计同事务）与并发 CAS。
- 报告注明测试代码修订、契约引用（v1.33）、环境、未覆盖项。

## 7. 分工与排期

两人分工（人甲＝网关侧 / 人乙＝插件侧）任务单见同目录 [tasks.md](tasks.md)；接缝＝C1 契约冻结。要点：C1 冻结后 C2 与插件侧全并行；插件发布门控＝v1.33 合并；C1 字段如有变更，甲主动同步乙。

## 8. 评审记录与留决事项

- oracle 评审（v2 已并入）：删后台清扫器、收敛簿记列、砍 `issued_at`/`interval_seconds`/批准响应 `expires_at`、`410` 并入 404、插件侧砍 `DELETE /binding` 与开关态上报。
- sec 评审（v2 已并入，verdict: approve-with-fixes→已修）：§2.4 防钓鱼批准页（阻断）、§2.2 key_hash 失效联动（阻断）、user_code HMAC-KEK（D6）、approve CAS（§2.3）、CSPRNG 采样声明（§2.1）、插件路由鉴权与脱敏（插件批 B1）、no-store/DTO 脱敏（§2.2）。
- 留给契约评审：① 批准是否加 step-up（现案不加，主控为 §2.4；若加，Pass 迁移后用 Pass 重认证）；② user_code 长度 / TTL / 存活上限数值（现案 8 字符 / 15 分钟 / 500）；③ `penalty_multiplier` 是否随 H 一并暴露（现案保留、仅展示用；ponytail 备选＝只出 H）；④ 门户批准页路由与文案。
