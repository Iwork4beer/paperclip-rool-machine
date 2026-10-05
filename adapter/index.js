import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const type = "rool_machine";
export const label = "Rool Machine";
export const models = [];

const DEFAULT_BRIDGE_PATH = "/paperclip/rool-bridge/bridge.mjs";
const DEFAULT_CWD = "/paperclip/rool-bridge";
const DEFAULT_TIMEOUT_SEC = 14400;
const DEFAULT_GRACE_SEC = 15;
const DEFAULT_MAX_ATTACHMENTS = 25;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const DEFAULT_MAX_INSTRUCTIONS_FILES = 100;
const DEFAULT_MAX_SKILLS_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SKILLS_FILES = 500;
const DEFAULT_MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COMMENTS = 200;
const BRIDGE_EVENT_PREFIX = "@@PAPERCLIP_ROOL@@";

export const agentConfigurationDoc = `# rool_machine configuration

Paperclip external adapter for a Rool Machine.

This adapter deliberately uses Paperclip's native control-plane features wherever the Rool runtime can support them:

- run-scoped Paperclip JWT propagation to the local bridge;
- managed Instructions bundles;
- Paperclip Skills selection/sync with ephemeral per-run transport to Rool;
- task-scoped session persistence across heartbeats;
- Paperclip issue attachments transported to the Rool machine;
- structured run transcript parsing;
- Test Environment remote authentication/machine/agent probe;
- Paperclip Secrets through ROOL_CREDENTIALS_JSON;
- deterministic timeout and graceful termination.

Required:
- machineId: exact, case-sensitive Rool machine ID.

Compatibility fields retained from v0.1.0:
- label, profile, bridgePath, cwd, credentialsPath, timeoutSec, graceSec.

Managed Instructions:
- Paperclip writes instructionsFilePath/instructionsRootPath. The bridge transports the complete managed bundle to the Rool drive and points the worker to the configured entry file.

Skills:
- Paperclip materializes selected runtime skills. This adapter reports ephemeral skill support and the bridge transports selected skill directories into an isolated Rool-drive directory for each task.

Credentials:
1. ROOL_CREDENTIALS_JSON resolved from Paperclip Secrets -> private temporary file for the run/test only.
2. credentialsPath.
3. ROOL_CREDENTIALS_PATH.
4. bridge profile-derived legacy path.

The credential JSON is never included in prompts, metadata, resultJson or logs.

Rool workers do not receive Paperclip control-plane credentials. The bridge owns checkout/context/result persistence. Instructions or skills that describe direct Paperclip API mutation are subordinate to that bridge execution contract.
`;

function stringValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function contextString(context, ...keys) {
  for (const key of keys) {
    const value = context?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function safeInheritedEnv() {
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_PATH", "TMPDIR"];
  const env = {};
  for (const key of keys) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  return env;
}

function buildRuntimeEnv(ctx, envConfig) {
  const env = safeInheritedEnv();
  const agent = ctx.agent ?? {};
  const context = ctx.context ?? {};

  if (process.env.PAPERCLIP_API_URL) env.PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
  if (agent.id) env.PAPERCLIP_AGENT_ID = String(agent.id);
  if (agent.companyId) env.PAPERCLIP_COMPANY_ID = String(agent.companyId);
  if (ctx.runId) env.PAPERCLIP_RUN_ID = String(ctx.runId);
  if (ctx.authToken) env.PAPERCLIP_API_KEY = String(ctx.authToken);

  const taskId = contextString(context, "taskId", "issueId");
  const wakeReason = contextString(context, "wakeReason");
  const wakeCommentId = contextString(context, "wakeCommentId", "commentId");
  const approvalId = contextString(context, "approvalId");
  const approvalStatus = contextString(context, "approvalStatus");

  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  const issueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
    : [];
  if (issueIds.length) env.PAPERCLIP_LINKED_ISSUE_IDS = issueIds.join(",");

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value !== "string") continue;
    if (key === "PAPERCLIP_API_KEY") continue;
    if (key.startsWith("PAPERCLIP_") && Object.hasOwn(env, key)) continue;
    env[key] = value;
  }

  return env;
}

