import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

// Recover only metadata from an existing, uniquely identifiable Coding Plan key.
// No token is decrypted, requested, printed, or copied to another account/provider.
export function planCliRepair(credentials, personal, builtin) {
  if (personal.schemaVersion !== 1 || !personal.config ||
      !personal.config.providerConfigRules || !personal.config.modelConfigRules) {
    throw new Error("不支持的个人配置格式，保留原文件；请使用官方 CLI 登录。");
  }
  const catalog = builtin.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(catalog)) throw new Error("内置 provider 配置格式无效。");
  const candidates = Object.entries(credentials).flatMap(([key, value]) => {
    const m = key.match(/^account-provider:coding-plan:(account:(?:bigmodel|zai)-individual-coding-plan):account:([^:]+):api-key$/);
    if (!m || typeof value !== "string" || !value.trim()) return [];
    const provider = catalog.find(p => p.providerId === m[1] &&
      p.config?.access?.mode === "individual-coding-plan");
    const modelId = provider?.config?.builtinModelIds?.[0];
    if (!modelId) return [];
    return [{ providerId: m[1], accountIdentity: decodeURIComponent(m[2]), modelId }];
  });
  const current = personal.config.defaultModelSelection;
  const matches = current ? candidates.filter(c => c.providerId === current.providerId) : candidates;
  if (matches.length !== 1) {
    throw new Error("没有唯一的现有独立 CLI Coding Plan 凭据，不能自动选择账号；请使用官方登录或显式选择模型。");
  }
  const selected = matches[0];
  const identityKey = `account-provider:${selected.providerId}:identity`;
  return { ...selected, identityKey,
    addIdentity: !credentials[identityKey],
    addDefault: !current,
    selection: current || { providerId: selected.providerId, modelId: selected.modelId } };
}

function encryptIdentity(value, env) {
  // Compatible with official credential-cipher.ts, encryption only.
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

function lockFile(path) {
  const dir = `${path}.lock`;
  // Match the official directory lock and owner metadata. Never reclaim a lock.
  mkdirSync(dir);
  const owner = join(dir, `owner-${process.pid}-${randomBytes(8).toString("hex")}.json`);
  try { writeFileSync(owner, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (e) { rmdirSync(dir); throw e; }
  return () => { unlinkSync(owner); rmdirSync(dir); };
}

function replaceJson(path, original, next, tag) {
  if (readFileSync(path, "utf8") !== original) throw new Error("配置并发变化，已停止修复，请重试。");
  const backup = `${path}.before-mcp-repair-${tag}.bak`;
  writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  const temp = `${path}.${tag}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (e) { try { unlinkSync(temp); } catch {} throw e; }
  return backup;
}

function parsePrivateJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} JSON 无效，保留原文件；未输出文件内容。`); }
}

export function repairCliMetadata({ env = process.env, builtinPath, apply = false }) {
  const base = env.ZCODE_DATA_BASE_DIR || homedir();
  const credentialsPath = join(base, ".zcode", "v2", "credentials.json");
  const personalPath = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(base, ".zcode", "v2", "provider_config.json");
  if (!builtinPath) throw new Error("无法定位内置配置，请设置 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE。");
  const releases = [];
  try {
    if (apply) {
      for (const path of [credentialsPath, personalPath].sort()) releases.push(lockFile(path));
    }
    const credentialsText = readFileSync(credentialsPath, "utf8");
    const personalText = readFileSync(personalPath, "utf8");
    const credentials = parsePrivateJson(credentialsText, "凭据"), personal = parsePrivateJson(personalText, "个人配置");
    const plan = planCliRepair(credentials, personal, parsePrivateJson(readFileSync(builtinPath, "utf8"), "内置配置"));
    const summary = { applied: apply, providerId: plan.providerId, modelId: plan.selection.modelId,
      missingIdentity: plan.addIdentity, missingDefault: plan.addDefault, backups: [] };
    if (!apply) return summary;
    const tag = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    if (plan.addIdentity) {
      credentials[plan.identityKey] = encryptIdentity(plan.accountIdentity, env);
      summary.backups.push(replaceJson(credentialsPath, credentialsText, credentials, tag));
    }
    if (plan.addDefault) {
      personal.config.defaultModelSelection = plan.selection;
      summary.backups.push(replaceJson(personalPath, personalText, personal, tag));
    }
    return summary;
  } finally { for (const release of releases.reverse()) release(); }
}
