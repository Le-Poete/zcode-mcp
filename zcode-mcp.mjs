#!/usr/bin/env node
/**
 * zcode-mcp —— 把本机 ZCode(GLM, 走你的 coding plan 订阅)暴露为 MCP 工具,
 * 供 ChatGPT / Claude Desktop / Cursor 等任意 MCP 客户端调用:
 * 让 GPT 当编排者, 把编码/执行类子任务整包委派给 GLM agent。
 *
 * 零依赖:手写 MCP stdio 协议(JSON-RPC 2.0)。
 * 前提:本机 CLI 已 `zcode login`(OAuth 一次)。
 *
 * 启动:node zcode-mcp.mjs            (由 MCP 客户端以 stdio 方式拉起)
 * 环境变量:
 *   ZCODE_BIN   zcode CLI 入口,默认用桌面版自带的 zcode.cjs
 *   ZCODE_MCP_SANDBOX  glm_ask 默认工作目录(可写沙箱)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { repairCliMetadata } from "./repair-cli.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/** 本地配置(不入库):zcode-mcp.config.json,字段见 zcode-mcp.config.example.json。
 *  相对路径一律相对配置文件所在目录解析(MCP 客户端如 ChatGPT 的 cwd 不可靠,
 *  不要依赖它;本文件里的相对路径永远锚定在项目自身)。 */