async function prepareCredentials(config, envConfig) {
  const inlineJson = stringValue(envConfig.ROOL_CREDENTIALS_JSON, "");
  if (inlineJson) {
    try {
      JSON.parse(inlineJson);
    } catch {
      throw Object.assign(new Error("ROOL_CREDENTIALS_JSON is not valid JSON."), { code: "rool_credentials_invalid" });
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-rool-credentials-"));
    const credentialsPath = path.join(dir, "credentials.json");
    await writeFile(credentialsPath, inlineJson, { encoding: "utf8", mode: 0o600 });
    await chmod(credentialsPath, 0o600);
    return {
      path: credentialsPath,
      source: "paperclip_secret",
      cleanup: async () => rm(dir, { recursive: true, force: true }),
    };
  }

  const configuredPath = stringValue(config.credentialsPath, "") || stringValue(envConfig.ROOL_CREDENTIALS_PATH, "");
  if (configuredPath) {
    return { path: configuredPath, source: "credential_path", cleanup: async () => {} };
  }

  return { path: "", source: "bridge_profile", cleanup: async () => {} };
}

function desiredSkillKeys(config) {
  const sync = plainObject(config.paperclipSkillSync);
  if (Array.isArray(sync.desiredSkillEntries)) {
    return sync.desiredSkillEntries
      .map((entry) => typeof entry === "string" ? entry : stringValue(entry?.key, ""))
      .filter(Boolean);
  }
  if (Array.isArray(sync.desiredSkills)) {
    return sync.desiredSkills.map((v) => stringValue(v, "")).filter(Boolean);
  }
  return [];
}

function runtimeSkillEntries(config) {
  return Array.isArray(config.paperclipRuntimeSkills)
    ? config.paperclipRuntimeSkills.filter((v) => v && typeof v === "object")
    : [];
}

function buildSkillSnapshot(ctx, desiredOverride = null) {
  const config = plainObject(ctx.config);
  const runtimeEntries = runtimeSkillEntries(config);
  const desiredSkills = Array.isArray(desiredOverride)
    ? desiredOverride.map((v) => stringValue(v, "")).filter(Boolean)
    : desiredSkillKeys(config);
  const desired = new Set(desiredSkills);
  const seen = new Set();
  const entries = [];

  for (const raw of runtimeEntries) {
    const key = stringValue(raw.key, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const runtimeName = stringValue(raw.runtimeName, key);
    const missing = raw.sourceStatus === "missing" || !stringValue(raw.source, "");
    entries.push({
      key,
      runtimeName,
      desired: desired.has(key),
      managed: true,
      state: missing ? "missing" : desired.has(key) ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: stringValue(raw.source, "") || null,
      targetPath: desired.has(key) ? `Rool per-run skill: ${runtimeName}` : null,
      locationLabel: desired.has(key) ? "Applied to Rool when the agent runs" : null,
      detail: missing ? stringValue(raw.missingDetail, "Paperclip could not materialize this skill source.") : null,
    });
  }

  for (const key of desiredSkills) {
    if (seen.has(key)) continue;
    entries.push({
      key,
      runtimeName: key,
      desired: true,
      managed: true,
      state: "missing",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      locationLabel: null,
      detail: "Selected skill is not present in the materialized runtime skill set.",
    });
  }

  return {
    adapterType: ctx.adapterType ?? type,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings: entries.some((e) => e.desired && e.state === "missing")
      ? ["One or more selected skills are unavailable and will not be transported to Rool."]
      : [],
  };
}

export async function listSkills(ctx) {
  return buildSkillSnapshot(ctx);
}

export async function syncSkills(ctx, desiredSkills) {
  return buildSkillSnapshot(ctx, desiredSkills);
}

function compatibleSession(runtime, expected) {
  const raw = plainObject(runtime?.sessionParams);
  if (!stringValue(raw.conversationId, "")) return null;
  if (stringValue(raw.machineId, "") !== expected.machineId) return null;
  if (stringValue(raw.profile, "default") !== expected.profile) return null;
  if (expected.taskId && stringValue(raw.taskId, "") && stringValue(raw.taskId, "") !== expected.taskId) return null;
  return raw;
}

function normalizeSessionParams(raw) {
  const r = plainObject(raw);
  const conversationId = stringValue(r.conversationId, "");
  if (!conversationId) return null;
  return {
    version: numberValue(r.version, 1, 1, 1),
    conversationId,
    taskId: stringValue(r.taskId, ""),
    machineId: stringValue(r.machineId, ""),
    profile: stringValue(r.profile, "default"),
  };
}

export const sessionCodec = {
  deserialize: normalizeSessionParams,
  serialize: normalizeSessionParams,
  getDisplayId(params) {
    return normalizeSessionParams(params)?.conversationId ?? null;
  },
};

async function prepareRuntimeManifest(config) {
  const desired = new Set(desiredSkillKeys(config));
  const skills = runtimeSkillEntries(config)
    .filter((entry) => desired.has(stringValue(entry.key, "")))
    .map((entry) => ({
      key: stringValue(entry.key, ""),
      runtimeName: stringValue(entry.runtimeName, stringValue(entry.key, "")),
      source: stringValue(entry.source, ""),
      sourceStatus: stringValue(entry.sourceStatus, "available"),
      missingDetail: stringValue(entry.missingDetail, ""),
    }));

  const instructionsFilePath = stringValue(config.instructionsFilePath, stringValue(config.agentsMdPath, ""));
  const instructionsRootPath = stringValue(
    config.instructionsRootPath,
    instructionsFilePath ? path.dirname(instructionsFilePath) : "",
  );

  const manifest = {
    version: 1,
    instructions: instructionsFilePath
      ? {
          entryFile: instructionsFilePath,
          rootPath: instructionsRootPath,
          entryName: stringValue(config.instructionsEntryFile, path.basename(instructionsFilePath)),
          mode: stringValue(config.instructionsBundleMode, "managed"),
        }
      : null,
    skills,
    limits: {
      maxAttachments: numberValue(config.maxAttachments, DEFAULT_MAX_ATTACHMENTS, 0, 200),
      maxAttachmentBytes: numberValue(config.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES, 1, 1024 * 1024 * 1024),
      maxAttachmentsTotalBytes: numberValue(config.maxAttachmentsTotalBytes, DEFAULT_MAX_ATTACHMENTS_TOTAL_BYTES, 1, 2 * 1024 * 1024 * 1024),
      maxInstructionsBytes: numberValue(config.maxInstructionsBytes, DEFAULT_MAX_INSTRUCTIONS_BYTES, 1, 100 * 1024 * 1024),
      maxInstructionsFiles: numberValue(config.maxInstructionsFiles, DEFAULT_MAX_INSTRUCTIONS_FILES, 1, 5000),
      maxSkillsBytes: numberValue(config.maxSkillsBytes, DEFAULT_MAX_SKILLS_BYTES, 1, 1024 * 1024 * 1024),
      maxSkillsFiles: numberValue(config.maxSkillsFiles, DEFAULT_MAX_SKILLS_FILES, 1, 10000),
      maxContextBytes: numberValue(config.maxContextBytes, DEFAULT_MAX_CONTEXT_BYTES, 1024, 100 * 1024 * 1024),
      maxComments: numberValue(config.maxComments, DEFAULT_MAX_COMMENTS, 1, 1000),
    },
  };

  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-rool-runtime-"));
  const manifestPath = path.join(dir, "runtime-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return {
    path: manifestPath,
    manifest,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

function parseBridgeEvents(stdout) {
  const events = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.startsWith(BRIDGE_EVENT_PREFIX)) continue;
    try {
      const event = JSON.parse(line.slice(BRIDGE_EVENT_PREFIX.length));
      if (event && typeof event === "object") events.push(event);
    } catch {
      // UI/log parser will preserve malformed output; do not trust it here.
    }
  }
  return events;
}

function bridgeFinalEvent(stdout) {
  return [...parseBridgeEvents(stdout)].reverse().find((event) => event.type === "result") ?? null;
}

function bridgeErrorEvent(stdout) {
  return [...parseBridgeEvents(stdout)].reverse().find((event) => event.type === "error") ?? null;
}

async function runBridge(ctx, command, args, options) {
  const { cwd, env, timeoutSec, graceSec } = options;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timeoutTimer = null;
  let killTimer = null;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    if (typeof ctx.onSpawn === "function" && child.pid) {
      Promise.resolve(ctx.onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() })).catch(() => {});
    }

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      Promise.resolve(ctx.onLog?.("stdout", text)).catch(() => {});
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      Promise.resolve(ctx.onLog?.("stderr", text)).catch(() => {});
    });

    child.once("error", (error) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code, signal, timedOut, stdout, stderr });
    });

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), graceSec * 1000);
      }, timeoutSec * 1000);
    }
  });
}

