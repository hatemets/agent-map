/**
 * Live watching of a session.
 *
 * Rebuilding a RunGraph costs ~30ms for a typical session but ~450ms for a
 * 48-agent workflow run, so polling must not rebuild blindly. Each tick takes a
 * cheap fingerprint (file count + newest mtime, stat only) and rebuilds only
 * when the session has actually changed on disk.
 */

const fs = require("fs");
const path = require("path");
const { buildRunGraph } = require("./graph");

const TICK_MS = 1000;

/**
 * Cheap change-detector: how many transcript files exist and when the newest
 * was written. Catches both new agents appearing and existing ones growing.
 */
function fingerprint(projectDir, sessionId) {
  let count = 0;
  let newest = 0;

  const stat = (file) => {
    try {
      const st = fs.statSync(file);
      count++;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* raced with a delete */
    }
  };

  stat(path.join(projectDir, `${sessionId}.jsonl`));

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) stat(full);
    }
  };
  walk(path.join(projectDir, sessionId, "subagents"));

  return `${count}:${Math.round(newest)}`;
}

/**
 * Watch one session. Calls onUpdate(graph) immediately, then again whenever the
 * session changes on disk. Returns an unsubscribe function.
 *
 * Note the graph is also rebuilt when nothing changed but agents are still
 * marked running — status transitions to `stalled` are time-based, so a purely
 * mtime-driven watcher would leave a killed agent spinning forever.
 */
function watchSession({ projectDir, sessionId, onUpdate, tickMs = TICK_MS }) {
  let lastPrint = null;
  let lastHadLive = false;
  let lastRebuiltAt = 0;
  let stopped = false;

  // How often to rebuild a live-but-unchanged session purely so time-based
  // status (running -> stalled) can advance. Cheap relative to STALE_MS.
  const IDLE_REFRESH_MS = 5000;

  const rebuild = () => {
    if (stopped) return;
    lastRebuiltAt = Date.now();
    try {
      const graph = buildRunGraph({ projectDir, sessionId });
      lastHadLive = graph.agents.some((a) => a.status === "running");
      onUpdate(graph);
    } catch (err) {
      onUpdate({ error: String(err && err.message ? err.message : err), sessionId });
    }
  };

  const tick = () => {
    if (stopped) return;
    const print = fingerprint(projectDir, sessionId);
    const changed = print !== lastPrint;
    // Rebuilding a 48-agent session costs ~450ms, so don't do it every tick
    // just because something is still running — only when the files actually
    // moved, or on the slow heartbeat that ages agents into `stalled`.
    if (changed || (lastHadLive && Date.now() - lastRebuiltAt >= IDLE_REFRESH_MS)) {
      lastPrint = print;
      rebuild();
    }
  };

  lastPrint = fingerprint(projectDir, sessionId);
  rebuild();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { watchSession, fingerprint, TICK_MS };
