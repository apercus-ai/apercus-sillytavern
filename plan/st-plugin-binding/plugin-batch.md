# apercus-sillytavern 插件批：绑定 + 防截断分节 + 计量（草稿 v2，待签核）

- 落位说明：本稿随公开插件仓 `plan/st-plugin-binding/` 交付；分工任务单与契约批设计稿见同目录。上游契约批（设备配对 + 余额阈值字段，v1.33）的网关侧落地在网关私有仓执行，本文只写插件侧消费口径，不含网关内部设计。
- 上游依赖：网关契约批 v1.33（网关私有仓交付；对外口径＝设备配对三操作 + BalanceSnapshot 增列 `penalty_input_threshold` / `penalty_multiplier`）。**发布门控：v1.33 合并前不得发布面向用户的版本**；本地开发/测试用合成绑定（插件仓测试基建既有），不接真网关。
- 版本基线：插件 manifest `minimum_client_version: 1.17.0`；本批事件与 API 已按 ST 1.19.0（当前稳定版）源码核对，运行时一律特性检测降级（附录 A）。
- 既有边界不动：固定两个网关域名写死、身份只来自 `req.user.directories`、key / 设备码 / 用户码不进日志 / DOM / extensionSettings、fail-closed。

## 0. 目标 / 非目标

目标（对齐需求）：
1. 登录公益站后启用插件：设备配对拿绑定（B1）。
2. 防截断分节的预设感知：检测 chat 预设切换 → 提醒 → 手动一键调 LLM 生成节名单 → 注入请求体（B2）。
3. 面板小件：模型选择、含/不含工具守卫、余额 + 惩罚阈值、上下文长度计量（B3）。

非目标：instruct / sysprompt 模板切换检测（已拍板：只检测 chat 预设）；本地解绑路由（oracle 砍——重新配对即覆盖本地记录，真撤销＝门户 key 重置；残留记录只会 401 失效，不产生权限）；附加参数自由编辑器（需求口径"还能调什么附加参数"由酒馆 Custom 源自带的 `custom_include_headers` / `custom_include_body` 原生能力覆盖，插件不重复造）；anthropic / responses 面（保持禁用）；绑定管理面（网关侧不提供）。

## 1. 切片与验收顺序

### B1 绑定（依赖 v1.33 配对契约）

流程：面板"绑定公益站" → 插件服务端 `POST /api/bindings/pairings` → UI 展示 `XXXX-XXXX` 用户码 + "打开门户批准页"按钮（门户页**手动输入**码——预填是钓鱼助剂，网关批准页禁止预填、要求逐字核对）→ 用户在门户页逐字核对码并批准 → 插件服务端轮询（≥5 秒间隔，服务端节流）→ `approved` → 绑定记录写入 ST 服务端密钥库（secret 命名空间 `apercus_gateway_binding`，JSON `{"version":1,"key","username"}`，v1 无签名）→ 面板显示"已绑定：`<username>`"（textContent 渲染）。

- 插件服务端路由（3 新 + 1 改），**安全要求（sec 修复项）**：全部路由要求 `req.user` 存在否则 401；`POST /pair`、`POST /plan` 校验同源（Origin / `Sec-Fetch-Site`）；`GET /pair/status` 响应仅 `{status: pending|bound|invalid, user_code?, username?}`——**永不返回 device_code / key**；请求 / 响应体与码值不落任何日志；对固定网关域名校验 TLS 证书与主机名。
  - `POST /pair`：发起配对，device_code 只存服务端内存（按 directories 键控）。
  - `GET /pair/status`：服务端节流轮询网关；取件成功即落密钥库并清内存 device_code。
  - `POST /plan`：B2 代理规划调用。
  - `GET /status`：增绑定态（`bound` / `invalid` + 失效原因 / `username`），不含开关态（开关归 UI，oracle 砍状态同步路径）。
- 失效 UX：数据面 401 `invalid_key` 或 `/pair/status` invalid → 面板转"绑定失效"，引导重新配对（网关侧保证：key 重置 / 账号禁用后，已批准未取件的配对取件即失效）。
- **启用门控（需求口径"登录公益站之后启用插件"）**：未绑定或绑定失效时，仅配对入口与说明可用；模型选择、防截断开关与注入、规划调用、余额/计量数据全部禁用或隐藏。
- 测试：配对状态机（stub 网关：pending/approved/失效联动/网络丢失后重配）、取件恰一次、跨用户隔离（directories A/B）、无 `req.user` 401、跨源写拒绝、`/pair/status` 载荷不含敏感字段（断言序列化输出）、密钥库写入 fail-closed。

