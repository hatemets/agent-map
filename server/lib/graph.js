/**
 * Reconstruct a RunGraph — the agent tree for one Claude Code session.
 *
 * This is the core of Agent Map. Everything the UI renders is a pure function
 * of the RunGraph this module produces.
 *
 * The hard part is parentage. Claude Code stores every subagent transcript in
 * one FLAT `subagents/` directory regardless of depth, and `promptId` is the
 * ROOT USER TURN id shared by every descendant of that turn — it is not a
 * parent pointer. Parentage is recovered by matching each child's opening user
 * message against the `input.prompt` of an Agent/Task tool_use somewhere in the
 * session (see joinChildren).
 */

const fs = require("fs");
const path = require("path");

const {
  readJsonl,
  blocksOf,
  firstUserText,
  promptKey,
  nameFromAgentId,
  collectSpawns,
  collectToolResults,
  listSubagentFiles,
  readWorkflowJournal,
  unwrapTeammateMessage,
} = require("./transcript");
const { describeActivity } = require("./activity");
const cost = require("./cost");

const ROOT = "ROOT";
/** A transcript untouched for longer than this, with no result, is stalled. */
const STALE_MS = 60_000;

// ── loading ──────────────────────────────────────────────────────────────────

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function loadTranscripts(projectDir, sessionId) {
  const rootFile = path.join(projectDir, `${sessionId}.jsonl`);
  const sessionDir = path.join(projectDir, sessionId);

  const transcripts = new Map();
  transcripts.set(ROOT, {
    agentId: ROOT,
    file: rootFile,
    records: readJsonl(rootFile),
    mtime: mtimeMs(rootFile),
    workflowRunId: null,
  });

  for (const { file, workflowRunId } of listSubagentFiles(sessionDir)) {
    const records = readJsonl(file);
    const agentId =
      records.find((r) => r.agentId)?.agentId ||
      path.basename(file, ".jsonl").replace(/^agent-/, "");
    // Same agent split across files would be a harness change; last one wins.
    transcripts.set(agentId, {
      agentId,
      file,
      records,
      mtime: mtimeMs(file),
      workflowRunId,
    });
  }

  return { transcripts, sessionDir, rootFile };
}

// ── parentage ────────────────────────────────────────────────────────────────

/** Extract a workflow runId from a Workflow spawn's tool_result. */
function workflowRunIdFromResult(result) {
  if (!result) return null;
  const hay = JSON.stringify(result.toolUseResult ?? "") + JSON.stringify(result.content ?? "");
  const m = /\b(wf_[a-z0-9-]{6,})\b/.exec(hay);
  return m ? m[1] : null;
}

/**
 * Match children to the spawns that created them.
 *
 * Workflow agents are resolved structurally (they live under
 * subagents/workflows/<runId>/, and the Workflow tool_result names that runId).
 * Everything else joins on the prompt text.
 *
 * Duplicate prompts are real and must not collapse: in run wf_642078e7-960 the
 * same prompt was dispatched twice, producing two distinct agents. When a key
 * has N children and N spawns, both are sorted by time and zipped.
 */
