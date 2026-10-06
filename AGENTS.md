# AGENTS.md — zcode-mcp 维护手册(给 AI 看的)

本文件面向维护本项目的 AI agent。全部为实测结论,不是猜测。按"排障时按图索骥"组织。

## 系统事实(本机拓扑)

- 装机版 ZCode:`%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs`(v0.16.9)
- 凭证:`~/.zcode/v2/credentials.json`(值多为 AES-256-GCM 加密,`enc:v1:` 前缀)
- 会话库:sqlite,`~/.zcode/cli/db/db.sqlite`,表 `session`/`session_entry`
- 运行日志:`~/.zcode/cli/log/zcode-<date>.jsonl`(排障第一现场:按 traceId grep)
- fork 源码:`zcode-mcp.config.json` 的 `forkCliDir` 指向的仓库,
  分支 `feat/start-plan-standalone`

## 五个已验证的关键机制

1. **无头调用**:`zcode -p "<task>" --cwd <dir> --mode yolo`。装机版 0.16.9
   新会话读取 `~/.zcode/v2/provider_config.json` 的 **config.defaultModelSelection**。
   桌面已有凭据仍不等于独立 CLI 已就绪：CLI 还需
   `account-provider:<providerId>:identity` 索引，指向既有 Coding Plan API key。
   2026-10-05 本机补齐上述两项后，glm_ask 和 glm_models 均实测成功。
   用 `node zcode-mcp.mjs --repair-cli` 预览，`--repair-cli --apply` 显式修复。
   修复只使用唯一既有凭据的键名元数据，不解密 token，不覆盖已有选择/索引。
   (repair-cli 的加密实现与上游 zai-org/ZCode 的 credential-cipher.ts 同源对齐,
   该算法本身随上游 Apache-2.0 开源;此处仅做加密兼容,不做解密。)
2. **模型切换靠桥会话**:`--resume <sid>` 会恢复该会话持久化的
   `runtime/model_selection`。把桥会话的选择改成目标模型(resume 一次让它落库),
   之后所有 resume 都用该模型。桥会话 id 是 MCP 配置里的 `flashSession`/`freeSession`。
3. **免费档凭证 = zcodejwttoken**:桌面端 services 层的
   `accountProviderRequestAuthService` 对 `planKind === "start-plan"` 返回
   `{apiKey: zcodejwttoken}`。该 JWT 无 exp 字段(不过期),payload 只有 user_id。
4. **客户端兼容性边界**:免费档网关(`zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`)
   仅接受 ZCode 客户端栈发出的请求,直接 HTTP 复刻(即使带全套归因头)会收到
   3012 拒绝——这是官方的客户端校验设计。**正确姿势是让 CLI 自己发请求**;
   维护者不得编写或引入绕过该校验的代码。
5. **dist 陷阱**:CLI 的 `-p` 流程加载 `@zcode/bootstrap` 的**预构建 dist**。
   修改 `apps/zcode-cli/packages/bootstrap/src/**` 后必须
   `pnpm --filter @zcode/bootstrap build`,否则改动静默不生效(调试时表现为
   "补丁明明写了但行为没变")。

## 登录坑位

- 装机版 `zcode login` 的 OAuth **写死国际站 z.ai**;国内会员(bigmodel.cn)必须
  `login bigmodel`,且装机版 0.16.9 的位置参数不生效——用源码仓库 CLI 执行:
  `cd <fork>/apps/zcode-cli/packages/cli && npx tsx src/main.ts login bigmodel`
- 授权窗口 5 分钟,过期/旧标签页会报 `invalid_flow` 或超时;重试即可,凭证落盘后
  自动刷新,一次终身。
- 磁盘上的 token 可能被桌面端随时刷新重写——解密失败时先怀疑文件刚被重写,
  重读再试。

## 免费档排障决策树

```
glm-free 调用失败
├─ "Model creation failed" → 先按 traceId 查 turn.failed.error.cause
│   ├─ cause="Select a model before continuing" → 检查免费模型是否进入注册表
│   │   ├─ 是否误用装机版独立 CLI? 0.16.9 未纳入 Start Plan 账号覆盖层
│   │   ├─ fork 分支对不对? → git -C <fork> branch --show-current
│   │   └─ bootstrap 与依赖 build 过没有? → 检查 dist(坑位5)
│   └─ 其他 cause → 按日志诊断,不能仅凭外层错误认定未登录或额度用尽
├─ 3012/405 → 检查客户端兼容性和实际 CLI 请求路径,不得绕过校验
├─ "exceed quota limit" → 免费档滚动配额用尽,等窗口刷新(历史上分钟级恢复)
└─ 免费档模型清单 → GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo(内置配置白名单)
```

2026-10-05 复验：装机版 Start Plan 调用约 5.6s 失败，底层 cause 为
`Select a model before continuing`。fork 提交 b23dfa2 的 bootstrap 及依赖构建后，
隔离免费 CLI 调用约 14.7s 成功；配置免费桥会话后，MCP glm-free 约 23.8s 成功。
免费白名单没有付费回退。此结果不代表所有账号/平台可用，仍属实验性、账号风险自担。
MCP stderr 还有未定位的非致命 `ZCode Built-in missing`；全仓库 typecheck/lint
尝试均未通过（内存不足/异常退出），不得写成完整仓库验收通过。

