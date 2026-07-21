# Commit Changes

Use this workflow to prepare small, reviewable Agent Map commits.

## 1. Gather Context

Run:

```bash
git status --porcelain
git branch --show-current
git log --oneline -5
```

Read the relevant rulefiles before grouping changes. Treat pre-existing dirty
files as user work until their ownership and purpose are clear.

## 2. Group Changes

Prefer a few coherent commits over arbitrary file-count batches. This project
normally splits work along these lines:

- `feat:` graph/discovery/transcript engine and its tests;
- `feat:` loopback server, CLI, or dashboard behavior;
- `docs:` README and engineering-rule updates;
- `fix:` a verified defect;
- `test:` test-only coverage.

Keep implementation and the tests that prove it together. Do not mix a visual
redesign with parser changes merely because both are currently untracked.

## 3. Review Gate

Before each functional commit:

1. Inspect the staged diff for correctness, scope, unsafe filesystem/network
   behavior, and broken contracts.
2. Run `git diff --check` and `npm test`.
3. For changed graph behavior, run the headless CLI against a known local
   session when available. For client changes, inspect the local app at desktop
   and a narrow viewport, and check browser-console errors.
4. Fix confirmed findings and rerun the affected verification. If a dedicated
   code-review skill is available, use it; otherwise perform and report this
   deterministic manual gate.

## 4. Commit Format

There is no ticket prefix in this repository. Use a conventional-commit
subject, imperative mood, no period, maximum 50 characters:

```text
feat: add transcript graph engine

- Parse root, subagent, and workflow transcript files
- Reconstruct parentage without dropping unmatched agents
- Cover graph invariants with Node tests
```

Every commit needs a body with 2-7 bullets describing what changed. The body is
not filler; it is the future investigator's fastest route through the history.

## 5. Execute and Verify

Commit only when the user explicitly asks to commit or has approved the exact
commit plan. Execute one batch at a time, then verify it with:

```bash
git log --oneline -3
git status --short
```

Never force-push. Do not include unrelated user changes in a batch.
