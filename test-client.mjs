#!/usr/bin/env node
/** 端到端自测:以 MCP 客户端身份拉起 zcode-mcp,走 initialize → tools/list → tools/call 全流程 */
import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["zcode-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0;
const pending = new Map();

function request(method, params) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
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
    }
  }
});

const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "0" } });
console.log("initialize:", init.result.serverInfo.name, init.result.serverInfo.version);

server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await request("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

console.log("\n调用 glm_ask(委派一个最小任务)...");
const t0 = Date.now();
const call = await request("tools/call", {
  name: "glm_ask",
  arguments: { task: "用一句话回答:1+1等于几?", timeout_seconds: 240 },
});
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s isError=${call.result.isError}`);
console.log("GLM 回复:", call.result.content[0].text.slice(0, 300));
server.kill();
process.exit(call.result.isError ? 1 : 0);
