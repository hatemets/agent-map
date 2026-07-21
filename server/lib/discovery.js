/**
 * Locate Claude Code sessions on disk.
 *
 * ~/.claude/projects holds one directory per project (the cwd with slashes
 * replaced by dashes), and one <sessionId>.jsonl per session inside it.
 * At ~1000 sessions / several GB, this module only ever stats — it never
 * parses. Parsing happens on demand in graph.js.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function projectsRoot() {
  return (
    process.env.AGENT_MAP_PROJECTS_DIR ||
    path.join(os.homedir(), ".claude", "projects")
  );
}

/** Every project directory that currently exists. */
function listProjects(root = projectsRoot()) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ slug: e.name, dir: path.join(root, e.name) }));
}

const SESSION_FILE_RE = /^([0-9a-f-]{36})\.jsonl$/i;

/** Sessions in one project, newest first. Stat only — no parsing. */
function listSessions(projectDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = SESSION_FILE_RE.exec(e.name);
    if (!m) continue;
    const file = path.join(projectDir, e.name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({
      sessionId: m[1],
      projectDir,
      project: path.basename(projectDir),
      file,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      hasSubagents: fs.existsSync(path.join(projectDir, m[1], "subagents")),
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** All sessions across all projects, newest first. */
function listAllSessions(root = projectsRoot()) {
  const all = [];
  for (const p of listProjects(root)) all.push(...listSessions(p.dir));
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Sessions touched recently — the watch set. A session counts as active if its
 * root transcript OR any of its subagent transcripts was written inside the
 * window (a busy subagent can outpace a quiet orchestrator).
 */
function listActiveSessions({
  root = projectsRoot(),
  windowMs = DEFAULT_ACTIVE_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const active = [];
  for (const s of listAllSessions(root)) {
    const newest = Math.max(s.mtimeMs, newestSubagentMtime(s.projectDir, s.sessionId));
    if (now - newest <= windowMs) active.push({ ...s, newestMtimeMs: newest });
  }
  return active.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
}

function newestSubagentMtime(projectDir, sessionId) {
  const dir = path.join(projectDir, sessionId, "subagents");
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".jsonl")) continue;
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        /* raced with a delete */
      }
    }
  };
  walk(dir);
  return newest;
}

/** Resolve a session id (or unique prefix) to its project directory. */
function findSession(sessionId, root = projectsRoot()) {
  const all = listAllSessions(root);
  return (
    all.find((s) => s.sessionId === sessionId) ||
    all.find((s) => s.sessionId.startsWith(sessionId)) ||
    null
  );
}

module.exports = {
  projectsRoot,
  listProjects,
  listSessions,
  listAllSessions,
  listActiveSessions,
  newestSubagentMtime,
  findSession,
  DEFAULT_ACTIVE_WINDOW_MS,
};
