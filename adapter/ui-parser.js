const PREFIX = "@@PAPERCLIP_ROOL@@";

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function parseStdoutLine(line, ts) {
  if (!line.startsWith(PREFIX)) {
    return line ? [{ kind: "stdout", ts, text: line }] : [];
  }

  let event;
  try {
    event = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }

  switch (event?.type) {
    case "init":
      return [{
        kind: "init",
        ts,
        model: asString(event.workerLabel, "Rool"),
        sessionId: asString(event.conversationId, asString(event.machineId, "rool")),
      }];
    case "status":
      return [{ kind: "system", ts, text: asString(event.message, "Rool status update") }];
    case "warning":
      return [{ kind: "stderr", ts, text: asString(event.message, "Rool warning") }];
    case "error":
      return [{ kind: "stderr", ts, text: `${asString(event.code, "rool_error")}: ${asString(event.message, "Rool bridge failed")}` }];
    case "assistant":
      return [{ kind: "assistant", ts, text: asString(event.text, "") }];
    case "result":
      return [{
        kind: "result",
        ts,
        text: asString(event.text, asString(event.summary, "Rool completed.")),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "rool_result",
        isError: false,
        errors: [],
      }];
    default:
      return [{ kind: "system", ts, text: asString(event?.message, `Rool event: ${asString(event?.type, "unknown")}`) }];
  }
}
