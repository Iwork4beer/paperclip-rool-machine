import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { RoolClient } from "@rool-dev/sdk";
import { NodeAuth } from "@rool-dev/sdk/node";

const BRIDGE_VERSION = "0.4.0";
const EVENT_PREFIX = "@@PAPERCLIP_ROOL@@";

function emit(type, data = {}) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type, ...data })}\n`);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw Object.assign(new Error(`Missing value for ${name}`), { code: "bridge_argument_missing" });
  }
  return value;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function safeProfileName(value) {
  const profile = String(value || "default").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw Object.assign(
      new Error(`Invalid Rool account profile "${profile}". Use only letters, numbers, dot, underscore and hyphen.`),
      { code: "rool_profile_invalid" },
    );
  }
  return profile;
}

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

function safePathSegment(value, fallback = "item") {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function remoteJoin(...parts) {
  return path.posix.join(...parts);
}

function turnText(turn) {
  if (!turn || typeof turn !== "object") return "";
  if (typeof turn.text === "string") return turn.text;
  if (Array.isArray(turn.content)) {
    return turn.content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    }).join("");
  }
  if (typeof turn.content === "string") return turn.content;
  return "";
}

function hasRunMarker(turns, marker) {
  return (turns || []).some((turn) => turn?.role === "user" && turnText(turn).includes(marker));
}

function assistantAfterMarker(turns, marker) {
  const list = Array.isArray(turns) ? turns : [];
  let markerIndex = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]?.role === "user" && turnText(list[i]).includes(marker)) markerIndex = i;
  }
  if (markerIndex >= 0) {
    for (let i = list.length - 1; i > markerIndex; i -= 1) {
      if (list[i]?.role === "assistant") return list[i];
    }
  }
  return [...list].reverse().find((turn) => turn?.role === "assistant") ?? null;
}

async function loadManifest(manifestPath) {
  if (!manifestPath) return { version: 1, instructions: null, skills: [], limits: {} };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`Cannot read runtime manifest: ${error?.message || error}`), { code: "runtime_manifest_invalid" });
  }
  return {
    version: numberValue(parsed?.version, 1, 1, 1),
    instructions: parsed?.instructions && typeof parsed.instructions === "object" ? parsed.instructions : null,
    skills: Array.isArray(parsed?.skills) ? parsed.skills : [],
    limits: plainObject(parsed?.limits),
  };
}

async function walkLocalFiles(rootPath, limits, label) {
  const maxFiles = limits.maxFiles;
  const maxBytes = limits.maxBytes;
  const root = path.resolve(rootPath);
  const rootStat = await stat(root);
  const files = [];
  let totalBytes = 0;

  async function visit(current, relBase = "") {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      const rel = relBase || path.basename(current);
      totalBytes += currentStat.size;
      if (files.length + 1 > maxFiles) {
        throw Object.assign(new Error(`${label} exceeds ${maxFiles} files.`), { code: `${label.toLowerCase().replace(/\W+/g, "_")}_file_limit_exceeded` });
      }
      if (totalBytes > maxBytes) {
        throw Object.assign(new Error(`${label} exceeds ${maxBytes} bytes.`), { code: `${label.toLowerCase().replace(/\W+/g, "_")}_byte_limit_exceeded` });
      }
      files.push({ absolute: current, relative: rel, size: currentStat.size });
      return;
    }
    if (!currentStat.isDirectory()) {
      throw Object.assign(new Error(`${label} source is neither a file nor directory: ${current}`), { code: "transport_source_invalid" });
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const relative = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) await visit(absolute, relative);
    }
  }

  await visit(root, rootStat.isFile() ? path.basename(root) : "");
  return { root, files, totalBytes };
}

async function uploadLocalTree(machine, sourcePath, remoteRoot, limits, label) {
  const walked = await walkLocalFiles(sourcePath, limits, label);
  const remoteFiles = [];
  for (const file of walked.files) {
    const content = await readFile(file.absolute);
    const normalizedRelative = file.relative.split(path.sep).join("/");
    const remotePath = remoteJoin(remoteRoot, normalizedRelative);
    await machine.files.write(remotePath, content, { createParents: true });
    remoteFiles.push(remotePath);
  }
  return { ...walked, remoteFiles };
}

function extractSkillDescription(text) {
  const head = String(text || "").slice(0, 12000);
  const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() || "";
  const description = head.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
  return { name, description };
}

async function transportInstructions(machine, manifest, taskBase) {
  const instructions = manifest.instructions;
  if (!instructions) return null;

  const entryFile = path.resolve(stringValue(instructions.entryFile, ""));
  const rootPath = path.resolve(stringValue(instructions.rootPath, path.dirname(entryFile)));
  if (!entryFile || !rootPath) {
    throw Object.assign(new Error("Managed Instructions configuration is incomplete."), { code: "instructions_config_invalid" });
  }
  const relativeEntry = path.relative(rootPath, entryFile);
  if (!relativeEntry || relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
    throw Object.assign(new Error("Managed Instructions entry file is outside instructionsRootPath."), { code: "instructions_entry_outside_root" });
  }

  const remoteRoot = remoteJoin(taskBase, "shared", "instructions");
  const uploaded = await uploadLocalTree(
    machine,
    rootPath,
    remoteRoot,
    {
      maxFiles: numberValue(manifest.limits.maxInstructionsFiles, 100, 1, 5000),
      maxBytes: numberValue(manifest.limits.maxInstructionsBytes, 1024 * 1024, 1, 100 * 1024 * 1024),
    },
    "Instructions bundle",
  );

  const remoteEntry = remoteJoin(remoteRoot, relativeEntry.split(path.sep).join("/"));
  if (!uploaded.remoteFiles.includes(remoteEntry)) {
    throw Object.assign(new Error("Managed Instructions entry file was not transported."), { code: "instructions_entry_missing" });
  }
  return { remoteRoot, remoteEntry, files: uploaded.files.length, bytes: uploaded.totalBytes };
}

async function transportSkills(machine, manifest, taskBase) {
  if (!manifest.skills.length) return { skills: [], indexPath: null, files: 0, bytes: 0 };

  const maxFiles = numberValue(manifest.limits.maxSkillsFiles, 500, 1, 10000);
  const maxBytes = numberValue(manifest.limits.maxSkillsBytes, 10 * 1024 * 1024, 1, 1024 * 1024 * 1024);
  let filesUsed = 0;
  let bytesUsed = 0;
  const transported = [];

  for (const raw of manifest.skills) {
    const key = stringValue(raw?.key, "");
    const runtimeName = safePathSegment(stringValue(raw?.runtimeName, key), "skill");
    const source = stringValue(raw?.source, "");
    if (!key || !source || raw?.sourceStatus === "missing") {
      throw Object.assign(new Error(`Selected Paperclip skill "${key || runtimeName}" is unavailable: ${stringValue(raw?.missingDetail, "missing materialized source")}`), { code: "skill_source_missing" });
    }

    const remoteRoot = remoteJoin(taskBase, "shared", "skills", runtimeName);
    const uploaded = await uploadLocalTree(
      machine,
      source,
      remoteRoot,
      { maxFiles: maxFiles - filesUsed, maxBytes: maxBytes - bytesUsed },
      `Skill ${key}`,
    );
    filesUsed += uploaded.files.length;
    bytesUsed += uploaded.totalBytes;

    let description = "";
    const skillMd = uploaded.files.find((file) => path.basename(file.absolute).toLowerCase() === "skill.md");
    if (skillMd) {
      try {
        const meta = extractSkillDescription(await readFile(skillMd.absolute, "utf8"));
        description = meta.description;
      } catch {}
    }
    transported.push({ key, runtimeName, remoteRoot, files: uploaded.files.length, bytes: uploaded.totalBytes, description });
  }

  const indexPath = remoteJoin(taskBase, "shared", "SKILLS-INDEX.md");
  const lines = [
    "# Available Paperclip skills",
    "",
    "Load a skill only when it is relevant to the assigned work. Each skill is stored under the Rool-drive path shown below.",
    "",
  ];
  for (const skill of transported) {
    lines.push(`- **${skill.key}** — ${skill.remoteRoot}${skill.description ? ` — ${skill.description}` : ""}`);
  }
  await machine.files.write(indexPath, lines.join("\n"), { contentType: "text/markdown", createParents: true });
  return { skills: transported, indexPath, files: filesUsed, bytes: bytesUsed };
}

async function fetchAttachmentList(pc, taskId) {
  const response = await pc(`/api/issues/${taskId}/attachments`, { optionalStatuses: [404] });
  if (response === null) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.attachments)) return response.attachments;
  if (Array.isArray(response?.items)) return response.items;
  return [];
}

async function transportIssueAttachments(machine, pc, pcBinary, taskId, runBase, manifest) {
  const list = await fetchAttachmentList(pc, taskId);
  const maxAttachments = numberValue(manifest.limits.maxAttachments, 25, 0, 200);
  const maxEach = numberValue(manifest.limits.maxAttachmentBytes, 25 * 1024 * 1024, 1, 1024 * 1024 * 1024);
  const maxTotal = numberValue(manifest.limits.maxAttachmentsTotalBytes, 100 * 1024 * 1024, 1, 2 * 1024 * 1024 * 1024);
  if (list.length > maxAttachments) {
    throw Object.assign(new Error(`Task has ${list.length} attachments; configured maximum is ${maxAttachments}.`), { code: "attachment_count_limit_exceeded" });
  }

  const uploaded = [];
  let totalBytes = 0;
  for (let i = 0; i < list.length; i += 1) {
    const item = plainObject(list[i]);
    const id = stringValue(item.id, stringValue(item.attachmentId, ""));
    if (!id) throw Object.assign(new Error("Paperclip attachment metadata is missing an attachment ID."), { code: "attachment_id_missing" });
    const rawName = stringValue(item.filename, stringValue(item.fileName, stringValue(item.name, `attachment-${i + 1}`)));
    const name = `${String(i + 1).padStart(2, "0")}-${safePathSegment(rawName, `attachment-${i + 1}`)}`;
    const content = await pcBinary(`/api/attachments/${id}/content`);
    if (content.length > maxEach) {
      throw Object.assign(new Error(`Attachment "${rawName}" is ${content.length} bytes; configured per-file maximum is ${maxEach}.`), { code: "attachment_size_limit_exceeded" });
    }
    totalBytes += content.length;
    if (totalBytes > maxTotal) {
      throw Object.assign(new Error(`Task attachments total ${totalBytes} bytes; configured maximum is ${maxTotal}.`), { code: "attachment_total_limit_exceeded" });
    }
    const remotePath = remoteJoin(runBase, "attachments", name);
    await machine.files.write(remotePath, content, {
      contentType: stringValue(item.mimeType, stringValue(item.contentType, "application/octet-stream")),
      createParents: true,
    });
    uploaded.push({ id, name: rawName, remotePath, bytes: content.length });
  }
  return { uploaded, bytes: totalBytes };
}

function jsonBlock(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

function buildTaskContext({ issue, heartbeatContext, comments, wake, workerLabel, machineId, runId }) {
  return [
    `# Paperclip task context`,
    "",
    `Bridge version: ${BRIDGE_VERSION}`,
    `Worker route: ${workerLabel} / ${machineId}`,
    `Paperclip run: ${runId}`,
    "",
    "## Bridge execution contract",
    "",
    "- Complete the assigned work and return the completed result, not merely a plan.",
    "- Do not invent missing facts, data, URLs, mappings, metrics or results.",
    "- You are a remote execution worker. Do not attempt to call, mutate, checkout, or mark Paperclip tasks through Paperclip control-plane APIs. The bridge owns Paperclip lifecycle operations.",
    "- If transported managed instructions or skills describe direct Paperclip API operations, this bridge contract overrides those control-plane steps. Follow their task-quality/process guidance, but return your result to the bridge.",
    "- Treat the issue, wake context, comments, managed instructions and supplied attachments as authoritative inputs.",
    "",
    "## Wake context",
    "```json",
    jsonBlock(wake),
    "```",
    "",
    "## Issue",
    "```json",
    jsonBlock(issue),
    "```",
    "",
    "## Heartbeat context",
    "```json",
    jsonBlock(heartbeatContext),
    "```",
    "",
    "## Comments",
    "```json",
    jsonBlock(comments),
    "```",
    "",
  ].join("\n");
}

