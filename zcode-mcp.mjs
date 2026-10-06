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
 * 维护:node zcode-mcp.mjs --doctor | --repair-cli [--apply]
 *
 * v0.2.0 规范面:工具 annotations / outputSchema+structuredContent /
 * notifications/progress 心跳 / notifications/cancelled 取消(杀子进程,省额度) /
 * glm_models 离线目录(零模型调用) / 可选 mode 参数 / instructions。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { repairCliMetadata } from "./repair-cli.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION = "0.2.0";
/** 委派任务的 prompt 上限:防误传巨文本打爆一次调用。 */
const TASK_MAX_CHARS = 32_000;

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

const ZCODE_BIN =
  process.env.ZCODE_BIN || resolvePath(localConfig.installedCli) || detectInstalledCli();

/** 装机版 CLI 的运行时环境:显式注入内置/个人 provider 配置路径。
 *  实测 Program Files 安装形态下 CLI 自身的相对探测会推算错误
 *  (试 resources/glm/provider/ 等不存在路径);两种安装形态下真实布局都是
 *  <cli>/../config/provider/zcode-builtin.json,从 CLI 自身位置推导最稳。 */
function cliRuntimeEnv(env = process.env) {
  const out = { ...env };
  if (!out.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    const p = join(dirname(ZCODE_BIN), "..", "config", "provider", "zcode-builtin.json");
    if (existsSync(p)) out.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = p;
  }
  if (!out.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    const p = join(out.ZCODE_DATA_BASE_DIR || homedir(), ".zcode", "v2", "provider_config.json");
    if (existsSync(p)) out.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = p;
  }
  return out;
}

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

/** 进行中的调用:requestId → { kill, cancelled };取消通知据此终止子进程。 */
const pendingCalls = new Map();
/** 被取消的请求 id:其响应按规范抑制不回发。 */
const suppressedResponses = new Set();

