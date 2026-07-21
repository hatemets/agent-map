/**
 * Golden-file tests against real transcripts in ~/.claude/projects.
 *
 * These two sessions were chosen because between them they cover every case the
 * engine has to get right: depth-2 nesting, named teammates, a 40+ agent
 * workflow run, and a duplicate-prompt collision. If the fixtures are absent
 * (another machine, or history pruned) the suite skips rather than fails.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { buildRunGraph, rollUp, ROOT } = require("../lib/graph");
const { findSession } = require("../lib/discovery");
const cost = require("../lib/cost");
const { promptKey, nameFromAgentId, unwrapTeammateMessage } = require("../lib/transcript");

const NESTED = "7e266487-ea02-44a0-8662-9ca858ef4cc2";
const WORKFLOW = "384cd286-fcc9-4fcc-ba42-65c1082273c5";

function load(sessionId) {
  const found = findSession(sessionId);
  if (!found) return null;
  return buildRunGraph({ projectDir: found.projectDir, sessionId: found.sessionId });
}

/** Count subagent transcripts on disk, excluding workflow journals. */
function countSubagentFiles(projectDir, sessionId) {
  const root = path.join(projectDir, sessionId, "subagents");
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl") && e.name !== "journal.jsonl") n++;
    }
  };
  walk(root);
  return n;
}

// ── unit: the join primitives ────────────────────────────────────────────────

test("promptKey strips the teammate envelope so named agents join", () => {
  const inner = "Expand the dossier.\nDo the thing.";
  const wrapped = `<teammate-message teammate_id="team-lead" summary="Do it">\n${inner}\n</teammate-message>`;
  assert.strictEqual(promptKey(wrapped), promptKey(inner));
  assert.strictEqual(unwrapTeammateMessage(wrapped).teammateId, "team-lead");
  assert.strictEqual(unwrapTeammateMessage(wrapped).summary, "Do it");
});

test("nameFromAgentId separates named agents from anonymous ones", () => {
  assert.strictEqual(nameFromAgentId("attm-fetcher-75f9ec8c23403fb4"), "ttm-fetcher");
  assert.strictEqual(nameFromAgentId("a2c6a9df6532e96e2"), null);
});

test("cache tiers are priced at their documented multipliers", () => {
  const rate = cost.ratesFor("claude-opus-4-8").in; // $5 / MTok
  const read = cost.costUsd({ ...cost.emptyTokens(), cacheRead: 1e6 }, "claude-opus-4-8");
  const w5m = cost.costUsd({ ...cost.emptyTokens(), cacheCreate5m: 1e6 }, "claude-opus-4-8");
  const w1h = cost.costUsd({ ...cost.emptyTokens(), cacheCreate1h: 1e6 }, "claude-opus-4-8");
  assert.ok(Math.abs(read - rate * 0.1) < 1e-9);
  assert.ok(Math.abs(w5m - rate * 1.25) < 1e-9);
  assert.ok(Math.abs(w1h - rate * 2.0) < 1e-9);
  assert.strictEqual(cost.costUsd(cost.emptyTokens(), "some-future-model"), null);
});

test("short model aliases from spawn inputs resolve to real rates", () => {
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
    assert.ok(cost.isKnownModel(alias), `${alias} should price`);
  }
  assert.ok(cost.isKnownModel("claude-haiku-4-5-20251001"), "dated snapshot should price");
});

test("subtree rollups preserve unpriced cost uncertainty", () => {
  const tokens = () => ({ ...cost.emptyTokens() });
  const nodes = new Map([
    [ROOT, { tokens: tokens(), costUsd: 1, unpricedModel: false }],
    ["known", { tokens: tokens(), costUsd: 2, unpricedModel: false }],
    ["unknown", { tokens: tokens(), costUsd: 0, unpricedModel: true }],
  ]);
  const children = new Map([[ROOT, ["known", "unknown"]]]);

  const total = rollUp(ROOT, nodes, children);

  assert.strictEqual(total.costUsd, 3, "priced portion remains available for diagnostics");
  assert.strictEqual(total.unpriced, true, "consumer must not present the partial sum as total");
  assert.strictEqual(total.agents, 3);
});

// ── golden: depth-2 nesting ──────────────────────────────────────────────────