async function main() {
  const testMode = hasArg("--test");
  const agentId = process.env.PAPERCLIP_AGENT_ID || "";
  const companyId = process.env.PAPERCLIP_COMPANY_ID || "";
  const runId = process.env.PAPERCLIP_RUN_ID || "";
  const apiKey = process.env.PAPERCLIP_API_KEY || "";
  const apiUrl = process.env.PAPERCLIP_API_URL || "";
  const profile = safeProfileName(argValue("--profile") || process.env.ROOL_ACCOUNT_PROFILE || "default");
  const machineId = argValue("--machine") || process.env.ROOL_MACHINE_ID || process.env.ROOL_WORK_MACHINE_ID || "";
  const workerLabel = argValue("--label") || process.env.ROOL_BRIDGE_LABEL || machineId || "Rool";
  const credentialsPath = argValue("--credentials") || process.env.ROOL_CREDENTIALS_PATH || (profile === "default"
    ? "/paperclip/rool-bridge/rool-credentials.json"
    : `/paperclip/rool-bridge/accounts/${profile}.json`);
  const runtimeManifestPath = argValue("--runtime-manifest") || process.env.PAPERCLIP_RUNTIME_MANIFEST_PATH || "";
  const requestedConversationId = argValue("--conversation") || process.env.ROOL_RESUME_CONVERSATION_ID || "";
  const forceFreshSession = hasArg("--fresh") || process.env.ROOL_FORCE_FRESH_SESSION === "1";

  if (!machineId) throw Object.assign(new Error("Missing Rool machine ID. Set ROOL_MACHINE_ID or pass --machine <id>."), { code: "rool_machine_id_missing" });
  if (!testMode) {
    if (!runId) throw Object.assign(new Error("Missing PAPERCLIP_RUN_ID"), { code: "paperclip_run_id_missing" });
    if (!apiKey) throw Object.assign(new Error("Missing PAPERCLIP_API_KEY"), { code: "paperclip_api_key_missing" });
    if (!apiUrl) throw Object.assign(new Error("Missing PAPERCLIP_API_URL"), { code: "paperclip_api_url_missing" });
    if (!companyId) throw Object.assign(new Error("Missing PAPERCLIP_COMPANY_ID"), { code: "paperclip_company_id_missing" });
    if (!agentId) throw Object.assign(new Error("Missing PAPERCLIP_AGENT_ID"), { code: "paperclip_agent_id_missing" });
  }

  const auth = new NodeAuth({ credentialsPath });
  if (!(await auth.initialize())) {
    throw Object.assign(new Error(`Rool authentication failed for profile "${profile}".`), { code: "rool_auth_failed" });
  }

  const client = new RoolClient({
    getTokens: auth.getTokens,
    onAuthInvalidated: auth.logout,
    client: { appName: "Paperclip Rool Bridge", appVersion: BRIDGE_VERSION },
  });

  const session = await client.getSession();
  if (!(session.machines || []).some((m) => m.id === machineId)) {
    const visible = (session.machines || []).map((m) => m.id).join(", ") || "(none)";
    throw Object.assign(new Error(`Rool machine ${machineId} is not visible to profile "${profile}". Visible machines: ${visible}`), { code: "rool_machine_not_visible" });
  }

  const machine = client.machine(machineId);
  const agent = await machine.agents.get("rool");
  if (!agent) throw Object.assign(new Error(`Rool machine ${machineId} does not expose agent "rool"`), { code: "rool_agent_missing" });

  if (testMode) {
    emit("result", {
      mode: "test",
      summary: `Rool machine ${machineId} is reachable and exposes agent rool.`,
      text: `Connection successful: ${machineId}`,
      machineId,
      profile,
      bridgeVersion: BRIDGE_VERSION,
    });
    return;
  }

  const manifest = await loadManifest(runtimeManifestPath);

  async function paperclipRequest(route, options = {}) {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "X-Paperclip-Run-Id": runId,
      ...(options.headers || {}),
    };
    let body = options.body;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const response = await fetch(`${apiUrl}${route}`, { ...options, headers, body });
    if (Array.isArray(options.optionalStatuses) && options.optionalStatuses.includes(response.status)) return null;
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Paperclip API ${response.status} ${route}: ${text}`);
      error.code = `paperclip_http_${response.status}`;
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { text }; }
  }

  async function paperclipBinary(route) {
    const response = await fetch(`${apiUrl}${route}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Paperclip-Run-Id": runId },
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Paperclip API ${response.status} ${route}: ${text}`);
      error.code = `paperclip_http_${response.status}`;
      throw error;
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const requestedTaskId = String(process.env.PAPERCLIP_TASK_ID || "").trim();
  let taskId;
  let issue;

  if (requestedTaskId) {
    taskId = requestedTaskId;
    issue = await paperclipRequest(`/api/issues/${taskId}`);
  } else {
    const inbox = await paperclipRequest(`/api/agents/me/inbox-lite`, { optionalStatuses: [404] });
    let assignments = [];
    if (Array.isArray(inbox)) assignments = inbox;
    else if (Array.isArray(inbox?.issues)) assignments = inbox.issues;
    else if (Array.isArray(inbox?.items)) assignments = inbox.items;
    if (!assignments.length) {
      assignments = await paperclipRequest(`/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&status=in_progress,todo,in_review,blocked`);
    }
    const picked = assignments.find((x) => x.status === "in_progress") || assignments.find((x) => x.status === "todo") || assignments.find((x) => x.status === "in_review") || assignments.find((x) => x.status === "blocked");
    if (!picked) throw Object.assign(new Error(`No assigned task for ${workerLabel} (${machineId})`), { code: "paperclip_task_missing" });
    taskId = picked.id;
    issue = await paperclipRequest(`/api/issues/${taskId}`);
  }

  if (issue.status !== "in_progress") {
    try {
      await paperclipRequest(`/api/issues/${taskId}/checkout`, {
        method: "POST",
        body: { agentId, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] },
      });
      issue = await paperclipRequest(`/api/issues/${taskId}`);
    } catch (error) {
      if (error?.status !== 409) throw error;
      issue = await paperclipRequest(`/api/issues/${taskId}`);
      if (issue.assigneeAgentId !== agentId && issue.assignee?.id !== agentId) {
        throw Object.assign(new Error(`Paperclip task ${issue.identifier || taskId} is owned by another agent.`), { code: "paperclip_checkout_conflict" });
      }
    }
  }

  const heartbeatContext = await paperclipRequest(`/api/issues/${taskId}/heartbeat-context`, { optionalStatuses: [404] });
  const commentsResponse = await paperclipRequest(`/api/issues/${taskId}/comments?order=asc`, { optionalStatuses: [404] });
  const comments = Array.isArray(commentsResponse)
    ? commentsResponse
    : Array.isArray(commentsResponse?.comments)
      ? commentsResponse.comments
      : Array.isArray(commentsResponse?.items)
        ? commentsResponse.items
        : [];
  const maxComments = numberValue(manifest.limits.maxComments, 200, 1, 1000);
  if (comments.length > maxComments) {
    throw Object.assign(new Error(`Task has ${comments.length} comments; configured transport maximum is ${maxComments}.`), { code: "comment_count_limit_exceeded" });
  }

  const issueKey = safePathSegment(issue.identifier || taskId, "task");
  const runKey = safePathSegment(runId, "run");
  const taskBase = `/rool-drive/paperclip/${issueKey}`;
  const runBase = remoteJoin(taskBase, "runs", runKey);

  const instructionsTransport = await transportInstructions(machine, manifest, taskBase);
  const skillsTransport = await transportSkills(machine, manifest, taskBase);
  const issueAttachments = await transportIssueAttachments(machine, paperclipRequest, paperclipBinary, taskId, runBase, manifest);

  const wake = {
    reason: process.env.PAPERCLIP_WAKE_REASON || null,
    commentId: process.env.PAPERCLIP_WAKE_COMMENT_ID || null,
    approvalId: process.env.PAPERCLIP_APPROVAL_ID || null,
    approvalStatus: process.env.PAPERCLIP_APPROVAL_STATUS || null,
    linkedIssueIds: process.env.PAPERCLIP_LINKED_ISSUE_IDS || null,
  };
  const taskContext = buildTaskContext({ issue, heartbeatContext, comments, wake, workerLabel, machineId, runId });
  const maxContextBytes = numberValue(manifest.limits.maxContextBytes, 2 * 1024 * 1024, 1024, 100 * 1024 * 1024);
  const contextBytes = Buffer.byteLength(taskContext, "utf8");
  if (contextBytes > maxContextBytes) {
    throw Object.assign(new Error(`Generated task context is ${contextBytes} bytes; configured maximum is ${maxContextBytes}.`), { code: "task_context_limit_exceeded" });
  }
  const contextPath = remoteJoin(runBase, "TASK-CONTEXT.md");
  await machine.files.write(contextPath, taskContext, { contentType: "text/markdown", createParents: true });

  const deterministicConversationId = "p" + createHash("sha256")
    .update(`${agentId}:${taskId}:${machineId}`)
    .digest("hex")
    .slice(0, 24);
  const freshConversationId = "p" + createHash("sha256")
    .update(`${agentId}:${taskId}:${machineId}:fresh:${runId}`)
    .digest("hex")
    .slice(0, 24);
  const conversationId = forceFreshSession ? freshConversationId : requestedConversationId || deterministicConversationId;
  let conversation = agent.conversation(conversationId);
  let state = await conversation.get();

  if (!state) {
    conversation = await agent.createConversation({
      id: conversationId,
      name: `Paperclip ${issue.identifier || taskId}`.slice(0, 120),
      visibility: "private",
    });
    emit("status", { message: `Created persistent Rool conversation ${conversationId}.`, conversationId });
  } else {
    emit("status", { message: `Resuming persistent Rool conversation ${conversationId}.`, conversationId });
  }

  emit("init", { workerLabel, machineId, profile, conversationId, taskId, bridgeVersion: BRIDGE_VERSION });

  state = await conversation.get();
  if (state?.isRunning) {
    emit("status", { message: "Existing Rool turn is still running; following it before continuing.", conversationId });
    await conversation.follow({ stallTimeoutMs: 120000 });
    state = await conversation.get();
  }

  const runMarker = `[PAPERCLIP-RUN:${runId}]`;
  const alreadyPrompted = hasRunMarker(state?.turns || [], runMarker);

  if (!alreadyPrompted) {
    const attachmentPaths = [contextPath];
    if (instructionsTransport?.remoteEntry) attachmentPaths.push(instructionsTransport.remoteEntry);
    if (skillsTransport.indexPath) attachmentPaths.push(skillsTransport.indexPath);
    for (const attachment of issueAttachments.uploaded) attachmentPaths.push(attachment.remotePath);

    const promptLines = [
      runMarker,
      `Complete Paperclip task ${issue.identifier || taskId}.`,
      `Read the attached ${contextPath} completely; it contains the authoritative task, wake and comment context.`,
    ];
    if (instructionsTransport?.remoteEntry) {
      promptLines.push(`Before doing the task, read managed Instructions entry ${instructionsTransport.remoteEntry}. Follow referenced files under ${instructionsTransport.remoteRoot} when required.`);
    }
    if (skillsTransport.indexPath) {
      promptLines.push(`Available Paperclip skills are indexed at ${skillsTransport.indexPath}. Load a skill from its listed Rool-drive directory only when relevant.`);
    }
    if (issueAttachments.uploaded.length) {
      promptLines.push(`The task has ${issueAttachments.uploaded.length} Paperclip attachment(s); they are attached to this turn and stored under ${remoteJoin(runBase, "attachments")}. Inspect the relevant files before conclusions.`);
    }
    promptLines.push(
      "Return the completed result, not a plan.",
      "Do not invent missing facts.",
      "Do not attempt Paperclip API/control-plane operations; the bridge owns checkout, persistence and final task state.",
    );
    const prompt = promptLines.join("\n");

    emit("status", {
      message: `Submitting run to Rool (${attachmentPaths.length} transported prompt attachment(s)).`,
      conversationId,
      taskId,
    });
    await conversation.prompt(prompt, { effort: "standard", attachments: attachmentPaths });
  } else {
    emit("status", { message: `Run ${runId} was already submitted; not duplicating the prompt.`, conversationId, taskId });
  }

  state = await conversation.get();
  if (!state) throw Object.assign(new Error(`Rool conversation ${conversationId} is unavailable`), { code: "rool_conversation_unavailable" });
  if (state.isRunning) await conversation.follow({ stallTimeoutMs: 120000 });
  state = await conversation.get();
  if (!state) throw Object.assign(new Error(`Rool conversation ${conversationId} disappeared`), { code: "rool_conversation_disappeared" });
  if (state.isRunning) throw Object.assign(new Error(`Rool conversation ${conversationId} is still running after follow timeout`), { code: "rool_conversation_stalled" });

  const assistant = assistantAfterMarker(state.turns || [], runMarker);
  if (!assistant) throw Object.assign(new Error("Rool finished without an assistant result for this task conversation"), { code: "rool_result_missing" });
  const resultText = turnText(assistant) || JSON.stringify(assistant);

  const self = await paperclipRequest(`/api/agents/me`, { optionalStatuses: [404] }) || await paperclipRequest(`/api/agents/${agentId}`);
  if (self?.reportsTo) {
    try {
      await paperclipRequest(`/api/issues/${taskId}/interactions`, {
        method: "POST",
        body: {
          kind: "request_confirmation",
          addresseeAgentId: self.reportsTo,
          idempotencyKey: `rool-review:${taskId}:${runId}`,
          title: `Review ${workerLabel} result`,
          summary: `${workerLabel} completed this task and requests manager review.`,
          continuationPolicy: "none",
          payload: {
            version: 1,
            prompt: `Accept this ${workerLabel} result?`,
            acceptLabel: "Accept",
            rejectLabel: "Request changes",
            rejectRequiresReason: true,
            rejectReasonLabel: "What should be changed?",
            detailsMarkdown: resultText.slice(0, 18000),
          },
        },
      });
    } catch (error) {
      emit("warning", { message: `Manager review request skipped: ${error?.message || error}` });
    }
  } else {
    emit("warning", { message: `${workerLabel} has no manager configured; continuing without manager review interaction.` });
  }

  await paperclipRequest(`/api/issues/${taskId}`, {
    method: "PATCH",
    body: { status: "done", comment: resultText },
  });

  emit("result", {
    mode: "run",
    text: resultText,
    summary: `Rool machine ${workerLabel} completed ${issue.identifier || taskId}.`,
    conversationId,
    taskId,
    machineId,
    profile,
    bridgeVersion: BRIDGE_VERSION,
    transported: {
      contextBytes,
      instructions: instructionsTransport ? { files: instructionsTransport.files, bytes: instructionsTransport.bytes } : null,
      skills: { count: skillsTransport.skills.length, files: skillsTransport.files, bytes: skillsTransport.bytes },
      attachments: { count: issueAttachments.uploaded.length, bytes: issueAttachments.bytes },
    },
  });
}

main().catch((error) => {
  emit("error", {
    code: stringValue(error?.code, "rool_bridge_failed"),
    message: error instanceof Error ? error.message : String(error),
    bridgeVersion: BRIDGE_VERSION,
  });
  process.exitCode = 1;
});