function makeRunner(spawnArgs, cwd, env) {
  return function run(timeoutMs, onSpawn) {
    return new Promise((resolve) => {
      try {
        mkdirSync(DEFAULT_SANDBOX, { recursive: true });
      } catch {}
      const child = spawn(NODE, spawnArgs, { cwd, env, shell: false, windowsHide: true });
      if (onSpawn) onSpawn(child);
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
  };
}

/** 装机版通道(默认/flash):cwd=沙箱,注入内置/个人配置路径。 */
function runZcode(args, timeoutMs, onSpawn) {
  return makeRunner([ZCODE_BIN, ...args], DEFAULT_SANDBOX, cliRuntimeEnv())(timeoutMs, onSpawn);
}
/** fork 源码通道(glm-free):tsx 直跑源码,注入 fork 的内置配置。 */
function runSourceZcode(args, timeoutMs, onSpawn) {
  return makeRunner(
    ["--import", "tsx", "src/main.ts", ...args],
    ZCODE_SRC_CLI_DIR,
    { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_SRC_BUILTIN_CONFIG },
  )(timeoutMs, onSpawn);
}

/* ============================================================================
 * glm_models 离线目录:从内置配置 + 凭据键名确定性推导,零模型调用、零 token。
 * 凭据只读「键名」判权益,值(可能加密)从不解密——与 repair-cli 同一安全边界。
 * reasoningLevels 为 2026-10-06 双模型实测结论(low/high/max),上游未提供静态档位表。
 * ==========================================================================*/
function localModelCatalog() {
  const base = process.env.ZCODE_DATA_BASE_DIR || homedir();
  const credPath = join(base, ".zcode", "v2", "credentials.json");
  const personalPath =
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(base, ".zcode", "v2", "provider_config.json");
  const builtinPath =
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ||
    join(dirname(ZCODE_BIN), "..", "config", "provider", "zcode-builtin.json");

  const entitled = new Set();
  try {
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    for (const key of Object.keys(creds)) {
      const m = key.match(/^account-provider:coding-plan:(account:.+?):account:[^:]+:api-key$/);
      if (m) entitled.add(m[1]);
    }
    if (typeof creds.zcodejwttoken === "string" && creds.zcodejwttoken.trim()) {
      entitled.add("account:zai-start-plan");
      entitled.add("account:bigmodel-start-plan");
    }
  } catch {}

  let models = [];
  try {
    const builtin = JSON.parse(readFileSync(builtinPath, "utf8"));
    const rules = builtin.config?.providerConfigRules?.providerRules ?? [];
    for (const rule of rules) {
      const access = rule.config?.access;
      if (access?.type !== "zhipu-account") continue;
      if (!["individual-coding-plan", "start-plan"].includes(access.mode)) continue;
      if (!entitled.has(rule.providerId)) continue;
      for (const modelId of rule.config.builtinModelIds ?? []) {
        models.push({ providerId: rule.providerId, modelId });
      }
    }
  } catch {}

  let defaultSel = null;
  try {
    const personal = JSON.parse(readFileSync(personalPath, "utf8"));
    defaultSel = personal.config?.defaultModelSelection ?? null;
  } catch {}

  const seen = new Set();
  const catalog = [];
  for (const m of models) {
    const k = `${m.providerId}/${m.modelId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    catalog.push({
      providerId: m.providerId,
      modelId: m.modelId,
      reasoningLevels: ["low", "high", "max"],
      isDefault: Boolean(
        defaultSel && defaultSel.providerId === m.providerId && defaultSel.modelId === m.modelId,
      ),
    });
  }
  return { models: catalog, source: "local-catalog" };
}

/* ============================================================================
 * 工具定义:annotations 供调用方预判风险;outputSchema 供程序化消费结果。
 * ==========================================================================*/
const GLM_ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "任务是否成功完成" },
    answer: { type: "string", description: "GLM 的完整答复(含错误提示与成本回执)" },
    channel: { type: "string", description: "实际使用的模型通道" },
    elapsedSeconds: { type: "number", description: "端到端耗时(秒)" },
    errorKind: {
      type: "string",
      enum: ["none", "param", "not-configured", "cli-missing", "quota", "no-model-selection", "model-creation", "timeout", "cancelled", "unknown"],
      description: "失败时的机器可读类别:quota→稍后重试或切通道;no-model-selection→引导登录/repair-cli;timeout→拆小任务",
    },
  },
  required: ["ok", "answer", "channel", "elapsedSeconds", "errorKind"],
};

const GLM_MODELS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          modelId: { type: "string" },
          reasoningLevels: { type: "array", items: { type: "string" } },
          isDefault: { type: "boolean" },
        },
        required: ["providerId", "modelId", "reasoningLevels", "isDefault"],
      },
    },
    source: { type: "string" },
  },
  required: ["models", "source"],
};

const TOOLS = [
  {
    name: "glm_ask",
    title: "委派任务给 GLM",
    description:
      "向 GLM(Z.ai 编码智能体,具备读写文件/执行命令等完整工具链)委派一个任务并等待完成," +
      "返回最终答复文本。适合让另一个 AI 把编码、排查、抓取等子任务外包给 GLM。" +
      "每次调用是一个独立的 ZCode 无头会话,秒到分钟级,不适合闲聊式逐句对话。" +
      "[委派方必读的任务粒度契约] 单次任务应控制在2分钟可完成的粒度:批量生成类工作" +
      "(如生成N个关卡/组件/数据条目)必须循环调用、每次1-2个,禁止要求一次输出大批量JSON;" +
      "大项目拆成多次小委派再自行组装。超粒度任务会导致思考时长与失败率急剧上升" +
      "(实测:单步任务≤90s,多轮复利任务可达20分钟)。返回末尾附成本回执,请据其调整粒度。",
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
        mode: {
          type: "string",
          enum: ["yolo", "plan", "edit"],
          description: "可选:权限模式,默认 yolo(全自动);plan=只读分析不改文件;edit=改动自动应用。只读分析类委派建议用 plan",
        },
      },
      required: ["task"],
    },
    outputSchema: GLM_ASK_OUTPUT_SCHEMA,
    annotations: {
      title: "委派任务给 GLM",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "glm_models",
    title: "查询 GLM 模型目录",
    description:
      "本地秒级查询当前账号可用的 GLM 模型目录(通道/档位/默认模型)。纯离线推导," +
      "不发起模型调用、不消耗额度。",
    inputSchema: { type: "object", properties: {} },
    outputSchema: GLM_MODELS_OUTPUT_SCHEMA,
    annotations: {
      title: "查询 GLM 模型目录",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** 统一结果组装:人读全文走 content,结构化镜像走 structuredContent(规范双写)。 */
function glmAskResult({ text, ok, channel, elapsedSeconds, errorKind }) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok, answer: text, channel, elapsedSeconds, errorKind },
    isError: !ok,
  };
}

/** 从 CLI 输出归类机器可读错误类别;找不到明确模式归 unknown。 */
function classifyError(text) {
  // 订阅档 5 小时窗口上限(1308)与免费档滚动配额同属 quota 类,决策都是"等待或切通道"。
  if (/exceed quota limit|使用上限|\[1308\]/i.test(text)) return "quota";
  if (/Select a model before continuing/i.test(text)) return "no-model-selection";
  if (/Model creation failed/i.test(text)) return "model-creation";
  if (/超时 .* 已终止/.test(text)) return "timeout";
  return "unknown";
}

async function callTool(name, args, requestId) {
  /* ---- glm_models:零模型调用,离线秒回 ---- */
  if (name === "glm_models") {
    const cat = localModelCatalog();
    const lines = cat.models.map(
      (m) =>
        `${m.isDefault ? "[default] " : ""}${m.providerId}/${m.modelId}  档位:${m.reasoningLevels.join("/")}`,
    );
    const text =
      (lines.length ? lines.join("\n") : "(未发现已授权通道的模型;检查登录状态或 --repair-cli)") +
      `\n[source: ${cat.source}]`;
    return {
      content: [{ type: "text", text }],
      structuredContent: cat,
      isError: false,
    };
  }
  if (name !== "glm_ask")
    return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };

  /* ---- glm_ask ---- */
  const startedAtAll = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAtAll) / 1000);
  const channelName = String(args.model || "glm-5.3");
  const fail = (text, errorKind) =>
    glmAskResult({ text, ok: false, channel: channelName, elapsedSeconds: elapsed(), errorKind });

  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task)
    return fail("参数错误:task 必填(要委派给 GLM 的完整任务描述)。", "param");
  if (task.length > TASK_MAX_CHARS)
    return fail(`参数错误:task 超过 ${TASK_MAX_CHARS} 字符上限(收到 ${task.length})。请拆分任务。`, "param");
  const VALID_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-free"];
  const model = String(args.model || "").toLowerCase();
  if (model && !VALID_MODELS.includes(model))
    return fail(`参数错误:model 必须是 ${VALID_MODELS.join(" / ")} 之一或省略,收到:${JSON.stringify(args.model)}`, "param");
  const VALID_MODES = ["yolo", "plan", "edit"];
  const mode = String(args.mode || "yolo").toLowerCase();
  if (!VALID_MODES.includes(mode))
    return fail(`参数错误:mode 必须是 ${VALID_MODES.join(" / ")} 之一,收到:${JSON.stringify(args.mode)}`, "param");

  const workdir = args.workdir || DEFAULT_SANDBOX;
  mkdirSync(workdir, { recursive: true });
  const timeoutMs = Math.min(Math.max((args.timeout_seconds ?? 300) * 1000, 10_000), 900_000);

  // 取消挂钩:请求被客户端取消时终止子进程,不再烧到超时。
  let killChild = null;
  let cancelled = false;
  const onSpawn = (child) => {
    killChild = () => {
      cancelled = true;
      if (requestId !== undefined) suppressedResponses.add(requestId);
      try {
        child.kill();
      } catch {}
    };
    if (requestId !== undefined) pendingCalls.set(requestId, killChild);
  };

  try {
    // 通道分流:glm-free 走 fork 源码 CLI(只依赖 fork 自身文件,不要求装机版);
    // flash / 默认走装机版 CLI(存在性检查在本分支内做)。
    let r;
    if (model === "glm-free") {
      if (!FREE_SESSION || !ZCODE_SRC_CLI_DIR || !ZCODE_SRC_BUILTIN_CONFIG)
        return fail("glm-free 未配置:需要在 zcode-mcp.config.json 或环境变量里提供 freeSession/forkCliDir/forkBuiltinConfig(见 README「免费档」一章)。", "not-configured");
      const forkEntry = join(ZCODE_SRC_CLI_DIR, "src", "main.ts");
      if (!existsSync(forkEntry) || !existsSync(ZCODE_SRC_BUILTIN_CONFIG))
        return fail(`glm-free 的 fork 路径无效: 入口 ${forkEntry} 或内置配置 ${ZCODE_SRC_BUILTIN_CONFIG} 不存在。请核对该 fork 仓库是否已克隆/切换分支。`, "not-configured");
      const startedAt = Date.now();
      r = await runSourceZcode(
        ["--resume", FREE_SESSION, "-p", task, "--cwd", workdir, "--mode", mode],
        timeoutMs,
        onSpawn,
      );
      // 免费档配额是账号级共享池(桌面端也在消耗),超限是滚动窗口、分钟级自愈:
      // 预算允许时延迟重试一次,把瞬时窗口耗尽消化掉而不是直接报错。
      if (
        !cancelled &&
        /exceed quota limit/i.test(r.out + r.err) &&
        timeoutMs - (Date.now() - startedAt) > 45_000
      ) {
        await new Promise((res) => setTimeout(res, 30_000));
        r = await runSourceZcode(
          ["--resume", FREE_SESSION, "-p", task, "--cwd", workdir, "--mode", mode],
          timeoutMs,
          onSpawn,
        );
      }
    } else {
      if (model === "glm-5.3-flash" && !FLASH_SESSION)
        return fail("glm-5.3-flash 未配置:需要 flashSession(见 README)。", "not-configured");
      if (!existsSync(ZCODE_BIN))
        return fail(`找不到 ZCode CLI: ${ZCODE_BIN}\n已探测 %LOCALAPPDATA%\\Programs 与 %ProgramFiles% 常见位置;运行 node zcode-mcp.mjs --doctor 查看详情(含 MSIX 版说明与注册表定位命令)。`, "cli-missing");
      const cliArgs =
        model === "glm-5.3-flash"
          ? ["--resume", FLASH_SESSION, "-p", task, "--cwd", workdir, "--mode", mode]
          : ["-p", task, "--cwd", workdir, "--mode", mode];
      r = await runZcode(cliArgs, timeoutMs, onSpawn);
    }

    if (cancelled)
      return fail("任务已被调用方取消,子进程已终止(不再消耗额度)。", "cancelled");

    let text = (r.out.trim() || "") + (r.err.trim() ? `\n[stderr]\n${r.err.trim()}` : "");
    const errorKind = r.code === 0 ? "none" : classifyError(text);
    // 成本回执:给委派方(GPT等)可见的代价反馈,促使其自我调节任务粒度。
    if (!r.code) text += `\n\n[zcode-mcp 成本回执] 通道=${model || "glm-5.3"} 耗时=${elapsed()}s`;
    // 免费档配额超限的可操作提示(订阅档 1308 的文案自带重置时间,无需附加)。
    if (errorKind === "quota" && /exceed quota limit/i.test(text)) {
      text +=
        "\n\n[zcode-mcp] 免费档配额窗口已耗尽(账号级共享池,桌面端使用也消耗同一额度)。" +
        "通常数分钟内自动恢复;期间可改用 model=glm-5.3-flash(订阅额度)继续。";
    }
    // 错误提示按具体程度区分,不做超出证据的归因:
    // "Select a model" 是明确的"无模型选择"标志(未登录的常见表现,但不排除其他成因);
    // 泛化的 "Model creation failed" 只指向日志排查。
    if (errorKind === "no-model-selection") {
      text +=
        "\n\n[zcode-mcp] 该错误含义是 CLI 当前没有可用的模型选择。常见原因是本机 CLI 未登录" +
        "(登录会写入默认模型选择),也可能是账号套餐或 provider 配置问题——请以日志中的具体 cause 为准。" +
        "若是未登录:按 README「登录」一节执行一次 login bigmodel(国内账号);" +
        "已有桌面登录则可跑 node zcode-mcp.mjs --repair-cli --apply 恢复元数据。";
    } else if (errorKind === "model-creation") {
      const trace = text.match(/traceId[=: ]+([0-9a-f-]{36})/i)?.[1];
      text +=
        `\n\n[zcode-mcp] 模型创建失败的成因需看具体 cause(未登录/套餐/provider 配置等均可能)。` +
        `请在 ~/.zcode/cli/log/ 的当日 jsonl 日志中检索 ${trace ?? "返回文本里的 traceId"} 定位。`;
    } else if (r.code === 124) {
      text +=
        "\n\n[zcode-mcp] 到达超时上限。建议:拆小任务分多次 glm_ask,或调高 timeout_seconds。" +
        "实测参考:单步任务≤90s,多轮 agent 任务每轮 6-25s。";
    }
    return glmAskResult({
      text: text || "(无输出)",
      ok: r.code === 0,
      channel: model || "glm-5.3",
      elapsedSeconds: elapsed(),
      errorKind,
    });
  } finally {
    if (requestId !== undefined) pendingCalls.delete(requestId);
  }
}

const rl = (await import("node:readline")).createInterface({ input: process.stdin });
const send = (msg) => {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {}
};

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

  // 取消通知:杀子进程并抑制响应(规范:被取消的请求不回发结果)。
  if (method === "notifications/cancelled") {
    const kill = pendingCalls.get(params?.requestId);
    if (kill) {
      suppressedResponses.add(params.requestId);
      kill();
    }
    return;
  }

  if (id === undefined) return; // 其余 notification
  (async () => {
    if (method === "initialize")
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "zcode-mcp", version: SERVER_VERSION, title: "ZCode GLM Bridge" },
          instructions:
            "glm_ask 把编码/排查任务委派给本机 GLM agent(单次保持 ≤2 分钟粒度,批量生成循环调用每次 1-2 个;" +
            "只读分析用 mode=plan)。glm_models 本地秒查可用模型。结果带结构化字段(ok/answer/channel/elapsedSeconds/" +
            "errorKind)与成本回执,请按 errorKind 决策:quota→稍后重试或切通道,timeout→拆小任务。",
        },
      });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      // progress 心跳:仅当客户端带了 progressToken(规范要求),每 10s 一次。
      const progressToken = params?._meta?.progressToken;
      let hb = null;
      if (progressToken !== undefined) {
        const t0 = Date.now();
        const beat = () => {
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress: Math.round((Date.now() - t0) / 1000), message: "GLM 运行中" },
          });
        };
        beat(); // 即时空拍:让调用方立刻知道任务已被受理
        hb = setInterval(beat, 10_000);
      }
      try {
        const result = await callTool(params?.name, params?.arguments || {}, id);
        // 被取消的请求按规范抑制响应。
        if (suppressedResponses.delete(id)) return;
        return send({ jsonrpc: "2.0", id, result });
      } finally {
        if (hb) clearInterval(hb);
      }
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  })().catch((e) => send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } }));
});
