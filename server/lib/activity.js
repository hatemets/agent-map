/**
 * Turn an agent's recent transcript into one plain-English line.
 *
 * Pure string formatting over the last few records — no API calls, no cost,
 * deterministic. Priority order is first-match-wins (see describeActivity).
 */

const path = require("path");
const { blocksOf, textOf } = require("./transcript");

function base(p) {
  if (!p || typeof p !== "string") return null;
  return path.basename(p) || p;
}

function truncate(s, n = 48) {
  if (!s) return "";
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${String(rem).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One tool_use block -> a phrase describing what it is doing. */
function phraseForTool(name, input = {}, extra = {}) {
  switch (name) {
    case "Read": {
      const f = base(input.file_path);
      const n = extra.readCount;
      if (f && n > 1) return `Reading ${f} (${n} files so far)`;
      return f ? `Reading ${f}` : "Reading a file";
    }
    case "Edit":
      return input.file_path ? `Editing ${base(input.file_path)}` : "Editing a file";
    case "Write":
      return input.file_path ? `Writing ${base(input.file_path)}` : "Writing a file";
    case "NotebookEdit":
      return input.notebook_path
        ? `Editing ${base(input.notebook_path)}`
        : "Editing a notebook";
    case "Bash": {
      const cmd = String(input.command || "").trim();
      const head = cmd.split(/\s+/)[0] || "a command";
      return `Running ${truncate(head, 24)}`;
    }
    case "Grep":
      return input.pattern
        ? `Searching for '${truncate(input.pattern, 32)}'`
        : "Searching files";
    case "Glob":
      return input.pattern ? `Finding ${truncate(input.pattern, 32)}` : "Finding files";
    case "WebFetch": {
      try {
        return `Fetching ${new URL(input.url).hostname}`;
      } catch {
        return "Fetching a page";
      }
    }
    case "WebSearch":
      return input.query
        ? `Searching web for '${truncate(input.query, 32)}'`
        : "Searching the web";
    case "TodoWrite":
      return "Planning";
    case "Agent":
    case "Task":
    case "Workflow":
      return "Delegating work";
    default:
      if (typeof name === "string" && name.startsWith("mcp__")) {
        const parts = name.split("__");
        return `Calling ${parts[parts.length - 1] || name}`;
      }
      return name ? `Using ${name}` : "Working";
  }
}

/**
 * Describe what an agent is doing right now (or what it did, if terminal).
 *
 * Priority:
 *   1. terminal status                 -> "Done - 12 tools, 3m40s"
 *   2. waiting on running children     -> "Waiting on 2 children"
 *   3. last tool call                  -> "Reading scanner.py (4 files so far)"
 *   4. assistant text, no tool         -> "Thinking"
 */
function describeActivity({
  records,
  status,
  runningChildren = 0,
  toolCalls = 0,
  activeMs = null,
  now = Date.now(),
}) {
  if (status === "done" || status === "failed") {
    const dur = fmtDuration(activeMs);
    const parts = [];
    if (toolCalls) parts.push(`${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
    if (dur) parts.push(dur);
    const suffix = parts.length ? ` — ${parts.join(", ")}` : "";
    return (status === "failed" ? "Failed" : "Done") + suffix;
  }

  if (runningChildren > 0) {
    return `Waiting on ${runningChildren} child${runningChildren === 1 ? "" : "ren"}`;
  }

  // Walk backwards to the most recent tool_use, counting Reads for context.
  let readCount = 0;
  let lastTool = null;
  let lastToolAt = null;
  for (let i = records.length - 1; i >= 0; i--) {
    for (const b of blocksOf(records[i])) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "Read") readCount++;
      if (!lastTool) {
        lastTool = b;
        lastToolAt = records[i].timestamp || null;
      }
    }
  }

  if (lastTool) {
    let phrase = phraseForTool(lastTool.name, lastTool.input || {}, { readCount });
    if (status === "stalled") {
      // Never attach live elapsed time to a cold transcript — an interrupted
      // session from last month would read as "Running cd — 696h".
      return `Stalled — last: ${phrase}`;
    }
    // Long-running Bash reads better with elapsed time attached.
    if (lastTool.name === "Bash" && lastToolAt) {
      const elapsed = fmtDuration(now - Date.parse(lastToolAt));
      if (elapsed) phrase += ` — ${elapsed}`;
    }
    return phrase;
  }

  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "assistant" && textOf(records[i]).trim()) {
      return status === "stalled" ? "Stalled while thinking" : "Thinking";
    }
  }

  return status === "stalled" ? "Stalled" : "Starting up";
}

module.exports = { describeActivity, phraseForTool, fmtDuration, truncate };