### B2 防截断分节（契约面＝v1.32 既有字段，零新契约）

状态机：`提醒（事件驱动）→ 指纹（惰性计算）→ 缓存命中? → 注入`；指纹变化 → 提醒 + 出"生成分节参数"按钮（**手动**，不自动调用）。

- **预设检测（只检测 chat 预设，已拍板；oracle 修订＝单事件 + 惰性指纹）**：仅订阅 `PRESET_CHANGED`（过滤 `apiId==='openai'`）驱动提醒与按钮态；指纹在注入时（`CHAT_COMPLETION_SETTINGS_READY`）与按钮点击时惰性计算——`getPresetManager('openai').getSelectedPresetName()` + `JSON.stringify`（原生序，不做键序规范化，接受偶发缓存未命中）+ `crypto.subtle.digest`。指纹未变则提醒自动消退。
- **规划调用（plan call）**：经插件服务端 `POST /plan` 直调网关 `POST /v1/chat/completions`（Bearer 绑定）——不走用户当前酒馆连接，天然不与 S喵 等脚本互抢，域名固定在服务端强制，请求体（含预设摘要）两端都不落日志。模型＝面板选中的那个模型（**单一选择器**，oracle 砍独立"规划模型"状态；未选模型时规划按钮禁用并提示）。参数：`temperature 0.2`、`max_tokens 600`、不带 tools。
- **提示词 v1（测试期简单版，边测边精进）**：

  ```
  你是分节配置器。阅读角色扮演预设，产出"防截断分节"节名单。
  只输出 JSON 对象，不要任何其他文字：
  {"sections":["节名1","节名2",...]}
  要求：
  - 2~8 个节名，按该预设的叙事节奏排列；每个 ≤20 字、名词短语、不带序号
  - 每节将承载 800–1000 字正文
  预设内容（可能被截断）：
  """
  {预设摘要 ≤16000 字符}
  """
  ```

- **校验与兜底（纯逻辑，进 logic.mjs）**：剥代码围栏 → 解析 JSON → `sections` 字符串数组逐项 trim、去空 → 合法（≥2、≤16、单项 ≤64 字节）才入缓存；否则退默认名单 `["开场","推进","高潮","收尾"]` 并 toast 说明。失败重试一次（附错误摘要），再失败走兜底。
- **缓存**：`extensionSettings.apercusGateway.sectionsCache[fingerprint] = sections`（仅节名单，oracle 砍 model/generatedAt 字段；非敏感，明文 JSON 允许）；每预设版本一次调用（网关设计稿口径）。
- **注入**：`CHAT_COMPLETION_SETTINGS_READY`（特性检测）→ 开关 ON 且指纹命中 → 合并写 `custom_include_body`：`apercus_antitrunc: true`、`apercus_antitrunc_sections`、**不静默覆盖** `max_tokens`——地板 `节数×1200+2000`（网关契约口径）不足时 toast 警告 + 一键"应用建议值"。
- **守卫**：settings 含 `tools` / `tool_choice` / `response_format` 或 `n≠1` → 跳过注入并警告"网关将静默放行"（契约 v1.32 的静默弃臂语义）；面板"含/不含工具"开关开防截断时联动提示关函数调用。
- **开关默认关**（网关引擎设计稿既定：插件开关默认关）。
- 测试：指纹稳定与失效（键序差异允许 miss）、校验器全分支（含 64 字节 / 16 项边界）、注入合并不覆盖用户字段、守卫跳过矩阵、缓存命中不重复调用、按钮禁用态（无模型 / 无绑定）。

### B3 面板计量（余额阈值 + 上下文 + 模型选择）

