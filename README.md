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

## 最短路径(30 秒上手)

前提:已装 ZCode 桌面版并在桌面登录过 + 装了 Node.js。依次执行,每步的输出都会告诉你下一步:

```bash
git clone https://github.com/Le-Poete/zcode-mcp.git && cd zcode-mcp
node zcode-mcp.mjs --doctor            # ① 体检:缺什么它会说,全 OK 直接跳到 ③
node zcode-mcp.mjs --repair-cli        # ② 预览:仅当 ① 后调用报"Select a model"时需要
node zcode-mcp.mjs --repair-cli --apply
```

③ 把 zcode-mcp.mjs 的**绝对路径**填进你的 MCP 客户端(格式见「接入 MCP 客户端」),完事。

这条最短路径配置的是 **Coding Plan 订阅通道**，不会自动启用 Start Plan。
`--doctor` 检查路径，不能证明模型请求成功；`--repair-cli` 只修复 Coding Plan 元数据，
不为装机版 CLI 增加 Start Plan 支持。免费通道需完成下方「免费档」配置。

跑通后让 ChatGPT/Claude 调 `glm_ask("随便一个任务")` 验证。卡住了?`--doctor` 的输出
和「路径速查」就是排障入口;两台不同安装形态的真机 + 五轮独立复验覆盖过的坑,提示里都有。

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

**免费任务必须显式传 `model: "glm-free"`。** 省略 `model` 使用装机版 CLI 的默认
订阅模型，不会自动切换免费档；`glm_models()` 也走装机版的订阅目录，不是免费通道自测。

## 快速开始

### 1. 登录(一次性)

**已经在桌面版登录，CLI 仍报没有模型选择？** 桌面登录可能已保存 Coding Plan
凭据，但缺少独立 CLI 的账号身份索引及默认模型。先运行无网络、只读的修复预览：

```powershell
node ./zcode-mcp.mjs --repair-cli
# 仅在预览确认存在唯一的现有 Coding Plan 凭据后，补齐缺失元数据：
node ./zcode-mcp.mjs --repair-cli --apply
```

修复不会解密或更改现有 API key/token，也不会改写已有默认模型、身份索引或
其他 provider 配置。原文件备份保存在各自目录；重复执行不会重复写入。极小概率下进程在持锁瞬间崩溃会
留下 `credentials.json.lock` 空目录(官方 CLI 同样会因此拒写),手动删除该目录即可恢复。
多个账号或不支持的配置会拒绝自动修复，需要使用官方登录/模型选择流程。
该命令修复本地元数据，不验证套餐、凭据有效性或服务可用性。

**未登录的常见表现**:首次调用返回 `Select a model before continuing`(CLI 没有可用的
模型选择;其他成因请以日志 cause 为准)。登录命令需要两个信息:**你机器上 CLI 的实际
路径**(跑 `node zcode-mcp.mjs --doctor` 看 `installedCli` 行)和**内置配置环境变量**
(login 命令自身需要它;MCP 启动子进程时会自动注入,但你在终端手工运行时不会)。

```powershell
# 每用户安装形态(%LOCALAPPDATA%):
$env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "$env:LOCALAPPDATA/Programs/ZCode/resources/config/provider/zcode-builtin.json"
node "$env:LOCALAPPDATA/Programs/ZCode/resources/glm/zcode.cjs" login bigmodel

# Program Files(全机器)安装形态：
$env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "$env:ProgramFiles/ZCode/resources/config/provider/zcode-builtin.json"
node "$env:ProgramFiles/ZCode/resources/glm/zcode.cjs" login bigmodel
# 选择与你的安装形态相符的一组命令；自定义路径以 --doctor 输出为准。
```

注意:装机版 0.16.9 的国内登录参数(`login bigmodel`)可能不生效,此时用 ZCode
源码仓库的 CLI 执行同款命令(免费档章节的 fork 就行)。登录态落盘于
`~/.zcode/v2/credentials.json`,自动刷新,无需反复授权。

### 2. 配置

复制 `zcode-mcp.config.example.json` 为 `zcode-mcp.config.json`,按需填写。
**全部字段都可以留空**——留空时各字段有自动行为(见下表),最简安装零配置。

