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
├─ "Model creation failed" → 注册表没进 start-plan
│   ├─ fork 分支对不对? → git -C <fork> branch --show-current
│   ├─ bootstrap build 过没有? → 看 dist 时间戳,必要时重 build(坑位5)
│   └─ 日志 grep traceId:turnPhase=model_creation
├─ 3012/405 → 出现即说明有人在裸调网关(违反机制4),检查调用路径
├─ "exceed quota limit" → 免费档滚动配额用尽,等窗口刷新(历史上分钟级恢复)
└─ 免费档模型清单 → GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo(内置配置白名单)
```

## 桥会话重置流程

1. `zcode -p "init" --cwd <sandbox>` 跑一次,从 `session` 表取最新 id
2. 更新该会话 `session_entry` 的 `runtime/model_selection`:
   flash → `{"providerId":"account:bigmodel-individual-coding-plan","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}}`
   free  → `{"providerId":"account:bigmodel-start-plan","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}}`
3. resume 一次确认落库,把新 id 写回 `zcode-mcp.config.json`

## 维护红线

- `zcode-mcp.config.json` 不入库(.gitignore)
- 不向官方组织仓库(zai-org 等)提交任何东西;fork 只在用户自己账号下操作
- 凭证解密仅限本机进程内(CLI 自动做);解密结果不落盘、不进日志、不进文档
- **不编写绕过官方客户端校验/WAF 的代码**;文档措辞保持"客户端兼容性"视角,
  不使用"破解/绕过/绕开风控"类表述
- 免费档相关描述必须保留"实验性 + 账号风险自担"的警示,不得删改

## 已知未解

- 免费档配额的具体窗口长度/额度未测出(仅观察到存在滚动限额)
- 免费档网关客户端校验的精确判定维度未知(仅确认官方客户端栈可通行)
- 装机版 CLI 何时原生支持 `login bigmodel` 位置参数——关注官方更新,
  若支持则 fork 的登录环节可退役
- 官方若提供 `zcode mcp serve` 或 CLI 原生免费档支持,按 README 日落条款迁移
