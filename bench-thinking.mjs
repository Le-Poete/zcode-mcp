// 思考时长基准测试:四档复杂度,每档记录端到端耗时+逐请求明细(从 rollout 解析)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLLOUT = join(homedir(), ".zcode/cli/rollout/model-io-sess_eb710a5e-aecd-41b3-9433-8149863000f8.jsonl");

const TASKS = [
  ["T1-极简", "只回复一个字:好"],
  ["T2-简单心算", "心算 17*23+46/2,给出过程和结果"],
  ["T3-中等推理", "一个3升桶和5升桶,如何精确量出4升水?给出步骤。"],
  ["T4-复杂任务", "用纯Python写一个函数:判断任意字符串的所有括号()[]{}是否合法嵌套闭合,给出至少5组测试用例并解释算法复杂度。"],
];

const server = spawn(process.execPath, ["zcode-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0; const pending = new Map();
function request(method, params) {
  return new Promise((resolve) => {
    const id = ++nextId; pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
let buf = "";
server.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});

function rolloutStats() {
  const lines = readFileSync(ROLLOUT, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    try {
      const d = JSON.parse(l);
      const u = d.response?.usage ?? {};
      const pm = d.response?.providerMetadata?.anthropic?.usage ?? {};
      return {
        dur: d.durationMs, effort: d.request?.body?.output_config?.effort,
        out: u.outputTokens ?? pm.output_tokens ?? 0,
        in: u.inputTokens ?? pm.input_tokens ?? 0,
        cache: u.cacheReadTokens ?? pm.cache_read_input_tokens ?? 0,
        text: (d.response?.text ?? "").length,
      };
    } catch { return null; }
  }).filter(Boolean);
}

await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let prevCount = rolloutStats().length;
for (const [name, task] of TASKS) {
  const t0 = Date.now();
  const m = await request("tools/call", { name: "glm_ask", arguments: { task, model: "glm-free", timeout_seconds: 300 } });
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  const all = rolloutStats();
  const mine = all.slice(prevCount); prevCount = all.length;
  const think = mine.reduce((s, r) => s + r.dur, 0) / 1000;
  console.log(`${name} | 端到端${wall}s | 模型请求${mine.length}次累计${think.toFixed(0)}s | effort=${mine[0]?.effort ?? "?"} | out_tok=${mine.reduce((s,r)=>s+r.out,0)} | isError=${m.result.isError}`);
  mine.forEach((r, i) => console.log(`   req#${i + 1}: ${r.dur}ms out=${r.out} text=${r.text}字`));
  console.log(`   回答摘要: ${m.result.content[0].text.trim().slice(0, 60).replace(/\n/g, " ")}`);
}
server.kill();
process.exit(0);
