# Agent Map

Live visualizer for Claude Code multi-agent workflows. Open it on a second
monitor and watch the agent team work: who reports to whom, what each one is
doing right now, how many tokens it has burned, and what it cost.

Reads `~/.claude/projects` directly — no hooks, no instrumentation, no config.
It works retroactively on every session you have ever run.

```bash
node server/index.js     # → http://localhost:4830
```

Zero dependencies. Node 20+.

---

## Views

All three render from the same `RunGraph`, so they always agree.

| View | Answers |
|---|---|
| **Tree** | Who reports to whom, and what is each agent doing *right now* |
| **Timeline** | Where did the time go — what ran in parallel, what was the straggler |
| **Sequence** | The protocol of the run — prompts down, results back |

Click any agent for its prompt, tool count, subtree rollup, and a token
breakdown that separates cache reads from real input (they differ by 10x in
price and usually by 100x in volume).

## CLI

The engine runs headless, which is also the fastest way to sanity-check it:

```bash
node bin/dump-run.js                 # list live + recent sessions
node bin/dump-run.js <sessionId>     # ASCII tree (id prefix is enough)
node bin/dump-run.js <sessionId> --json
```

---

## How it works

```
~/.claude/projects/<project>/<sessionId>.jsonl          root session
                            /<sessionId>/subagents/     one file per subagent
                                  agent-<agentId>.jsonl        flat, ALL depths
                                  workflows/<runId>/…          workflow agents
```

`server/lib/graph.js` turns those files into a `RunGraph`. The hard part is
parentage: the `subagents/` directory is **flat** regardless of depth, and
`promptId` is the *root user turn* id shared by every descendant of that turn —
it is not a parent pointer.

Parentage is recovered by matching each child's opening user message against the
`input.prompt` of an `Agent`/`Task` tool_use somewhere in the session. Two
wrinkles the code handles explicitly:

- **Named teammates** wrap the prompt in `<teammate-message …>…</teammate-message>`,
  so the envelope is stripped before matching.
- **Duplicate prompts are real.** A fan-out can dispatch the identical prompt
  twice. When a key has N children and N spawns, both are sorted by time and
  zipped rather than collapsed.

Workflow agents are resolved structurally instead: the `Workflow` tool_result
names the `runId`, and every agent under `subagents/workflows/<runId>/` belongs
to it. Their per-agent completion comes from that run's `journal.jsonl` — the
Workflow spawn's own result only says `async_launched`.

Anything that still fails to match attaches to the root with `inferred: true`
and renders with a dashed edge. **An agent is never dropped** — a missing agent
is a worse bug than a mis-parented one.

### Known limitations

- **Workflow agent labels are not persisted.** The `label:` passed to `agent()`
  may never reach the transcript or journal, so Agent Map preserves explicit
  persisted names when available and otherwise derives a human-readable role
  of at most four words from the prompt. Identical fan-out roles still receive
  a numeric suffix because the source contains no distinguishing name.
- Cost uses published list prices and assumes the standard service tier.

---

## Verification

```bash
node --test server/__tests__/*.test.js
```

The tests are golden-file assertions against real sessions in
`~/.claude/projects` (they skip, rather than fail, if those sessions are gone).
Beyond the structural cases, they enforce the invariants that matter:

- every subagent transcript appears exactly once
- no agent lands in the `inferred` bucket
- per-agent tokens sum exactly to the root rollup — nothing lost or double counted
- every model seen resolves to a price (no silent `$0`)
- no agent ends before it starts

Last full sweep over local history: **326 sessions / 2404 agents parsed, 0
crashes, 1 unmatched agent** (a transcript with an empty prompt — nothing to
join on), 0 negative durations, 0 unpriced models, 10s total.

---

## Layout

```
server/lib/graph.js       the engine — records to agent tree
server/lib/transcript.js  JSONL reading, prompt keys, spawn extraction
server/lib/activity.js    last tool call to plain English
server/lib/cost.js        usage to tokens + USD, cache tiers priced separately
server/lib/discovery.js   find sessions (stat only, never parses)
server/lib/watcher.js     fingerprint-driven live rebuild
server/index.js           http + SSE, no framework
client/                   vanilla JS + SVG, no build step
bin/dump-run.js           headless ASCII tree
```

Scope is deliberate: Claude Code only, observe-only, local-only, single user.