function joinChildren({ transcripts, spawns, resultsByToolUse }) {
  const parentOf = new Map(); // childAgentId -> { parentId, spawn, inferred }

  // 1. Workflow subtrees, resolved by run id.
  const workflowOwner = new Map(); // runId -> spawn
  for (const spawn of spawns) {
    if (spawn.tool !== "Workflow") continue;
    const runId = workflowRunIdFromResult(resultsByToolUse.get(spawn.toolUseId));
    if (runId) workflowOwner.set(runId, spawn);
  }
  for (const t of transcripts.values()) {
    if (t.agentId === ROOT || !t.workflowRunId) continue;
    const spawn = workflowOwner.get(t.workflowRunId);
    if (spawn) {
      parentOf.set(t.agentId, {
        parentId: spawn.ownerAgentId,
        spawn,
        inferred: false,
      });
    }
  }

  // 2. Prompt-text join for Agent/Task children.
  const spawnsByKey = new Map();
  for (const spawn of spawns) {
    if (spawn.tool === "Workflow") continue;
    const key = promptKey(spawn.input.prompt);
    if (!key) continue;
    if (!spawnsByKey.has(key)) spawnsByKey.set(key, []);
    spawnsByKey.get(key).push(spawn);
  }

  const childrenByKey = new Map();
  for (const t of transcripts.values()) {
    if (t.agentId === ROOT || parentOf.has(t.agentId)) continue;
    const key = promptKey(firstUserText(t.records));
    if (!key) continue;
    if (!childrenByKey.has(key)) childrenByKey.set(key, []);
    childrenByKey.get(key).push(t);
  }

  for (const [key, children] of childrenByKey) {
    const candidates = (spawnsByKey.get(key) || [])
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    if (!candidates.length) continue;

    children.sort((a, b) =>
      String(a.records[0]?.timestamp).localeCompare(String(b.records[0]?.timestamp)),
    );
    // Zip in time order; a surplus child reuses the last spawn rather than
    // being dropped, since a missing agent is worse than a mis-parented one.
    children.forEach((child, i) => {
      const spawn = candidates[Math.min(i, candidates.length - 1)];
      parentOf.set(child.agentId, {
        parentId: spawn.ownerAgentId,
        spawn,
        inferred: i >= candidates.length,
      });
    });
  }

  // 3. Never drop an agent. Anything unmatched attaches to the root, flagged.
  for (const t of transcripts.values()) {
    if (t.agentId === ROOT || parentOf.has(t.agentId)) continue;
    parentOf.set(t.agentId, { parentId: ROOT, spawn: null, inferred: true });
  }

  return parentOf;
}

// ── naming ───────────────────────────────────────────────────────────────────

/**
 * Agent titles identify a role, never the task sentence that spawned it. A
 * transcript can still retain the full prompt for the detail drawer, but a
 * graph is unreadable when every node is a differently truncated instruction.
 */
const MAX_NAME_WORDS = 4;
const ROLE_LABELS = [
  ["Reconnaissance Agent", /\b(?:reconnaissance|recon|enumerat|attack[\s_-]*surface|osint)\w*/i],
  ["Exploit Validation", /\b(?:exploit|payload|penetrat|poc|proof[\s_-]*of[\s_-]*concept)\w*/i],
  ["Authorization Review", /\b(?:authoriz|access[\s_-]*control|permission|privilege)\w*/i],
  ["Security Auditor", /\b(?:security[\s_-]*(?:audit|review|scan)|pentest|vulnerabilit)\w*/i],
  ["Team Lead", /\b(?:team[\s_-]*lead|lead[\s_-]*agent|orchestrat|coordinat|delegat)\w*/i],
  ["Debugger", /\b(?:debug|diagnos|trace|root[\s_-]*cause|error[\s_-]*boundary|investigat)\w*/i],
  ["Verifier", /\b(?:verif|validat|test|qa|review|audit|inspect|check)\w*/i],
  ["Implementer", /\b(?:implement|build|code|develop|patch|fix|refactor)\w*/i],
  ["Ideator", /\b(?:ideat|brainstorm|explor|propos|design|plan|strateg)\w*/i],
  ["Researcher", /\b(?:research|analys|source|search|gather|collect|digest)\w*/i],
  ["Writer", /\b(?:document|writ|summar|report)\w*/i],
  ["Fetcher", /\bfetch\w*/i],
  ["Deployer", /\b(?:deploy|release|ship)\w*/i],
];