test("nested session: grandchildren are parented to their real spawner", (t) => {
  const graph = load(NESTED);
  if (!graph) return t.skip("fixture session not present on this machine");

  const byId = new Map(graph.agents.map((a) => [a.id, a]));

  // These two agents each spawned their own subagents mid-task.
  for (const parentId of ["a7fec811bca6b6bb6", "aafa1cdbacb583eb0"]) {
    const kids = graph.agents.filter((a) => a.parentId === parentId);
    assert.ok(kids.length > 0, `${parentId} should have children, not siblings`);
    for (const k of kids) assert.strictEqual(k.depth, 2, `${k.name} should be depth 2`);
  }

  const maxDepth = Math.max(...graph.agents.map((a) => a.depth));
  assert.strictEqual(maxDepth, 2, "tree should be two levels deep, not flattened");
  assert.strictEqual(byId.get(ROOT).depth, 0);
});

// ── golden: the 40+ agent workflow run ───────────────────────────────────────

test("workflow session: every transcript appears exactly once", (t) => {
  const found = findSession(WORKFLOW);
  if (!found) return t.skip("fixture session not present on this machine");
  const graph = buildRunGraph({ projectDir: found.projectDir, sessionId: found.sessionId });

  const onDisk = countSubagentFiles(found.projectDir, found.sessionId);
  assert.strictEqual(
    graph.agents.length,
    onDisk + 1,
    `expected ${onDisk} subagents + root, got ${graph.agents.length}`,
  );

  const ids = graph.agents.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, ids.length, "no agent may be duplicated");
});

test("workflow session: named teammates keep their real names and models", (t) => {
  const graph = load(WORKFLOW);
  if (!graph) return t.skip("fixture session not present on this machine");

  const fetcher = graph.agents.find((a) => a.name === "ttm-fetcher");
  const digest = graph.agents.find((a) => a.name === "ttm-digest2");
  assert.ok(fetcher, "ttm-fetcher should resolve by name");
  assert.ok(digest, "ttm-digest2 should resolve by name");
  // The spawn passed `name:`, so the name comes from the spawn input; the
  // agentId-encoded name is the fallback when a spawn can't be matched.
  assert.ok(["explicit", "filename"].includes(fetcher.nameSource), fetcher.nameSource);
  assert.match(fetcher.model, /haiku/);
  assert.match(digest.model, /sonnet/);
});

test("workflow session: the duplicate-prompt pair stays two distinct agents", (t) => {
  const graph = load(WORKFLOW);
  if (!graph) return t.skip("fixture session not present on this machine");

  // Same prompt dispatched twice by the workflow script.
  for (const id of ["a78e67f419f5fae83", "a2c6a9df6532e96e2"]) {
    assert.ok(
      graph.agents.some((a) => a.id === id),
      `${id} must survive the join, not collapse into its twin`,
    );
  }
});

// ── invariants that must hold for any session ────────────────────────────────

for (const [label, sessionId] of [["nested", NESTED], ["workflow", WORKFLOW]]) {
  test(`${label} session: no agent falls into the inferred bucket`, (t) => {
    const graph = load(sessionId);
    if (!graph) return t.skip("fixture session not present on this machine");
    const inferred = graph.agents.filter((a) => a.inferred);
    assert.deepStrictEqual(
      inferred.map((a) => a.name),
      [],
      "every agent should match a real spawn",
    );
  });

  test(`${label} session: every model seen is priced`, (t) => {
    const graph = load(sessionId);
    if (!graph) return t.skip("fixture session not present on this machine");
    const unpriced = graph.agents.filter((a) => a.unpricedModel).map((a) => a.model);
    assert.deepStrictEqual(unpriced, [], "no silent $0 from an unknown model");
  });

  test(`${label} session: subtree totals equal the sum of their parts`, (t) => {
    const graph = load(sessionId);
    if (!graph) return t.skip("fixture session not present on this machine");

    const summed = graph.agents.reduce((acc, a) => acc + a.tokens.total, 0);
    assert.strictEqual(
      graph.totals.tokens.total,
      summed,
      "root rollup must equal the sum of per-agent tokens — nothing lost or double counted",
    );
    assert.strictEqual(graph.totals.agents, graph.agents.length);
  });

  test(`${label} session: every agent has a parent chain reaching the root`, (t) => {
    const graph = load(sessionId);
    if (!graph) return t.skip("fixture session not present on this machine");
    const byId = new Map(graph.agents.map((a) => [a.id, a]));
    for (const a of graph.agents) {
      let cur = a;
      let hops = 0;
      while (cur.parentId && hops++ < 100) cur = byId.get(cur.parentId);
      assert.strictEqual(cur.id, ROOT, `${a.name} should reach the root`);
    }
  });

  test(`${label} session: no agent ends before it starts`, (t) => {
    const graph = load(sessionId);
    if (!graph) return t.skip("fixture session not present on this machine");
    for (const a of graph.agents) {
      if (a.activeMs === null) continue;
      assert.ok(a.activeMs >= 0, `${a.name} has negative duration ${a.activeMs}ms`);
    }
  });
}
