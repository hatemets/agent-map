# Agent Map — Engineering Guide

Agent Map is a local, read-only visualizer for Codex multi-agent runs.
It reconstructs an in-memory `RunGraph` from transcript JSONL, serves it over a
small Node HTTP/SSE server, and renders it with vanilla JavaScript and SVG.

The product promise is simple: show what actually happened without changing the
sessions being observed. A plausible-looking graph that drops an agent, invents
a cost, or leaks a local file is worse than no graph. This is observability
software, not interpretive dance.

## Read First

Read the rules that cover the files you will change before implementing:

| Work | Required rules |
| --- | --- |
| Any change | `AGENTS.md` |
| Server, API, discovery, transcript parsing, watcher, cost, or CLI | `server/server.md` |
| HTML, CSS, client JavaScript, SVG, interaction, or accessibility | `client/frontend.md` |

## Stack and Boundaries

- Node.js 20+, CommonJS, zero runtime dependencies.
- `server/` is a local HTTP server bound to `127.0.0.1` by default.
- `server/lib/graph.js` owns the canonical `RunGraph`; all views and CLI output
  derive from it.
- `client/` is static HTML, CSS, and browser JavaScript. There is no framework,
  bundler, generated client, or component library.
- `bin/dump-run.js` is the headless end-to-end inspection path.
- The observed source is Codex's local transcript directory. Agent Map
  must never modify it.

## Commands

```bash
npm test                         # Node's built-in test runner
npm start                        # http://localhost:4830
npm run dump -- <sessionId>      # inspect one run without the UI
npm run dump -- <sessionId> --json
```

`AGENT_MAP_PROJECTS_DIR` may point at a disposable transcript fixture directory
for tests or development. Do not point it at a path that this program writes to:
the supported mode is observation only.

## Core Invariants

1. **Never mutate source transcripts.** Use read/stat operations only. No
   cleanup, repair, lock, rename, cache file, or writeback inside the configured
   projects root.
2. **Never silently lose an agent.** Every discovered subagent transcript must
   appear exactly once in the graph. If parentage is unknowable, attach it to
   `ROOT` with `inferred: true`; preserve the uncertainty in the UI and CLI.
3. **Do not fabricate certainty.** Unknown models yield an unpriced cost, bad
   or partial JSONL lines are skipped defensively, and missing metadata is
   represented as unknown rather than guessed.
4. **The graph is the contract.** Tree, timeline, sequence, detail drawer, API,
   and CLI must agree because they consume the same graph fields. Do not
   re-derive parentage, status, totals, or cost in a consumer.
5. **Live reads race writers.** Codex can be writing while Agent Map reads.
   Parsing and watching must tolerate missing files, disappearing directories,
   and a final partial JSONL line without crashing the whole run.
6. **Stay local by default.** Bind loopback only. Do not add telemetry, uploads,
   remote calls, auth, or public exposure without an explicit product decision
   and a security review.

## Engineering Workflow

1. Inspect the relevant code and existing tests before deciding on a change.
2. For a transcript-format or graph change, trace the full chain:

   ```text
   JSONL record -> transcript helper -> RunGraph -> API/SSE or CLI -> client view
   ```

   Identify every field added, renamed, or reinterpreted. A field accepted by a
   parser but absent from the graph is not implemented.
3. Make the smallest coherent change. Preserve the zero-dependency design;
   adding a framework to draw a few rectangles would be a spectacularly
   expensive way to avoid writing a function.
4. Add or update deterministic tests for changed parser, matching, accounting,
   or state logic. Use small synthetic JSONL fixtures when a behavior needs
   coverage; local history is a valuable smoke corpus, not a durable fixture.
5. Run `npm test`. For changes that touch a run's visible output, also run
   `npm run dump -- <known-session-prefix>` when local history is available.
6. State precisely what was verified and what could not be verified. Never call
   a change complete while affected tests are failing or unrun.

## Code Standards

- Prefer small, named, synchronous helpers in `server/lib/`; filesystem access
  is deliberately simple and bounded.
- Keep non-obvious decisions documented with concise JSDoc: transcript quirks,
  matching fallbacks, pricing assumptions, and races are contractual behavior.
- Validate external or filesystem-derived input at the boundary. Session IDs,
  URL paths, environment paths, and JSONL records are all untrusted.
- Preserve errors at the right granularity: one corrupt record must not take
  down a run; a failed API request must return a useful JSON error; never hide a
  data-integrity problem behind a convincing zero.
- No new dependency, persistence layer, background daemon, or network request
  unless it is necessary to the requested capability and explicitly justified.
- Keep code style consistent with the existing CommonJS, semicolon, and
  double-quoted-string conventions.
- Agent-node titles must be human-readable names of at most four words. Preserve
  explicit semantic names such as `Reconnaissance Agent`; otherwise derive a
  concise role from the prompt or description. Number only truly identical
  sibling names, and keep the complete task prompt in the detail data.

## Verification and Completion

- Run `npm test` for every code change.
- Run the relevant headless CLI path for graph, discovery, cost, or API changes.
- For client interaction/layout changes, manually inspect the local page at
  desktop and narrow widths and exercise keyboard focus, tab selection, session
  selection, drawer close, pan/zoom, and live reconnect if touched.
- Do not report a cost as `$0` solely because a model is unrecognised. Surface
  it as unpriced and update the rate table only with a verified effective date.
- Do not claim a transcript layout is universal from a single session. Test the
  fallback behavior and document the observed compatibility boundary.

## Documentation Hygiene

Keep these rulefiles current when a recurring implementation trap is discovered.
Do not create one-off root-level fix logs or status reports unless requested.
The code, focused tests, commit history, and these rules are the maintained
record.

## Git

- Keep changes scoped; this repository may contain in-progress work.
- Inspect `git status` and the diff before staging.
- Never commit or push without explicit user approval.