const ROLE_INTRO = /\b(?:you are|you're|act as|your role is|role)\s*[:,-]?\s*(?:an?|the)?\s*/i;
const ROLE_STOP_WORDS = new Set([
  "and", "by", "check", "checking", "conduct", "conducting", "for", "from",
  "in", "map", "mapping", "on", "that", "the", "to", "validate", "validating",
  "who", "with", "while",
]);

/** Normalize a supplied name into a short display label without exposing IDs. */
function conciseName(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\/_-]+/g, " ")
    .replace(/[#:]\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:an?|the)\s+/i, "")
    .replace(/\s+#?\d+\s*$/, "")
    .trim();
  if (!text) return null;

  return text
    .split(" ")
    .slice(0, MAX_NAME_WORDS)
    .map((word) => /^[A-Z0-9]{2,6}$/.test(word) ? word : `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

/** Extract a role phrase from prompts written as "You are the ...". */
function rolePhraseForText(value) {
  if (typeof value !== "string") return null;
  const match = ROLE_INTRO.exec(value);
  if (!match) return null;
  const phrase = value.slice(match.index + match[0].length).split(/[.,;:\n—]/, 1)[0];
  const words = phrase.trim().split(/\s+/);
  const stop = words.findIndex((word) => ROLE_STOP_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, "")));
  return conciseName((stop >= 0 ? words.slice(0, stop) : words.slice(0, MAX_NAME_WORDS)).join(" "));
}

/** @returns {string|null} A concise, stable role label for transcript text. */
function roleLabelForText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[_-]/g, " ");
  for (const [label, pattern] of ROLE_LABELS) {
    if (pattern.test(text)) return label;
  }
  return rolePhraseForText(value);
}

function resolveName(transcript, spawn) {
  const opening = unwrapTeammateMessage(firstUserText(transcript.records) || "").text;
  const explicitValue = spawn?.input?.name;
  const explicit = /^[a-z0-9][a-z0-9_-]*$/.test(String(explicitValue || ""))
    ? roleLabelForText(explicitValue) || conciseName(explicitValue)
    : conciseName(explicitValue);
  if (explicit) {
    const source = /^[a-z0-9][a-z0-9_-]*$/.test(String(explicitValue || ""))
      ? "role:explicit"
      : "explicit";
    return { name: explicit, source };
  }

  const fromId = nameFromAgentId(transcript.agentId);
  if (fromId) {
    const name = roleLabelForText(fromId) || conciseName(fromId);
    if (name) return { name, source: "filename" };
  }

  const candidates = [
    [opening, "prompt"],
    [spawn?.input?.description, "description"],
    // "Explore" and "general-purpose" are broad execution modes, not an
    // agent's assignment. Use them only when the task text gives us nothing.
    [spawn?.input?.subagent_type, "subagent_type"],
  ];

  for (const [value, source] of candidates) {
    const name = roleLabelForText(value);
    if (name) return { name, source: `role:${source}` };
  }

  // An unknown role is more honest and more useful than a UUID fragment or a
  // task sentence. The prompt remains available in the detail drawer.
  return { name: "Specialist", source: "role:fallback" };
}

// ── metrics ──────────────────────────────────────────────────────────────────

function measure(records) {
  const tokens = cost.emptyTokens();
  const modelCounts = new Map();
  const billable = []; // { tokens, model, at } — priced after the dominant model is known
  let toolCalls = 0;
  let effort = null;
  let firstAt = null;
  let lastAt = null;

  for (const r of records) {
    if (r.timestamp) {
      if (!firstAt || r.timestamp < firstAt) firstAt = r.timestamp;
      if (!lastAt || r.timestamp > lastAt) lastAt = r.timestamp;
    }
    if (r.effort) effort = r.effort;

    for (const b of blocksOf(r)) {
      if (b?.type === "tool_use") toolCalls++;
    }

    if (r.type !== "assistant") continue;
    const model = r.message?.model || null;
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);

    const usage = r.message?.usage;
    if (!usage) continue;
    const t = cost.tokensFromUsage(usage);
    cost.addTokens(tokens, t);
    billable.push({ tokens: t, model, at: r.timestamp });
  }

  let model = null;
  let best = -1;
  for (const [m, n] of modelCounts) {
    if (n > best) {
      best = n;
      model = m;
    }
  }

  // Price each request at the model that served it. Records that carry usage
  // but no model (the harness omits it on some synthetic turns) fall back to
  // the agent's dominant model rather than silently costing $0.
  let usd = 0;
  let unpriced = false;
  for (const b of billable) {
    const c = cost.costUsd(b.tokens, b.model || model, b.at);
    if (c === null) unpriced = true;
    else usd += c;
  }

  return { tokens, costUsd: usd, unpriced, toolCalls, model, effort, firstAt, lastAt };
}

// ── status ───────────────────────────────────────────────────────────────────

function resolveStatus({ transcript, spawn, result, journalEntry, now }) {
  // For workflow agents the journal is the authoritative per-agent signal. The
  // Workflow spawn's own tool_result says only "async_launched" and is shared
  // by every agent in the run, so it must not drive per-child status.
  if (spawn?.tool === "Workflow") {
    if (journalEntry?.result !== undefined) {
      const r = journalEntry.result;
      const bad = r && typeof r === "object" && typeof r.status === "string"
        && !["OK", "completed", "success", "ok"].includes(r.status);
      return bad ? "failed" : "done";
    }
    return now - transcript.mtime < STALE_MS ? "running" : "stalled";
  }

  if (result) {
    if (result.isError) return "failed";
    const status =
      result.toolUseResult && typeof result.toolUseResult === "object"
        ? result.toolUseResult.status
        : null;
    if (status && !["completed", "OK", "success", "ok"].includes(status)) {
      // async_launched / teammate_spawned mean "dispatched", not "finished".
      if (status === "async_launched" || status === "teammate_spawned") {
        return now - transcript.mtime < STALE_MS ? "running" : "stalled";
      }
      return "failed";
    }
    return "done";
  }

  if (journalEntry && journalEntry.result !== undefined) return "done";

  return now - transcript.mtime < STALE_MS ? "running" : "stalled";
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.projectDir  e.g. ~/.claude/projects/-Users-mark-projects-algotrader
 * @param {string} opts.sessionId   the session uuid
 * @param {number} [opts.now]       injectable clock, for tests
 * @returns {object} RunGraph
 */
function buildRunGraph({ projectDir, sessionId, now = Date.now() }) {
  const { transcripts, sessionDir } = loadTranscripts(projectDir, sessionId);

  // Spawns and tool results from every transcript at every depth.
  const spawns = [];
  const resultsByToolUse = new Map();
  for (const t of transcripts.values()) {
    spawns.push(...collectSpawns(t.records, t.agentId));
    for (const [id, res] of collectToolResults(t.records)) {
      resultsByToolUse.set(id, res);
    }
  }
  spawns.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const parentOf = joinChildren({ transcripts, spawns, resultsByToolUse });

  // Workflow journals give terminal status for workflow agents.
  const journals = new Map();
  for (const t of transcripts.values()) {
    if (t.workflowRunId && !journals.has(t.workflowRunId)) {
      journals.set(t.workflowRunId, readWorkflowJournal(sessionDir, t.workflowRunId));
    }
  }

  // Pass 1: nodes with metrics and status.
  const nodes = new Map();
  for (const t of transcripts.values()) {
    const link = t.agentId === ROOT ? null : parentOf.get(t.agentId);
    const spawn = link?.spawn || null;
    const result = spawn ? resultsByToolUse.get(spawn.toolUseId) || null : null;
    const journalEntry = t.workflowRunId
      ? journals.get(t.workflowRunId)?.get(t.agentId) || null
      : null;

    const m = measure(t.records);
    const { name, source } = t.agentId === ROOT
      ? { name: "Orchestrator", source: "explicit" }
      : resolveName(t, spawn);

    const status =
      t.agentId === ROOT
        ? now - t.mtime < STALE_MS
          ? "running"
          : "done"
        : resolveStatus({ transcript: t, spawn, result, journalEntry, now });

    // An agent's own last record is the truthful end. The spawn's tool_result
    // timestamp is only when the PARENT observed completion — for a Workflow
    // spawn that is "async_launched", which fires before the children even run
    // and would yield a negative duration.
    const endedAt = status === "running" ? null : m.lastAt || result?.timestamp || null;

    nodes.set(t.agentId, {
      id: t.agentId,
      name,
      nameSource: source,
      subagentType: spawn?.input?.subagent_type || null,
      description: spawn?.input?.description || null,
      model: m.model || spawn?.input?.model || null,
      effort: m.effort,
      depth: 0,
      parentId: link ? link.parentId : null,
      inferred: link ? link.inferred : false,
      status,
      startedAt: m.firstAt,
      endedAt,
      activeMs:
        m.firstAt && (endedAt || m.lastAt)
          ? Date.parse(endedAt || m.lastAt) - Date.parse(m.firstAt)
          : null,
      tokens: m.tokens,
      costUsd: m.costUsd,
      unpricedModel: m.unpriced,
      toolCalls: m.toolCalls,
      workflowRunId: t.workflowRunId,
      spawnToolUseId: spawn?.toolUseId || null,
      prompt: spawn?.input?.prompt || firstUserText(t.records) || null,
      activity: "",
      subtree: null,
    });
  }

  // Guard against a cycle from a bad join before any tree walk.
  breakCycles(nodes);
  disambiguateSiblingNames(nodes);

  // Depth, children index.
  const childrenOf = new Map();
  for (const n of nodes.values()) {
    if (!n.parentId) continue;
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
    childrenOf.get(n.parentId).push(n.id);
  }
  const assignDepth = (id, depth) => {
    const n = nodes.get(id);
    if (!n) return;
    n.depth = depth;
    for (const c of childrenOf.get(id) || []) assignDepth(c, depth + 1);
  };
  assignDepth(ROOT, 0);

  // Pass 2: activity lines (need children statuses) and subtree rollups.
  for (const n of nodes.values()) {
    const kids = (childrenOf.get(n.id) || []).map((id) => nodes.get(id));
    const runningChildren = kids.filter(
      (k) => k.status === "running" || k.status === "stalled",
    ).length;
    n.activity = describeActivity({
      records: transcripts.get(n.id).records,
      status: n.status,
      runningChildren,
      toolCalls: n.toolCalls,
      activeMs: n.activeMs,
      now,
    });
  }
  rollUp(ROOT, nodes, childrenOf);

  // Edges + sequence-view messages.
  const edges = [];
  const messages = [];
  for (const n of nodes.values()) {
    if (!n.parentId) continue;
    const result = n.spawnToolUseId ? resultsByToolUse.get(n.spawnToolUseId) : null;
    edges.push({
      parentId: n.parentId,
      childId: n.id,
      spawnToolUseId: n.spawnToolUseId,
      spawnedAt: n.startedAt,
      resolvedAt: result?.timestamp || n.endedAt || null,
      inferred: n.inferred,
    });
    if (n.startedAt) {
      messages.push({
        from: n.parentId,
        to: n.id,
        at: n.startedAt,
        kind: "prompt",
        label: n.name,
      });
    }
    const back = result?.timestamp || n.endedAt;
    if (back && n.status !== "running") {
      messages.push({
        from: n.id,
        to: n.parentId,
        at: back,
        kind: n.status === "failed" ? "error" : "result",
        label: n.status === "failed" ? "failed" : "result",
      });
    }
  }
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const root = nodes.get(ROOT);
  const rootRecord = transcripts.get(ROOT).records.find((r) => r.cwd) || {};

  return {
    sessionId,
    project: path.basename(projectDir),
    cwd: rootRecord.cwd || null,
    gitBranch: rootRecord.gitBranch || null,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    status: root.status,
    agents: [...nodes.values()].sort((a, b) =>
      String(a.startedAt).localeCompare(String(b.startedAt)),
    ),
    edges,
    messages,
    totals: root.subtree,
  };
}

/** Re-root any node whose parent chain loops back to it. */
function breakCycles(nodes) {
  for (const n of nodes.values()) {
    const seen = new Set([n.id]);
    let cur = n;
    while (cur.parentId) {
      if (seen.has(cur.parentId)) {
        n.parentId = ROOT;
        n.inferred = true;
        break;
      }
      seen.add(cur.parentId);
      cur = nodes.get(cur.parentId);
      if (!cur) {
        n.parentId = ROOT;
        n.inferred = true;
        break;
      }
    }
  }
}

/**
 * Number only genuinely identical sibling names. Distinct semantic names are
 * preserved, while an indistinguishable duplicate still remains identifiable.
 */
function disambiguateSiblingNames(nodes) {
  const groups = new Map();
  for (const n of nodes.values()) {
    if (!n.parentId) continue;
    const key = `${n.parentId} ${n.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    group.forEach((n, i) => {
      n.name = `${n.name} #${i + 1}`;
    });
  }
}

/** Own + descendant token/cost totals, so a collapsed branch still shows its weight. */
function rollUp(id, nodes, childrenOf) {
  const n = nodes.get(id);
  if (!n) return cost.emptyTokens();
  const tokens = cost.addTokens(cost.emptyTokens(), n.tokens);
  let usd = n.costUsd;
  let agents = 1;
  let unpriced = n.unpricedModel;
  for (const childId of childrenOf.get(id) || []) {
    const sub = rollUp(childId, nodes, childrenOf);
    cost.addTokens(tokens, sub.tokens);
    usd += sub.costUsd;
    agents += sub.agents;
    unpriced ||= sub.unpriced;
  }
  // costUsd retains the priced portion for diagnostics, while unpriced tells
  // every consumer that presenting that partial sum as the total would lie.
  n.subtree = { tokens, costUsd: usd, agents, unpriced };
  return n.subtree;
}

module.exports = { buildRunGraph, resolveName, rollUp, roleLabelForText, ROOT, STALE_MS };
