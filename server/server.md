# Server, Transcript, and CLI Rules

**Applies to:** `server/**` and `bin/**`.

## Ownership

| Module | Responsibility |
| --- | --- |
| `lib/discovery.js` | Find local Claude Code sessions using metadata-only scans. |
| `lib/transcript.js` | Read JSONL safely and normalize transcript-specific shapes. |
| `lib/graph.js` | Build the canonical `RunGraph`, parentage, status, rollups. |
| `lib/activity.js` | Turn latest transcript activity into display text. |
| `lib/cost.js` | Normalize token buckets and calculate explicitly-versioned USD costs. |
| `lib/watcher.js` | Detect transcript changes cheaply and rebuild live graphs. |
| `index.js` | Loopback HTTP, JSON API, SSE lifecycle, and static-file serving. |
| `bin/dump-run.js` | Headless consumer of the same graph contract. |

## Transcript Parsing

- Treat all JSONL as concurrently written, untrusted input. Skip an individual
  malformed or trailing partial record, but do not throw away the whole file.
- Keep raw record interpretation in `transcript.js`. Consumers should not walk
  message blocks or duplicate envelope stripping.
- Preserve the current transcript layout facts in code comments and tests:
  subagent files are flat across nesting, `promptId` is not a parent pointer,
  named teammates wrap their first prompt, and workflow results live in a
  journal.
- When Claude Code changes its transcript format, first add a small fixture that
  captures the new shape, then change parsing and graph construction. Do not
  patch the UI to compensate for bad source interpretation.
- Duplicate spawn prompts are valid fan-out. Match all agents deterministically
  in timestamp order; never collapse them into one node.

## RunGraph Integrity

- `buildRunGraph()` is the only place that decides parentage, aggregate token
  totals, model/cost state, and agent lifecycle state.
- A discovered agent appears exactly once. Unmatched agents attach to `ROOT`
  with `inferred: true`; no hidden exclusion list, no quiet omission.
- Parentage must be acyclic and every agent must reach `ROOT`. Start/end times
  must never produce a negative duration.
- Rollups must equal the sum of the per-agent values. Never add the root's own
  totals twice or estimate absent token usage.
- Keep provenance visible where it affects trust (`inferred`, naming source,
  unpriced model). A UI cannot honestly claim precision the parser does not
  possess.
- Agent-node titles are human-readable names of at most four words. Preserve an
  explicit semantic name such as `Reconnaissance Agent`; otherwise derive a
  concise role from the prompt or description. Never promote an entire spawn
  description or prompt sentence into a title. Number only truly identical
  sibling names, and preserve the complete task prompt in detail data.

## Discovery and Watcher

- Discovery scans are metadata-only (`readdir`/`stat`) until a run is selected.
  The sidebar may make one cached, bounded prefix probe of each displayed root
  transcript solely to show the opening-request title; never fully parse every
  historic transcript to populate the sidebar.
- Every filesystem traversal must tolerate races: missing directories, deleted
  files, permissions changes, and partial session directories produce an empty
  or incomplete result, not a server crash.
- Use a cheap fingerprint before rebuilding. Do not parse large sessions every
  polling tick just because the process is alive.
- A watcher also needs a bounded time-based refresh while agents can change from
  running to stalled without a new write. Stop timers, listeners, and SSE work
  on client disconnect; leaks here accumulate while the dashboard is open.

## Cost Accounting

- Keep prices as USD per million tokens and derive cache tiers from documented
  multipliers. Include all recorded token buckets in `total`.
- Rate resolution must select the most specific known model prefix and handle
  short spawn aliases separately from resolved assistant model IDs.
- Price changes are time-bound data. Record the effective boundary in code and
  add a test on each side of it.
- Unknown models return `null`, never `$0`. Synthetic zero-usage records may be
  explicitly free only when their semantics are documented.
- When updating prices, verify against the provider's published pricing before
  changing `MODEL_RATES`; do not infer a price from an old session or a UI
  screenshot.

## HTTP, SSE, and Local Security

- Bind to `127.0.0.1` unless public/network access is an explicit product
  requirement with its own authentication and threat model.
- API responses are JSON with no-store caching. Keep the public surface small:
  sessions, one run, one static-client version, and one-way live updates.
- Decode and validate a session identifier once at the API boundary; resolve it
  only through `findSession`, never by joining arbitrary input into a file path.
- Static serving must remain contained inside `client/`. Test path traversal if
  routing changes; filesystem-derived paths are not friendly just because they
  are local.
- SSE sends only changed graphs, includes a reconnect-friendly retry frame, and
  owns a single cleanup path for heartbeat, watcher, request close, and error.
- Transcript prompts may contain sensitive local text. Do not log raw records,
  prompts, full absolute source paths, or API payloads to stdout/stderr.

## Tests

- Parser and join tests must cover teammate envelopes, duplicate prompts,
  workflow parentage, malformed lines, and unmatched-agent fallback.
- Graph tests must assert: every transcript appears once; parent chains reach
  root; no negative duration; totals reconcile exactly; unknown models are not
  silently priced.
- Tests may use real local sessions as optional smoke fixtures, but must skip
  cleanly if history is absent. Put new deterministic behavior coverage in
  committed synthetic fixtures or direct unit tests.
- Before handoff run `npm test`; for any changed graph behavior, also invoke
  `npm run dump -- <session-prefix>` when a suitable local session exists.