- **余额 + 阈值**：现有余额渲染加两行（H / K，来自 v1.33 新字段；`BigInt` / 整数校验解析，非法值显"未知"，fail-closed）；**K 仅展示**（"超阈值后按 K 毫率追加"文案），不做客户端追加额计算（v1.33 契约字段）。
- **上下文长度（单一计量路径，oracle 修订）**：发送时对最终 messages 用 `getTokenCountAsync` 计数 + 面板打开时对当前 chat 估算一次；显示 `已用 / getMaxPromptTokens()`。**与惩罚阈值并列**：估算值 ≥ 90%×H 变黄、≥100% 变红，文案注明"估算值，网关按可信输入 token 计费、严格大于阈值才追加"。
- **模型选择**：目录行按 `protocol_faces` 含 `chat` 启用（B2 规划调用共用此选择）；点选 → 确认弹窗 → 写 `chatCompletionSettings.custom_model` 并 `saveSettingsDebounced()`（Custom OpenAI-compatible 源由用户配一次 URL+key（绑定后自动写入 secret），插件不偷偷改 `chat_completion_source`）；行能力徽章复用现有 chips。
- 测试：H/K 解析（BigInt / 非法串 / 空串）、阈值刻度换算与变色带、计数聚合、目录行启停、确认弹窗不直接写设置。

## 2. 插件服务端路由汇总（新增 3 + 改 1）

| 路由 | 变化 |
|---|---|
| `POST /pair` / `GET /pair/status` | B1，见上（含鉴权 / 同源 / 载荷约束） |
| `POST /plan` | B2 代理规划调用（Bearer 绑定；返回 LLM 文本，校验在 UI 侧 logic） |
| `GET /status` | 增绑定态（bound/invalid+原因/username），不含开关态 |
| `GET /balance` / `GET /models` | 透传 v1.33 新字段；目录行带启用条件 |

## 3. 验收与门禁

- 插件仓 `pnpm test`（node --test）全绿；`pnpm check` 通过；不引入第三方依赖（延续现仓约束）。
- 本地 ST 冒烟（合成绑定）：配对 UI（stub 批准）→ 选模型 → 开防截断 → 切预设 → 提醒出现 → 手动生成节名单 → 发送 → 分节按序到达 → 余额/阈值/上下文条显示正确 → key 重置模拟 → 绑定失效提示。
- 真网关联调（v1.33 合并后）：批准环境走一遍真实配对 + 真实 plan call；报告注明插件修订、网关契约 v1.33、环境、未覆盖项。HTTP 回归（配对三操作 + 余额新字段）属网关契约批验收，插件侧只做消费方冒烟。
- 独立 reviewer-1 审查插件批实现（覆盖率、边界、密钥不落 UI/DOM/日志）。

## 4. 风险与说明

- ST 版本漂移：所有事件 / API 特性检测（附录 A 清单），manifest `minimum_client_version` 不动。
- S喵 等社区脚本：README 写明与防截断注入互斥使用；规划调用已隔离在插件服务端，不受其影响。
- 规划调用消耗：按钮旁注明"将消耗少量额度（模型 X）"，失败最多重试一次。
- key 重置联动：门户重置 key → 网关侧失效联动 → 插件 401 → 引导重配对（不做自动重试）。
- 既认残余风险：ST 服务端 secret 命名空间对同机其他 server 插件可读，绑定即全量 key 权限。

## 附录 A：ST 1.19.0 事件 / API 核对清单（研究结论）

| 名称 | 状态 |
|---|---|
| `OAI_PRESET_CHANGED_BEFORE/AFTER`、`PRESET_CHANGED`、`CHAT_COMPLETION_SETTINGS_READY`、`GENERATE_AFTER_DATA`、`SETTINGS_UPDATED` | 存在可用 |
| 裸 `OAI_PRESET_CHANGED`、`getMaxContextSlots` | 不存在，勿用 |
| `getTokenCount`、`getMaxContextSize`、`renderExtensionTemplate`、`showLoader` | deprecated，用 `getTokenCountAsync` / `getMaxPromptTokens` / `renderExtensionTemplateAsync` / `context.loader` |
| `ChatCompletionService.processRequest`（可指定 model/url） | 存在但未文档化，本批不依赖（plan call 走插件服务端） |

## 附录 B：上游契约引用（v1.32 / v1.33，网关私有仓维护；本文只列消费口径）

- 节名单语义（v1.32）：请求体顶层 `apercus_antitrunc: true` + `apercus_antitrunc_sections`（≤16 项、单项 ≤64 字节、有效项 <2 降级单节；网关剥字段后转发上游）；`max_tokens` 地板 `节数×1200+2000` 客户端自担。
- 插件批流程口径：每预设版本一次 plan 调用、指纹缓存失效、与 S喵 等脚本互斥说明（与网关侧商定的分工：网关只消费字段，节名单由插件生成）。
- 绑定配对与阈值字段（v1.33）：设备配对三操作 + BalanceSnapshot 增列；插件侧 UX 依据＝门户批准页手动输码并逐字核对。
