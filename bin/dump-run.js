#!/usr/bin/env node
/**
 * Print a session's agent tree as ASCII. This is the dev loop for the engine —
 * it exercises graph.js end to end with no server and no UI.
 *
 *   node bin/dump-run.js                 # list recent sessions
 *   node bin/dump-run.js <sessionId>     # tree for one session (prefix ok)
 *   node bin/dump-run.js <sessionId> --json
 */

const { buildRunGraph, ROOT } = require("../server/lib/graph");
const { listAllSessions, listActiveSessions, findSession } = require("../server/lib/discovery");
const { fmtDuration } = require("../server/lib/activity");

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

const MARK = { running: "●", stalled: "◐", done: "✓", failed: "✗" };

function printTree(graph) {
  const byId = new Map(graph.agents.map((a) => [a.id, a]));
  const kids = new Map();
  for (const a of graph.agents) {
    if (!a.parentId) continue;
    if (!kids.has(a.parentId)) kids.set(a.parentId, []);
    kids.get(a.parentId).push(a.id);
  }

  const line = (a, prefix, isLast, isRoot) => {
    const branch = isRoot ? "" : prefix + (isLast ? "└─ " : "├─ ");
    const bits = [
      a.model || "?",
      fmtTokens(a.tokens.total),
      fmtUsd(a.unpricedModel ? null : a.costUsd),
    ];
    if (a.effort) bits.push(a.effort);
    const flag = a.inferred ? " ~inferred" : "";
    console.log(
      `${branch}${MARK[a.status] || "?"} ${a.name}${flag}  [${bits.join(" · ")}]`,
    );
    const contPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    console.log(`${contPrefix}     ${a.activity}`);

    const children = (kids.get(a.id) || []).map((id) => byId.get(id));
    children.forEach((c, i) =>
      line(c, contPrefix, i === children.length - 1, false),
    );
  };

  line(byId.get(ROOT), "", true, true);
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const id = args.find((a) => !a.startsWith("--"));

  if (!id) {
    const active = listActiveSessions();
    const recent = listAllSessions().slice(0, 15);
    if (active.length) {
      console.log("ACTIVE (last 10 min):");
      for (const s of active) {
        console.log(`  ${s.sessionId}  ${s.project}${s.hasSubagents ? "  [subagents]" : ""}`);
      }
      console.log("");
    }
    console.log("RECENT:");
    for (const s of recent) {
      const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
      console.log(
        `  ${s.sessionId}  ${when}  ${s.project}${s.hasSubagents ? "  [subagents]" : ""}`,
      );
    }
    console.log("\nUsage: node bin/dump-run.js <sessionId>");
    return;
  }

  const found = findSession(id);
  if (!found) {
    console.error(`No session matching "${id}".`);
    process.exit(1);
  }

  const t0 = Date.now();
  const graph = buildRunGraph({
    projectDir: found.projectDir,
    sessionId: found.sessionId,
  });
  const parseMs = Date.now() - t0;

  if (asJson) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  console.log(`session  ${graph.sessionId}`);
  console.log(`project  ${graph.project}   ${graph.cwd || ""}`);
  console.log(`status   ${graph.status}   started ${graph.startedAt || "?"}`);
  console.log(
    `totals   ${graph.totals.agents} agents · ${fmtTokens(graph.totals.tokens.total)} tokens · ${fmtUsd(graph.totals.costUsd)}`,
  );
  console.log(`parsed   ${fmtDuration(parseMs) || `${parseMs}ms`}\n`);
  printTree(graph);

  const inferred = graph.agents.filter((a) => a.inferred);
  if (inferred.length) {
    console.log(
      `\n⚠ ${inferred.length} agent(s) could not be matched to a spawn; attached to root.`,
    );
  }
}

main();