function failureResult(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: extra.exitCode ?? 1,
    signal: extra.signal ?? null,
    timedOut: extra.timedOut ?? false,
    errorMessage: message,
    errorCode: stringValue(error?.code, "rool_adapter_failed"),
    provider: "rool",
    resultJson: extra.resultJson ?? null,
    summary: message,
  };
}

export async function execute(ctx) {
  const config = plainObject(ctx.config);
  const envConfig = plainObject(config.env);
  const machineId = stringValue(config.machineId, "");
  const profile = stringValue(config.profile, "default");
  const labelValue = stringValue(config.label, stringValue(ctx.agent?.name, machineId || "Rool"));
  const bridgePath = stringValue(config.bridgePath, DEFAULT_BRIDGE_PATH);
  const cwd = stringValue(config.cwd, DEFAULT_CWD);
  const timeoutSec = numberValue(config.timeoutSec, DEFAULT_TIMEOUT_SEC, 0, 604800);
  const graceSec = numberValue(config.graceSec, DEFAULT_GRACE_SEC, 1, 300);
  const taskId = contextString(ctx.context, "taskId", "issueId");
  const forceFreshSession = ctx.context?.forceFreshSession === true;

  if (!machineId) return failureResult(Object.assign(new Error("Rool Machine adapter requires machineId."), { code: "rool_machine_id_missing" }));

  let credentials = null;
  let runtimeManifest = null;
  try {
    await access(bridgePath);
    const bridgeStat = await stat(bridgePath);
    if (!bridgeStat.isFile()) throw Object.assign(new Error(`Rool bridge path is not a file: ${bridgePath}`), { code: "rool_bridge_invalid" });
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw Object.assign(new Error(`Rool bridge cwd is not a directory: ${cwd}`), { code: "rool_cwd_invalid" });

    credentials = await prepareCredentials(config, envConfig);
    runtimeManifest = await prepareRuntimeManifest(config);

    const env = buildRuntimeEnv(ctx, envConfig);
    delete env.ROOL_CREDENTIALS_JSON;
    env.PAPERCLIP_RUNTIME_MANIFEST_PATH = runtimeManifest.path;

    const session = forceFreshSession ? null : compatibleSession(ctx.runtime, { machineId, profile, taskId });
    if (session?.conversationId) env.ROOL_RESUME_CONVERSATION_ID = session.conversationId;
    if (forceFreshSession) env.ROOL_FORCE_FRESH_SESSION = "1";

    const args = [bridgePath, "--profile", profile, "--machine", machineId, "--label", labelValue];
    if (credentials.path) args.push("--credentials", credentials.path);
    args.push("--runtime-manifest", runtimeManifest.path);
    if (session?.conversationId) args.push("--conversation", session.conversationId);
    if (forceFreshSession) args.push("--fresh");

    if (typeof ctx.onMeta === "function") {
      await ctx.onMeta({
        adapterType: type,
        command: process.execPath,
        cwd,
        commandArgs: [
          bridgePath,
          "--profile", profile,
          "--machine", machineId,
          "--label", labelValue,
          ...(credentials.path ? ["--credentials", "<private>"] : []),
          "--runtime-manifest", "<private-runtime-manifest>",
          ...(session?.conversationId ? ["--conversation", session.conversationId] : []),
          ...(forceFreshSession ? ["--fresh"] : []),
        ],
        commandNotes: [
          `Rool machine ${machineId}`,
          `credential source: ${credentials.source}`,
          runtimeManifest.manifest.instructions ? "managed instructions: enabled" : "managed instructions: not configured",
          `selected skills: ${runtimeManifest.manifest.skills.length}`,
          forceFreshSession ? "forcing a fresh Rool conversation" : session?.conversationId ? `resuming conversation ${session.conversationId}` : "task conversation recovery/new session",
        ],
      });
    }

    const result = await runBridge(ctx, process.execPath, args, { cwd, env, timeoutSec, graceSec });

    if (result.timedOut) {
      return failureResult(Object.assign(new Error(`Rool bridge timed out after ${timeoutSec}s`), { code: "rool_bridge_timeout" }), {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: true,
        resultJson: { machineId, profile },
      });
    }

    if ((result.exitCode ?? 0) !== 0) {
      const bridgeError = bridgeErrorEvent(result.stdout);
      const error = Object.assign(
        new Error(stringValue(bridgeError?.message, `Rool bridge exited with code ${result.exitCode ?? -1}`)),
        { code: stringValue(bridgeError?.code, "rool_bridge_failed") },
      );
      return failureResult(error, {
        exitCode: result.exitCode,
        signal: result.signal,
        resultJson: {
          machineId,
          profile,
          conversationId: stringValue(bridgeError?.conversationId, "") || null,
          stderr: result.stderr.slice(-12000),
        },
      });
    }

    const finalEvent = bridgeFinalEvent(result.stdout);
    if (!finalEvent) {
      return failureResult(Object.assign(new Error("Rool bridge completed without a structured result event."), { code: "rool_result_missing" }), {
        exitCode: result.exitCode,
        signal: result.signal,
        resultJson: { machineId, profile, stderr: result.stderr.slice(-12000) },
      });
    }

    const conversationId = stringValue(finalEvent.conversationId, "");
    const finalTaskId = stringValue(finalEvent.taskId, taskId);
    const sessionParams = conversationId
      ? { version: 1, conversationId, taskId: finalTaskId, machineId, profile }
      : null;

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      provider: "rool",
      sessionParams,
      sessionDisplayId: conversationId || null,
      resultJson: {
        machineId,
        profile,
        conversationId: conversationId || null,
        taskId: finalTaskId || null,
        transported: plainObject(finalEvent.transported),
      },
      summary: stringValue(finalEvent.summary, `Rool machine ${labelValue} completed successfully.`),
    };
  } catch (error) {
    return failureResult(error);
  } finally {
    await runtimeManifest?.cleanup?.().catch(() => {});
    await credentials?.cleanup?.().catch(() => {});
  }
}