| 字段 | 留空时的行为 | 怎么找你机器上的值 |
|---|---|---|
| `installedCli` | 自动探测:Windows 在 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` | `--doctor` 会打印解析结果 |
| `sandbox` | 默认 `~/zcode-mcp-sandbox`(自动创建) | 随意,任意可写目录 |
| `flashSession` | 该通道禁用 | 见「桥会话」章节 |
| `freeSession` | 该通道禁用(glm-free) | 见「免费档」章节 |
| `forkCliDir` / `forkBuiltinConfig` | glm-free 通道禁用 | 你的 ZCode 源码 fork 目录 |

配置文件里若写**相对路径**,一律相对配置文件所在目录解析(与 MCP 客户端的工作目录无关)。
所有路径推荐正斜杠 `/` 写法(Windows/macOS/Linux 通用)。

**本文件含本机会话信息,已在 .gitignore 中,不要提交到任何仓库。**

### 3. 接入 MCP 客户端

**关键:args 必须用绝对路径。** MCP 客户端(ChatGPT/Claude/Cursor)用它自己的
工作目录启动服务器,你终端里的相对路径在它那里解析不到——"无法找到文件"
基本都因此而起。

```json
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["C:/绝对路径/zcode-mcp/zcode-mcp.mjs"]
    }
  }
}
```

不知道绝对路径?一条命令自检(返回每个路径的解析结果与是否存在):

```bash
node <zcode-mcp.mjs 的绝对路径> --doctor
```

也可以让 ChatGPT/Claude 帮你跑这条命令再读输出。

### 4. 路径速查

| 什么 | 在哪 |
|---|---|
| 装机版 CLI(zcode.cjs) | Windows: `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`(找不到了:`dir /s /b zcode.cjs` 全盘搜) |
| 本项目文件 | `--doctor` 输出的 `self:` 行 |
| zcode-mcp.config.json 里的相对路径 | 相对**配置文件所在目录**解析(与 MCP 客户端 cwd 无关) |
| 登录命令要用的 CLI | 同装机版 CLI;`login bigmodel` 不生效时用 fork 源码 CLI(见「免费档」) |

### 5. 自测

```bash
node test-client.mjs
```

此脚本不传 `model`，测试默认订阅通道并消耗其额度。免费通道自测见下方调用示例。

## 免费档(glm-free)的原理与配置 ⚠️ 实验性

> 免费档(Start Plan)目前仅官方桌面端提供入口。本通道依赖一个**开源 fork 补丁**
> 让 CLI 无头场景也能使用**你账号已拥有的**免费档权益——不是获取任何额外额度,
> 消耗的仍是你账号自身的免费档配额。但请注意:这属于官方未开放的客户端路径,
> **存在被风控标记甚至影响账号的可能**,请自行评估后再启用。

**默认安装不包含免费运行时。** 还需自己准备 fork、构建产物及桥会话；本机
`freeSession`、`forkCliDir`、`forkBuiltinConfig` 留空时，`glm-free` 会返回「未配置」。

1. 确认桌面端已登录，账号拥有 Start Plan 权益。仅有 Coding Plan API key 不等于
   已有免费档请求凭据；fork 使用桌面端保存的 `zcodejwttoken`，不要导出或复制其值。
2. 克隆 [`feat/start-plan-standalone`](https://github.com/Le-Poete/ZCode/tree/feat/start-plan-standalone)
   分支，按 fork 的 Node.js/pnpm 要求安装和构建。新 checkout 需连依赖一起构建：

   ```bash
   git clone --single-branch --branch feat/start-plan-standalone https://github.com/Le-Poete/ZCode.git
   cd ZCode
   pnpm --filter '@zcode/cli...' install --frozen-lockfile --ignore-scripts
   pnpm --filter '@zcode/bootstrap...' build
   ```

   CLI 会加载 bootstrap 的 `dist`；只修改 `src` 或只切换分支不会让补丁生效。
3. 准备一份本地 provider 配置，为**专用测试会话**选择
   `account:bigmodel-start-plan / GLM-5.3-Flash`。默认选择必须放在
   `config.defaultModelSelection`，不是 JSON 顶层。建议使用只保留该免费 provider/model
   的内置目录副本，避免误用订阅通道；副本从你安装的内置配置筛选，不自行构造网关。
   通过本次 CLI 进程的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指定这两份文件，不覆盖全局默认模型。
   从 fork 的 `apps/zcode-cli/packages/cli` 目录运行：

   ```bash
   node --import tsx src/main.ts -p "Reply only START_PLAN_OK. Do not use tools or change files." --cwd <可写测试目录> --mode plan --json
   ```

   确认实际返回成功，记录 JSON 的 `sessionId`，并核验该会话的持久化模型选择。
   本次进程使用的会话库必须与 MCP 后续使用的会话库相同；隔离数据库中的 id
   不能直接填给使用默认数据库的 MCP。只运行静态模型目录查询不算验收成功。
4. 将以下字段写入本地 `zcode-mcp.config.json`，其他字段按原配置保留：

   ```json
   {
     "freeSession": "<本机已成功测试的免费桥会话 id>",
     "forkCliDir": "<fork绝对路径>/apps/zcode-cli/packages/cli",
     "forkBuiltinConfig": "<本地免费provider目录副本的绝对路径>"
   }
   ```

   `forkCliDir` 指向 CLI **包目录**，不是 fork 根目录或装机版 `zcode.cjs`。
   保留 fork 目录、`node_modules` 和依赖的 `dist`；MCP 不会自动下载或构建它们。
5. 运行 `node zcode-mcp.mjs --doctor` 检查路径，重载 MCP 客户端的 `zcode` 连接，
   然后通过 `glm_ask` 做一次实际免费调用：

   ```json
   {
     "model": "glm-free",
     "task": "Reply only MCP_START_PLAN_OK and the result of 2+2. Do not use tools or change files.",
     "timeout_seconds": 90
   }
   ```

   应检查返回文本及 `isError`，不能只看工具出现在列表里。旧客户端进程可能仍缓存
   配置，改完本地配置后必须重载连接。不要上传上述本机配置、会话库或凭据。

### `Model creation failed` 排障

这是 CLI 的外层错误，**不能仅凭这句话判断未登录、额度用尽或服务故障**。
先从返回文本取 `traceId`，在 `~/.zcode/cli/log/zcode-<date>.jsonl` 中找到对应的
`turn.failed`，检查 `error.cause`；分享日志前删去凭据与无关用户内容。

| 证据 | 下一步 |
|---|---|
| cause 为 `Select a model before continuing`，请求的是 Start Plan | 检查是否误用装机版 CLI、fork 分支/已构建 dist、免费默认选择与桥会话的 provider/model、桌面免费凭据是否可用 |
| 返回 `glm-free 未配置` 或 fork 路径无效 | 补齐本地三个免费配置字段；运行 `--doctor`，再重载连接 |
| 选中模型后返回 `exceed quota limit` | 已到模型服务阶段；停止重复调用，等待账号免费配额恢复，窗口长度未确定 |
| 返回 3012/405 | 检查客户端兼容性与实际 CLI 请求路径；不得通过裸调网关或绕过校验解决 |

2026-10-05 的一次装机版 0.16.9 实测在约 5.6 秒后报模型创建失败，底层 cause 为
`Select a model before continuing`。源码显示其独立账号解析未纳入 Start Plan，
只写免费默认模型配置不足以启用该通道；需使用上面已构建的 fork。

### 本次实测范围（2026-10-05）

使用 fork 提交 `b23dfa2b43100dbd6acd511908d2ea7f87148270` 的 Start Plan /
GLM-5.3-Flash，免费 provider/model 白名单，无付费回退：隔离 CLI 调用约 14.7 秒
返回 `START_PLAN_OK 1+1 = 2`；新 MCP 经官方 MCP SDK 调用约 23.8 秒返回
`MCP_START_PLAN_OK 4`，`isError=false`。

这是单机、当时账号权益下的实际请求结果，不保证其他账号、平台或未来版本可用。
MCP 成功调用仍有非致命 stderr 提示 `ZCode Built-in missing`，尚未定位。
bootstrap 及依赖构建成功；全仓库 typecheck 遭内存不足、lint 异常退出，未通过。
免费通道仍属实验性，账号风险自担；不将本次请求成功等同于全仓库验证通过。

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
test-client.mjs              端到端自测客户端
repair-cli.mjs                 已有桌面凭据的 CLI 元数据修复(不解密 token)
repair-cli.test.mjs            修复的隔离回归测试(node --test repair-cli.test.mjs)
zcode-mcp.config.example.json    配置模板
AGENTS.md                        给 AI 维护者的操作手册(坑位与排障)
```

## 许可

MIT。基于开源项目 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的生态构建,与 Z.ai 无官方关联。
