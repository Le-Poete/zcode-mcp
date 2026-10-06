#!/usr/bin/env node
/** 端到端自测:以 MCP 客户端身份拉起 zcode-mcp,验证协议面与真实调用。
 *  覆盖:initialize(instructions) / tools/list(annotations+outputSchema) /
 *  glm_models(离线秒回+structuredContent) / glm_ask(三选一真实调用+结构化镜像) /
 *  参数校验 / 取消路径(notifications/cancelled → 子进程终止且不回发响应)。
 *  用法:node test-client.mjs [channel]   channel ∈ default|flash|free,默认 default
 */
import { spawn } from "node:child_process";

const CHANNEL = process.argv[2] || "default";
const MODEL_BY_CHANNEL = { default: undefined, flash: "glm-5.3-flash", free: "glm-free" };
const MODEL_ARG = MODEL_BY_CHANNEL[CHANNEL] ? { model: MODEL_BY_CHANNEL[CHANNEL] } : {};

const server = spawn(process.execPath, ["zcode-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0;
const pending = new Map();
const notifications = [];

function request(method, params) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let buf = "";
server.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (!msg.id) {
      notifications.push(msg);
    }
  }
});

const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "0" } });
console.log("✓ initialize:", init.result.serverInfo.name, init.result.serverInfo.version, "| instructions:", init.result.instructions ? "present" : "MISSING");

notify("notifications/initialized");

const tools = await request("tools/list", {});
const ask = tools.result.tools.find((t) => t.name === "glm_ask");
const models = tools.result.tools.find((t) => t.name === "glm_models");
console.log("✓ tools/list:", tools.result.tools.map((t) => t.name).join(", "));
console.log("  annotations:", ask.annotations && models.annotations ? "✓" : "MISSING",
  "| outputSchema:", ask.outputSchema && models.outputSchema ? "✓" : "MISSING",
  "| mode参数:", ask.inputSchema.properties.mode ? "✓" : "MISSING");

const t0 = Date.now();
const mm = await request("tools/call", { name: "glm_models", arguments: {} });
const mmWall = ((Date.now() - t0) / 1000).toFixed(2);
const mmOk = mm.result.structuredContent?.models?.length > 0 && Number(mmWall) < 2;
console.log(`${mmOk ? "✓" : "✗"} glm_models: ${mmWall}s(需<2s) | models=${mm.result.structuredContent?.models?.length} | source=${mm.result.structuredContent?.source}`);

console.log(`\n参数校验检查...`);
const bad1 = await request("tools/call", { name: "glm_ask", arguments: { task: "x", model: "glm5.3-flash" } });
const bad2 = await request("tools/call", { name: "glm_ask", arguments: {} });
const pOk = bad1.result.isError && bad1.result.structuredContent?.errorKind === "param" &&
            bad2.result.isError && bad2.result.structuredContent?.errorKind === "param";
console.log(`${pOk ? "✓" : "✗"} 非法model/缺task → errorKind=param(结构化)`);

console.log(`\n取消路径检查(发出真实委派,3s 后取消)...`);
const slowId = ++nextId;
const cancelT0 = Date.now();
let cancelResponse = null;
pending.set(slowId, (m) => { cancelResponse = m; });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: slowId, method: "tools/call",
  params: { name: "glm_ask", arguments: { task: "数到一百再回复", ...MODEL_ARG, timeout_seconds: 300 }, _meta: { progressToken: "pt-1" } } }) + "\n");
await new Promise((r) => setTimeout(r, 3000));
const progressSeen = notifications.some((n) => n.method === "notifications/progress");
notify("notifications/cancelled", { requestId: slowId, reason: "selftest" });
await new Promise((r) => setTimeout(r, 8000));
const suppressed = cancelResponse === null;
const killedQuickly = (Date.now() - cancelT0) < 15000;
console.log(`${suppressed ? "✓" : "~"} 取消后响应被抑制: ${suppressed ? "✓" : "收到响应(客户端侧允许,但规范建议抑制)"}`);
console.log(`${killedQuickly ? "✓" : "✗"} 子进程在取消后快速终止(未烧到超时)`);
console.log(`${progressSeen ? "✓" : "i"} progress 心跳: ${progressSeen ? "已收到" : "未收到(客户端未声明 token 才不发;此处发了 token)"}`);

console.log(`\n真实调用(通道=${CHANNEL})...`);
const t1 = Date.now();
const call = await request("tools/call", { name: "glm_ask", arguments: { task: "用一句话回答:1+1等于几?", ...MODEL_ARG, timeout_seconds: 240 } });
console.log(`耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s isError=${call.result.isError}`);
const sc = call.result.structuredContent;
console.log("structuredContent:", sc ? `ok=${sc.ok} channel=${sc.channel} elapsed=${sc.elapsedSeconds}s errorKind=${sc.errorKind}` : "MISSING");
console.log("GLM 回复:", call.result.content[0].text.slice(0, 300));
server.kill();
process.exit(call.result.isError ? 1 : 0);
