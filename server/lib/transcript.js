/**
 * Reading and interpreting Claude Code transcript JSONL.
 *
 * Layout on disk (verified against ~/.claude/projects):
 *   <projects>/<projectSlug>/<sessionId>.jsonl              root session
 *   <projects>/<projectSlug>/<sessionId>/subagents/          one file per subagent
 *       agent-<agentId>.jsonl                                   flat, ALL depths
 *       workflows/<runId>/agent-<agentId>.jsonl                 workflow agents
 *       workflows/<runId>/journal.jsonl                         workflow bookkeeping
 *
 * Note the subagents directory is FLAT with respect to depth: a grandchild
 * agent sits beside its parent. Parentage is reconstructed in graph.js.
 */

const fs = require("fs");
const path = require("path");

const SPAWN_TOOLS = new Set(["Agent", "Task", "Workflow"]);

/** Read a JSONL file into records, skipping any unparsable (e.g. partially written) line. */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Trailing partial line during a live write, or a corrupt record. Skip it.
    }
  }
  return out;
}

/** Content blocks of a record's message, always as an array. */
function blocksOf(record) {
  const content = record?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Concatenated text of a record's message. */
function textOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  return blocksOf(record)
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

/**
 * The first real user turn of a subagent transcript — this is the verbatim
 * prompt its spawner passed, and the key the parent->child join runs on.
 * Skips `isMeta` records and attachments, which are harness bookkeeping.
 */
function firstUserText(records) {
  for (const r of records) {
    if (r.type !== "user" || r.isMeta) continue;
    const t = textOf(r);
    if (t.trim()) return t;
  }
  return null;
}

/**
 * Named teammate agents receive their prompt wrapped in an envelope:
 *   <teammate-message teammate_id="..." summary="...">\n{prompt}\n</teammate-message>
 * Strip it so the inner text matches the spawner's `input.prompt` exactly.
 */
const TEAMMATE_RE = /^\s*<teammate-message\b[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>\s*$/;

function unwrapTeammateMessage(text) {
  if (!text) return { text, teammateId: null, summary: null };
  const m = TEAMMATE_RE.exec(text);
  if (!m) return { text, teammateId: null, summary: null };
  const head = text.slice(0, text.indexOf(">") + 1);
  return {
    text: m[1],
    teammateId: (/teammate_id="([^"]*)"/.exec(head) || [])[1] || null,
    summary: (/summary="([^"]*)"/.exec(head) || [])[1] || null,
  };
}

/** Join key for matching a child's opening prompt to a spawn's `input.prompt`. */
function promptKey(text) {
  if (!text) return null;
  return unwrapTeammateMessage(text).text.trim().replace(/\s+/g, " ");
}

/**
 * Agent IDs encode the explicit name when one was given:
 *   "a" + <name> + "-" + <16 hex>   e.g. attm-fetcher-75f9ec8c23403fb4
 *   "a" + <16 hex>                  anonymous, e.g. a2c6a9df6532e96e2
 */
function nameFromAgentId(agentId) {
  if (!agentId) return null;
  const m = /^a(.+)-[0-9a-f]{16}$/.exec(agentId);
  return m ? m[1] : null;
}

/** Every Agent/Task/Workflow tool_use in a transcript, with its owning agent. */
function collectSpawns(records, ownerAgentId) {
  const spawns = [];
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b?.type !== "tool_use" || !SPAWN_TOOLS.has(b.name)) continue;
      spawns.push({
        ownerAgentId,
        toolUseId: b.id,
        tool: b.name,
        input: b.input || {},
        timestamp: r.timestamp || null,
        uuid: r.uuid || null,
      });
    }
  }
  spawns.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return spawns;
}

/**
 * tool_result records keyed by tool_use_id. A spawn having an entry here is the
 * definitive signal that the child finished.
 */
function collectToolResults(records) {
  const byId = new Map();
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      byId.set(b.tool_use_id, {
        toolUseId: b.tool_use_id,
        isError: b.is_error === true,
        content: b.content,
        toolUseResult: r.toolUseResult ?? null,
        timestamp: r.timestamp || null,
      });
    }
  }
  return byId;
}

/** Locate every subagent transcript under a session, tagged with its workflow run. */
function listSubagentFiles(sessionDir) {
  const root = path.join(sessionDir, "subagents");
  const found = [];

  const walk = (dir, workflowRunId) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "workflows") {
          // Each child directory is one workflow run id.
          let runs;
          try {
            runs = fs.readdirSync(full, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const run of runs) {
            if (run.isDirectory()) walk(path.join(full, run.name), run.name);
          }
        } else {
          walk(full, workflowRunId);
        }
        continue;
      }
      if (!e.name.endsWith(".jsonl")) continue;
      if (e.name === "journal.jsonl") continue;
      found.push({ file: full, workflowRunId });
    }
  };

  walk(root, null);
  return found;
}

/** Workflow journal: started/result entries keyed by agentId. */
function readWorkflowJournal(sessionDir, runId) {
  const file = path.join(
    sessionDir,
    "subagents",
    "workflows",
    runId,
    "journal.jsonl",
  );
  const byAgent = new Map();
  for (const rec of readJsonl(file)) {
    if (!rec.agentId) continue;
    const cur = byAgent.get(rec.agentId) || { agentId: rec.agentId };
    if (rec.type === "started") cur.started = true;
    if (rec.type === "result") cur.result = rec.result ?? null;
    if (rec.key) cur.key = rec.key;
    byAgent.set(rec.agentId, cur);
  }
  return byAgent;
}

module.exports = {
  SPAWN_TOOLS,
  readJsonl,
  blocksOf,
  textOf,
  firstUserText,
  unwrapTeammateMessage,
  promptKey,
  nameFromAgentId,
  collectSpawns,
  collectToolResults,
  listSubagentFiles,
  readWorkflowJournal,
};