首次构建建议 `pnpm --filter '@zcode/bootstrap...' build`，连依赖一起构建。
默认安装只接订阅通道，repair-cli 不增加 Start Plan 支持；免费调用必须显式
`model="glm-free"`，glm_models/test-client.mjs 仍走默认装机版通道。
forkCliDir 必须指向 apps/zcode-cli/packages/cli。修改本地免费配置后重载 MCP；
不要将隔离数据库的会话 id 填给使用另一会话库的 MCP。

## 桥会话重置流程

1. 优先按 README 的临时免费默认配置，通过 fork 创建专用测试会话；从本次
   `--json` 输出记录 sessionId，不按数据库“最新会话”猜测，避免其他进程并发建会话。
2. 核验该会话 `session_entry` 的 `runtime/model_selection`，其 data 有 modelSelection 包装:
   flash → `{"modelSelection":{"providerId":"account:bigmodel-individual-coding-plan","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}}}`
   free  → `{"modelSelection":{"providerId":"account:bigmodel-start-plan","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}}}`
   如需人工改库，先停止使用目标会话的进程并备份，不修改其他会话。
3. resume 一次确认落库,把新 id 写回 `zcode-mcp.config.json`

## 维护红线

- `zcode-mcp.config.json` 不入库(.gitignore)
- 不向官方组织仓库(zai-org 等)提交任何东西;fork 只在用户自己账号下操作
- 凭证解密仅限本机进程内(CLI 自动做);解密结果不落盘、不进日志、不进文档
- **不编写绕过官方客户端校验/WAF 的代码**;文档措辞保持"客户端兼容性"视角,
  不使用"破解/绕过/绕开风控"类表述
- 免费档相关描述必须保留"实验性 + 账号风险自担"的警示,不得删改

## 信号通路验证(2026-10-06,rollout 实测)

免费档全链路健康:MCP→CLI 引导→registry(JWT entitled)→SSE 流式请求→完成。
- **流式**:请求 `stream:true`,响应 `text/event-stream`——正常且在用。MCP 工具
  协议本身是"等待完整结果"语义,客户端看到完成文本不是流式故障。
- **思考档**:桥会话的 reasoningLevel 直接映射为请求的 `output_config.effort`
  与 `thinking.enabled`。**免费桥必须用 low**——max 会让每笔轻量调用也满档思考,
  加速烧穿滚动配额窗口(已实测:改 low 后请求体 effort=low 生效)。
- **固定成本**:每笔调用 input ~13.8K tokens(system ~8.9K 字符 + 17 工具定义 +
  桥历史),其中大头通常走服务端 prompt 缓存(cacheRead);缓存未命中时全额计。
  这是 agent 形态的固有成本,减少之道只有少带工具/精简 system,当前不可配。
- 验证入口:`~/.zcode/cli/rollout/model-io-sess_<桥id>.jsonl` 的最后一条记录
  (request.body 看 stream/thinking/output_config,response.usage 看 token)。
- 桥当前 reasoningLevel=**high**(用户选择,质量优先);基准见下节,复测跑 bench-thinking.mjs。

## 思考时长基准(2026-10-06,effort=high 实测,桥=GLM-5.3-Flash 免费档)

| 任务 | 端到端 | 模型请求 | 模型侧耗时 | 输出tok |
|---|---|---|---|---|
| 极简(回一字) | 25s | 1 | 5s | 20 |
| 简单心算 | 27s | 1 | 6s | 98 |
| 中等推理(水桶) | 39s | 1 | 18s | 186 |
| 编码任务 | 74s | 3 | 40s | 1329 |
| 开放难题(单步) | 110s | 1 | **89s** | 2330 |
| 多轮工具(5文件读写) | 105s | 4 | 69s | 1476 |

- 固定开销 ~20s(tsx 启动+agent 循环+MCP);单步任务即使很难,模型侧 ≤90s。
- **"思考20分钟"的机理不是单请求失控,而是长任务多轮复利**:每轮 6-25s 思考+动作,
  40-60 轮的 agent 编码任务 ≈ 17-25 分钟;配额压力下的网络重试(maxAttempts=11)会再拉长。
- 缓解:①glm_ask 传紧的 timeout_seconds(轻活 120-180s)②编排方(ChatGPT)把大任务
  拆成多次小 glm_ask 而不是一次委派整项目③复测用 bench-thinking.mjs。

## 已知未解

- 免费档配额的具体窗口长度/额度未测出(仅观察到存在滚动限额)
- 免费档网关客户端校验的精确判定维度未知(仅确认官方客户端栈可通行)
- 装机版 CLI 何时原生支持 `login bigmodel` 位置参数——关注官方更新,
  若支持则 fork 的登录环节可退役
- 官方若提供 `zcode mcp serve` 或 CLI 原生免费档支持,按 README 日落条款迁移
