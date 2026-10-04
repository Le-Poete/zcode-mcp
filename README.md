# zcode-mcp

> **非官方社区项目声明**:本项目与 Z.ai / 智谱 **无任何官方关联、未获授权、不受其支持**。
> "ZCode"、"GLM"、"Z.ai" 等名称及产品归其所有者所有,此处仅作互操作性描述(引用)。
> 本项目不包含、不再分发 ZCode 的任何代码或二进制;它只是调用**你自己安装的**
> ZCode CLI 与**你自己的**账号。使用本项目即表示你自行确认遵守 Z.ai 服务条款,
> 因使用产生的一切后果(包括账号风险)由使用者自行承担。详见文末「合规与风险」。

把本机 [ZCode](https://github.com/zai-org/ZCode)(Z.ai 的 GLM 编码智能体)暴露为 **MCP 工具**,
让 ChatGPT / Claude / Cursor 等任何 MCP 客户端把任务委派给 GLM。

**核心价值:委派的不是"纯文本模型",是带完整工具链的 agent**——GLM 那边能读写文件、
执行命令、跑测试。GPT 当编排者,把"改代码/排查问题/处理文件"整包外包。

## 三条模型通道

| model 参数 | 模型 | 计费 | 前置条件 |
|---|---|---|---|
| `glm-5.3`(默认) | GLM-5.3 | Coding Plan 订阅 | 装机版 CLI 已登录 |
| `glm-5.3-flash` | GLM-5.3-Flash | Coding Plan 订阅 | 同上 + Flash 桥会话 |
| `glm-free` ⚠️实验性 | GLM-5.3-Flash | 免费档额度 | fork 补丁版源码 CLI(见下,先读「合规与风险」) |

免费档还提供 GLM-5.2 / GLM-5-Turbo,有滚动配额窗口,超限自动恢复。

## 工具

- `glm_ask(task, model?, workdir?, timeout_seconds?)` — 委派任务,等待完成,返回最终答复。
  每次调用是一个独立(或桥接)的 ZCode 无头会话,秒到分钟级,适合子任务外包,不适合逐句闲聊。
- `glm_models()` — 查询当前账号可用的模型目录与推理档位。

## 快速开始

### 1. 登录(一次性)

```bash
# 国内(bigmodel.cn,会员在这边):
node "%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs" login bigmodel
# 注意:装机版 0.16.9 的位置参数可能不生效,此时用 ZCode 源码仓库的 CLI 执行同款命令
```

登录态落盘于 `~/.zcode/v2/credentials.json`,自动刷新,无需反复授权。

### 2. 配置

复制 `zcode-mcp.config.example.json` 为 `zcode-mcp.config.json`,按需填写。
最简配置只需要 `installedCli`(其余通道留空即禁用)。

### 3. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "zcode": { "command": "node", "args": ["<本目录>/zcode-mcp.mjs"] }
  }
}
```

ChatGPT 桌面版(开发者模式连接器)、Claude Desktop、Cursor 通用。

### 4. 自测

```bash
node test-client.mjs
```

## 免费档(glm-free)的原理与配置 ⚠️ 实验性

> 免费档(Start Plan)目前仅官方桌面端提供入口。本通道依赖一个**开源 fork 补丁**
> 让 CLI 无头场景也能使用**你账号已拥有的**免费档权益——不是获取任何额外额度,
> 消耗的仍是你账号自身的免费档配额。但请注意:这属于官方未开放的客户端路径,
> **存在被风控标记甚至影响账号的可能**,请自行评估后再启用。

1. fork ZCode 源码,切到 [`feat/start-plan-standalone`](https://github.com/Le-Poete/ZCode/tree/feat/start-plan-standalone) 分支
2. `pnpm install && pnpm --filter @zcode/bootstrap build`(补丁进 dist 才生效)
3. 建一个桥会话(任意一次成功的 `-p` 调用),然后把 sqlite 会话库
   (`~/.zcode/cli/db/db.sqlite`)中该会话 `runtime/model_selection` 的
   `providerId` 改为 `account:bigmodel-start-plan`、`modelId` 改为 `GLM-5.3-Flash`
4. 把会话 id 与 fork 路径填进 `zcode-mcp.config.json` 的 `freeSession`/`forkCliDir`/`forkBuiltinConfig`

## 安全与额度

- GLM 在 `workdir`(默认 `~/zcode-mcp-sandbox`)内以 yolo 权限执行,委派敏感操作时显式限定目录
- 订阅通道消耗 Coding Plan 额度;免费档是独立额度池
- `zcode-mcp.config.json` 含本机会话信息,已列入 `.gitignore`,**不要提交**
- 本项目只在本机进程间转发任务,不中转任何模型流量到第三方

## 合规与风险(请完整阅读)

1. **非官方**:本项目是社区互操作工具,与 Z.ai/智谱无关联、未获授权。商标与产品
   归其所有者;项目不含其代码,仅调用用户自装的 CLI 与自有账号。
2. **上游许可**:ZCode 以 Apache-2.0 开源;配套 fork 补丁同样遵循 Apache-2.0
   (分支位于 fork 仓库,保留原许可与归属)。
3. **服务条款**:订阅通道(`glm-5.3`/`glm-5.3-flash`)使用官方 CLI 的常规无头能力;
   免费档通道(`glm-free`)依赖官方未开放的客户端路径,属**实验性**,可能不符合
   服务条款的精神或字面——是否启用由使用者自行判断,风险自担。
4. **账号风险**:任何非官方客户端用法都有触发风控的理论可能。建议:免费档仅用于
   低价值场景、避免高频并发、绝不用于生产关键路径。
5. **日落条款**:若官方提供等价原生能力(如 `zcode mcp serve` 或 CLI 原生支持
   免费档),本项目即完成使命,建议迁移官方方案。

## 结构

```
zcode-mcp.mjs                    MCP 服务器(零依赖,手写 stdio 协议)
test-client.mjs                  端到端自测客户端
zcode-mcp.config.example.json    配置模板
AGENTS.md                        给 AI 维护者的操作手册(坑位与排障)
```

## 许可

MIT。基于开源项目 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的生态构建,与 Z.ai 无官方关联。