export async function testEnvironment(ctx) {
  const config = plainObject(ctx.config);
  const envConfig = plainObject(config.env);
  const machineId = stringValue(config.machineId, "");
  const bridgePath = stringValue(config.bridgePath, DEFAULT_BRIDGE_PATH);
  const cwd = stringValue(config.cwd, DEFAULT_CWD);
  const profile = stringValue(config.profile, "default");
  const labelValue = stringValue(config.label, machineId || "Rool");
  const checks = [];
  let localFatal = false;

  if (!machineId) {
    checks.push({ code: "machine_id_missing", level: "error", message: "Rool machine ID is required." });
    localFatal = true;
  } else {
    checks.push({ code: "machine_id_configured", level: "info", message: `Rool machine ID configured: ${machineId}` });
  }

  try {
    const s = await stat(bridgePath);
    if (!s.isFile()) throw new Error("not a file");
    checks.push({ code: "bridge_found", level: "info", message: `Rool bridge found at ${bridgePath}` });
  } catch {
    checks.push({ code: "bridge_missing", level: "error", message: `Rool bridge not found at ${bridgePath}` });
    localFatal = true;
  }

  try {
    const s = await stat(cwd);
    if (!s.isDirectory()) throw new Error("not a directory");
    checks.push({ code: "cwd_found", level: "info", message: `Bridge working directory found at ${cwd}` });
  } catch {
    checks.push({ code: "cwd_missing", level: "error", message: `Bridge working directory not found at ${cwd}` });
    localFatal = true;
  }

  const instructionsFilePath = stringValue(config.instructionsFilePath, stringValue(config.agentsMdPath, ""));
  if (instructionsFilePath) {
    try {
      const s = await stat(instructionsFilePath);
      if (!s.isFile()) throw new Error("not a file");
      checks.push({ code: "instructions_ready", level: "info", message: "Managed Instructions entry file is accessible." });
    } catch {
      checks.push({ code: "instructions_missing", level: "error", message: `Managed Instructions entry file is not accessible: ${instructionsFilePath}` });
      localFatal = true;
    }
  } else {
    checks.push({ code: "instructions_not_configured", level: "warn", message: "No managed Instructions bundle is configured for this agent yet." });
  }

  let credentials = null;
  try {
    credentials = await prepareCredentials(config, envConfig);
    if (credentials.source === "paperclip_secret") {
      checks.push({ code: "secret_credentials_ready", level: "info", message: "Rool credentials are supplied through a resolved Paperclip Secret." });
    } else if (credentials.path) {
      await access(credentials.path);
      checks.push({ code: "credential_path_found", level: "info", message: "Rool credential file is accessible." });
    } else {
      checks.push({ code: "profile_credentials", level: "warn", message: `Using bridge profile-derived credentials for profile "${profile}".` });
    }

    if (!localFatal) {
      const env = safeInheritedEnv();
      const args = [bridgePath, "--test", "--profile", profile, "--machine", machineId, "--label", labelValue];
      if (credentials.path) args.push("--credentials", credentials.path);
      const result = await runBridge({ onLog: async () => {} }, process.execPath, args, {
        cwd,
        env,
        timeoutSec: Math.min(numberValue(config.timeoutSec, DEFAULT_TIMEOUT_SEC, 1, 604800), 120),
        graceSec: numberValue(config.graceSec, DEFAULT_GRACE_SEC, 1, 300),
      });
      const finalEvent = bridgeFinalEvent(result.stdout);
      if (!result.timedOut && result.exitCode === 0 && finalEvent?.mode === "test") {
        checks.push({ code: "rool_remote_probe_ok", level: "info", message: `Authenticated to Rool; machine ${machineId} is visible and exposes agent "rool".` });
      } else {
        const bridgeError = bridgeErrorEvent(result.stdout);
        checks.push({
          code: "rool_remote_probe_failed",
          level: "error",
          message: stringValue(bridgeError?.message, result.timedOut ? "Rool remote probe timed out." : `Rool remote probe failed with exit code ${result.exitCode ?? -1}.`),
          detail: result.stderr.slice(-4000) || null,
        });
      }
    }
  } catch (error) {
    checks.push({ code: stringValue(error?.code, "credentials_failed"), level: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    await credentials?.cleanup?.().catch(() => {});
  }

  const status = checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
  return { adapterType: ctx.adapterType ?? type, status, checks, testedAt: new Date().toISOString() };
}

export function getConfigSchema() {
  return {
    fields: [
      { key: "machineId", label: "Rool machine ID", type: "text", required: true, hint: "Exact case-sensitive Rool machine ID, for example machine-test-1 or machine-test-2." },
      { key: "label", label: "Rool label", type: "text", hint: "Optional bridge display label, for example WORK1 or REVIEW." },
      { key: "profile", label: "Rool account profile", type: "text", default: "default", hint: "Existing bridge profile. Used for credentials routing and session validation." },
      { key: "bridgePath", label: "Bridge script path", type: "text", default: DEFAULT_BRIDGE_PATH, hint: "Keep the default unless the canonical bridge is moved." },
      { key: "cwd", label: "Bridge working directory", type: "text", default: DEFAULT_CWD },
      { key: "credentialsPath", label: "Legacy credentials path", type: "text", hint: "Optional rollback path. Prefer Paperclip Secrets bound to ROOL_CREDENTIALS_JSON." },
      { key: "timeoutSec", label: "Timeout (seconds)", type: "number", default: DEFAULT_TIMEOUT_SEC },
      { key: "graceSec", label: "Termination grace (seconds)", type: "number", default: DEFAULT_GRACE_SEC },
      { key: "maxAttachments", label: "Maximum issue attachments per run", type: "number", default: DEFAULT_MAX_ATTACHMENTS, group: "Transport limits" },
      { key: "maxAttachmentBytes", label: "Maximum bytes per attachment", type: "number", default: DEFAULT_MAX_ATTACHMENT_BYTES, group: "Transport limits" },
      { key: "maxAttachmentsTotalBytes", label: "Maximum total attachment bytes", type: "number", default: DEFAULT_MAX_ATTACHMENTS_TOTAL_BYTES, group: "Transport limits" },
      { key: "maxInstructionsBytes", label: "Maximum Instructions bundle bytes", type: "number", default: DEFAULT_MAX_INSTRUCTIONS_BYTES, group: "Transport limits" },
      { key: "maxInstructionsFiles", label: "Maximum Instructions bundle files", type: "number", default: DEFAULT_MAX_INSTRUCTIONS_FILES, group: "Transport limits" },
      { key: "maxSkillsBytes", label: "Maximum selected skills bytes", type: "number", default: DEFAULT_MAX_SKILLS_BYTES, group: "Transport limits" },
      { key: "maxSkillsFiles", label: "Maximum selected skill files", type: "number", default: DEFAULT_MAX_SKILLS_FILES, group: "Transport limits" },
      { key: "maxContextBytes", label: "Maximum generated task-context bytes", type: "number", default: DEFAULT_MAX_CONTEXT_BYTES, group: "Transport limits" },
      { key: "maxComments", label: "Maximum task comments transported", type: "number", default: DEFAULT_MAX_COMMENTS, group: "Transport limits" },
    ],
  };
}

export function createServerAdapter() {
  return {
    type,
    runtimeToolDelivery: "environment",
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    sessionCodec,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