function resolvePath(p) {
  if (!p) return p;
  return isAbsolute(p) ? p : join(SELF_DIR, p);
}
function loadLocalConfig() {
  const p = join(SELF_DIR, "zcode-mcp.config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
const localConfig = loadLocalConfig();

/** 装机版 ZCode CLI 自动探测:按安装形态逐一尝试常见位置。
 *  优先 %LOCALAPPDATA%(可被重定向),回退 homedir 推导。
 *  MSIX/商店版装在 WindowsApps(ACL 受限通常不可直读),由 --doctor 给出指引。 */
function detectInstalledCli() {
  const programFiles = process.env.ProgramFiles || "C:/Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const candidates = [
    join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
    join(programFiles, "ZCode", "resources", "glm", "zcode.cjs"),
    join(programFilesX86, "ZCode", "resources", "glm", "zcode.cjs"),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

/** 装机版 CLI 的运行时环境:显式注入内置/个人 provider 配置路径。
 *  实测 Program Files 安装形态下 CLI 自身的相对探测会推算错误
 *  (试 resources/glm/provider/ 等不存在路径);两种安装形态下真实布局都是
 *  <cli>/../config/provider/zcode-builtin.json,从 CLI 自身位置推导最稳。 */
function cliRuntimeEnv() {
  const env = { ...process.env };
  if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    const p = join(dirname(ZCODE_BIN), "..", "config", "provider", "zcode-builtin.json");
    if (existsSync(p)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = p;
  }
  if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    const p = join(env.ZCODE_DATA_BASE_DIR || homedir(), ".zcode", "v2", "provider_config.json");
    if (existsSync(p)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = p;
  }
  return env;
}
const ZCODE_BIN =
  process.env.ZCODE_BIN || resolvePath(localConfig.installedCli) || detectInstalledCli();
const DEFAULT_SANDBOX =
  process.env.ZCODE_MCP_SANDBOX ||
  resolvePath(localConfig.sandbox) ||
  join(homedir(), "zcode-mcp-sandbox");
/** Flash 桥会话:其持久化 model_selection=GLM-5.3-Flash,flash 调用经 --resume 复用它。 */
const FLASH_SESSION = process.env.ZCODE_MCP_FLASH_SESSION || localConfig.flashSession || "";
/** 免费档(Start Plan)桥会话:走 fork 源码 CLI(支持 start-plan 的补丁版)。 */
const FREE_SESSION = process.env.ZCODE_MCP_FREE_SESSION || localConfig.freeSession || "";
/** fork 源码 CLI 目录:standalone 运行时已补 start-plan 支持(需先 build bootstrap)。 */
const ZCODE_SRC_CLI_DIR = process.env.ZCODE_MCP_SRC_CLI_DIR || resolvePath(localConfig.forkCliDir) || "";
const ZCODE_SRC_BUILTIN_CONFIG =
  process.env.ZCODE_MCP_SRC_BUILTIN_CONFIG || resolvePath(localConfig.forkBuiltinConfig) || "";

/** `node zcode-mcp.mjs --doctor`:路径自检。给人和 AI 客户端排查"找不到文件"用。
 *  退出码:有关键路径 MISS 时非 0,脚本可依赖。 */
function runDoctor() {
  const lines = [];
  let missCount = 0;
  const check = (label, path, extra = "") => {
    const ok = Boolean(path && existsSync(path));
    if (!ok) missCount += 1;
    lines.push(`${ok ? "OK  " : "MISS"} ${label}: ${path || "(未配置)"}${extra}`);
    return ok;
  };
  lines.push(`node: ${process.version} | cwd: ${process.cwd()}`);
  lines.push(`self: ${SELF_DIR}`);
  // 只把「已启用通道的必需项」计入失败:fork 未配置=禁用而非缺失;
  // installedCli 在 free-only(freeSession 已配且 flash 未配)时才非必需——
  // 默认通道与 glm_models 恒需装机版;flash 需装机版;free 只需 fork。
  const freeEnabled = Boolean(FREE_SESSION);
  const flashEnabled = Boolean(FLASH_SESSION);
  const installedCliRequired = !freeEnabled || flashEnabled;
  let cliOk = existsSync(ZCODE_BIN);
  lines.push(`${cliOk ? "OK  " : installedCliRequired ? "MISS" : "WARN"} installedCli(装机版 CLI): ${ZCODE_BIN}${cliOk ? "" : installedCliRequired ? "" : "(free-only 布局,非必需)"}`);
  if (!cliOk && installedCliRequired) missCount += 1;
  if (!cliOk) {
    lines.push("     ├ 探测过: %LOCALAPPDATA%\\Programs、%ProgramFiles%、%ProgramFiles(x86)%");
    lines.push("     └ 仍 MISS 的常见原因:MSIX/商店版(WindowsApps 内 ACL 受限不可直读,");
    lines.push("        建议改装桌面安装版),或自定义安装目录(把完整路径填进 installedCli)。");
    lines.push("     └ 定位命令: powershell -c \"Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -EA 0 | ? DisplayName -like '*ZCode*' | % InstallLocation\"");
  }
  if (freeEnabled) {
    check("forkCliDir 源码入口", ZCODE_SRC_CLI_DIR ? join(ZCODE_SRC_CLI_DIR, "src", "main.ts") : "");
    check("forkBuiltinConfig", ZCODE_SRC_BUILTIN_CONFIG);
  } else {
    lines.push("DISABLED fork(glm-free 未配置 freeSession,不计为缺失)");
  }
  lines.push(`     sandbox: ${DEFAULT_SANDBOX}`);
  lines.push(`     flashSession: ${FLASH_SESSION ? "已配置" : "未配置(glm-5.3-flash 禁用)"}`);
  lines.push(`     freeSession: ${FREE_SESSION ? "已配置" : "未配置(glm-free 禁用)"}`);
  lines.push(`     通道依赖: 默认/glm_models/glm-5.3-flash → 装机版CLI;glm-free → fork`);
  lines.push(`     登录状态: 无法离线检测;真实调用报 "Select a model" 通常需 login(见 README「登录」)`);
  lines.push(`     已在桌面登录但 CLI 无模型: --repair-cli 预览元数据修复，--repair-cli --apply 执行。`);
  lines.push("");
  lines.push("提示:MCP 客户端(ChatGPT/Claude)配置里的 args 必须是绝对路径;");
  lines.push("本文件所在目录见上方 self 行,把该目录拼到文件名前即可。");
  console.log(lines.join("\n"));
  return missCount > 0 ? 1 : 0;
}

const NODE = process.execPath;

function runSourceZcode(args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      mkdirSync(DEFAULT_SANDBOX, { recursive: true });
    } catch {}
    const child = spawn(NODE, ["--import", "tsx", "src/main.ts", ...args], {
      cwd: ZCODE_SRC_CLI_DIR,
      env: {
        ...process.env,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_SRC_BUILTIN_CONFIG,
      },
      shell: false,
      windowsHide: true,
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, out, err: err + `\n[zcode-mcp] 超时 ${timeoutMs}ms 已终止` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

function runZcode(args, timeoutMs) {
  return new Promise((resolve) => {
    // spawn 的 cwd 不存在会直接 ENOENT;沙箱目录按需创建(glm_models 等入口也会走到这里)。
    try {
      mkdirSync(DEFAULT_SANDBOX, { recursive: true });
    } catch {}
    const child = spawn(NODE, [ZCODE_BIN, ...args], {
      cwd: DEFAULT_SANDBOX,
      env: cliRuntimeEnv(),
      shell: false,
      windowsHide: true,
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, out, err: err + `\n[zcode-mcp] 超时 ${timeoutMs}ms 已终止` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

const TOOLS = [
  {
    name: "glm_ask",
    description:
      "向 GLM(Z.ai 编码智能体,具备读写文件/执行命令等完整工具链)委派一个任务并等待完成," +
      "返回最终答复文本。适合让另一个 AI 把编码、排查、抓取等子任务整包外包给 GLM。" +
      "每次调用是一个独立的 ZCode 无头会话,秒到分钟级,不适合闲聊式逐句对话。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "要委派给 GLM 的完整任务描述(中文/英文均可)" },
        model: {
          type: "string",
          enum: ["glm-5.3", "glm-5.3-flash", "glm-free"],
          description:
            "可选:glm-5.3(默认,强,耗订阅)/ glm-5.3-flash(快,耗订阅)/ glm-free(免费档 GLM-5.3-Flash,不耗订阅额度)",
        },
        workdir: {
          type: "string",
          description: "可选:GLM 的工作目录(绝对路径)。缺省用本机沙箱目录(见 --doctor 输出)",
        },
        timeout_seconds: { type: "number", description: "可选:超时秒数,默认 300" },
      },
      required: ["task"],
    },
  },
  {
    name: "glm_models",
    description: "查询当前账号(coding plan)可用的 GLM 模型目录及推理档位。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args) {
  if (name === "glm_models") {
    const r = await runZcode(
      [
        "-p",
        "调用你的 list-models 工具,原样列出每个模型的 providerId/modelId 与 reasoningLevels,不要省略。",
        "--cwd",
        DEFAULT_SANDBOX,
      ],
      120_000,
    );
    return { content: [{ type: "text", text: r.out.trim() || r.err.trim() }], isError: r.code !== 0 };
  }
  if (name !== "glm_ask")
    return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };

  // 参数校验:非法值直接拒绝,不静默落到默认通道(否则拼写错误会悄悄烧订阅额度)。
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    return {
      content: [{ type: "text", text: "参数错误:task 必填(要委派给 GLM 的完整任务描述)。" }],
      isError: true,
    };
  }
  const VALID_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-free"];
  const model = String(args.model || "").toLowerCase();
  if (model && !VALID_MODELS.includes(model)) {
    return {
      content: [{ type: "text", text: `参数错误:model 必须是 ${VALID_MODELS.join(" / ")} 之一或省略,收到:${JSON.stringify(args.model)}` }],
      isError: true,
    };
  }

  const workdir = args.workdir || DEFAULT_SANDBOX;
  mkdirSync(workdir, { recursive: true });
  const timeoutMs = Math.min(Math.max((args.timeout_seconds ?? 300) * 1000, 10_000), 900_000);

  // 通道分流:glm-free 走 fork 源码 CLI(只依赖 fork 自身文件,不要求装机版);
  // flash / 默认走装机版 CLI(存在性检查在本分支内做)。
  let r;
  if (model === "glm-free") {
    if (!FREE_SESSION || !ZCODE_SRC_CLI_DIR || !ZCODE_SRC_BUILTIN_CONFIG) {
      return {
        content: [{ type: "text", text: "glm-free 未配置:需要在 zcode-mcp.config.json 或环境变量里提供 freeSession/forkCliDir/forkBuiltinConfig(见 README「免费档」一章)。" }],
        isError: true,
      };
    }
    const forkEntry = join(ZCODE_SRC_CLI_DIR, "src", "main.ts");
    if (!existsSync(forkEntry) || !existsSync(ZCODE_SRC_BUILTIN_CONFIG)) {
      return {
        content: [{ type: "text", text: `glm-free 的 fork 路径无效: 入口 ${forkEntry} 或内置配置 ${ZCODE_SRC_BUILTIN_CONFIG} 不存在。请核对该 fork 仓库是否已克隆/切换分支。` }],
        isError: true,
      };
    }
    r = await runSourceZcode(
      ["--resume", FREE_SESSION, "-p", task, "--cwd", workdir, "--mode", "yolo"],
      timeoutMs,
    );
  } else {
    if (model === "glm-5.3-flash" && !FLASH_SESSION) {
      return {
        content: [{ type: "text", text: "glm-5.3-flash 未配置:需要 flashSession(见 README)。" }],
        isError: true,
      };
    }
    if (!existsSync(ZCODE_BIN)) {
      return {
        content: [{ type: "text", text: `找不到 ZCode CLI: ${ZCODE_BIN}\n已探测 %LOCALAPPDATA%\\Programs 与 %ProgramFiles% 常见位置;运行 node zcode-mcp.mjs --doctor 查看详情(含 MSIX 版说明与注册表定位命令)。` }],
        isError: true,
      };
    }
    const cliArgs =
      model === "glm-5.3-flash"
        ? ["--resume", FLASH_SESSION, "-p", task, "--cwd", workdir, "--mode", "yolo"]
        : ["-p", task, "--cwd", workdir, "--mode", "yolo"];
    r = await runZcode(cliArgs, timeoutMs);
  }
  let text = (r.out.trim() || "") + (r.err.trim() ? `\n[stderr]\n${r.err.trim()}` : "");
  // 错误提示按具体程度区分,不做超出证据的归因:
  // "Select a model" 是明确的"无模型选择"标志(未登录的常见表现,但不排除其他成因);
  // 泛化的 "Model creation failed" 只指向日志排查。
  if (/Select a model before continuing/i.test(text)) {
    text +=
      "\n\n[zcode-mcp] 该错误含义是 CLI 当前没有可用的模型选择。常见原因是本机 CLI 未登录" +
      "(登录会写入默认模型选择),也可能是账号套餐或 provider 配置问题——请以日志中的具体 cause 为准。" +
      "若是未登录:按 README「登录」一节执行一次 login bigmodel(国内账号)。";
  } else if (/Model creation failed/i.test(text)) {
    const trace = text.match(/traceId[=: ]+([0-9a-f-]{36})/i)?.[1];
    text +=
      `\n\n[zcode-mcp] 模型创建失败的成因需看具体 cause(未登录/套餐/provider 配置等均可能)。` +
      `请在 ~/.zcode/cli/log/ 的当日 jsonl 日志中检索 ${trace ?? "返回文本里的 traceId"} 定位。`;
  }
  return { content: [{ type: "text", text: text || "(无输出)" }], isError: r.code !== 0 };
}

const rl = (await import("node:readline")).createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

if (process.argv.includes("--doctor")) {
  rl.close();
  process.exit(runDoctor());
}

if (process.argv.includes("--repair-cli")) {
  rl.close();
  try {
    const env = cliRuntimeEnv();
    console.log(JSON.stringify(repairCliMetadata({ env,
      builtinPath: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
      apply: process.argv.includes("--apply") }), null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`[zcode-mcp] 元数据修复失败: ${e.message}`);
    process.exit(1);
  }
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  (async () => {
    if (method === "initialize")
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "zcode-mcp", version: "0.1.0" },
        },
      });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments || {});
      return send({ jsonrpc: "2.0", id, result });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  })().catch((e) => send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } }));
});
