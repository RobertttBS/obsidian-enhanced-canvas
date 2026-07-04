# F. Maintenance Protocol — project docs

How future sessions (any model) update `CLAUDE.md`, `AGENTS.md`, and the
`docs/agent/*` files safely. The universal `~/.claude/` maintenance rules are in
`~/.claude/playbooks/maintenance.md`; this covers only the *project* docs.

## Golden rules
1. **CLAUDE.md ↔ AGENTS.md stay byte-identical.** They currently are. Any edit to one
   is mirrored to the other in the **same change** (Codex reads AGENTS.md, Claude reads
   CLAUDE.md). Never let them drift. Verify with `diff AGENTS.md CLAUDE.md` after.
2. **CLAUDE.md stays short** — routing + traps only. If you're adding more than a line
   or two of explanation, it belongs in `docs/agent/architecture.md`; link to it.
3. **Append before rewrite.** Prefer adding a LESSONS entry (below) over rewording an
   existing rule — rewrites lose nuance the rewriter can't see.
4. **One doc change per session** unless the user asked for a broader pass.

## What you may change WITHOUT asking
- Append to the LESSONS section at the bottom of this file.
- Fix a factually wrong path / command / method name / line-number reference in any
  `docs/agent/*` file — but **verify the correct value first** (run the command, grep
  the code) and cite what you ran in the LESSONS entry.
- Update CLAUDE.md / architecture.md when *your own code change* added, removed, or
  renamed a `register*` method, a `src/` module, a settings key, or a load-bearing
  invariant — CLAUDE.md's own "Keeping this current" rule requires it, same change.
- Update a "verified <date>" fact after re-verifying it.

## What REQUIRES the user's approval first
- Deleting or rewording a **rule/invariant** in CLAUDE.md or any `docs/agent/*` file
  (appending a dated exception is fine; deleting the rule is not).
- Restructuring the docs (renaming files, changing what's extracted where, making
  AGENTS.md a pointer instead of a copy).
- Anything that changes the release process, the build commands, or settings behavior.
- Committing or pushing these docs (they are not committed by default).

## Where lessons go
Hit a real pitfall here (a doc said something that was wrong, an invariant you didn't
know bit you, a Canvas-internals surprise)? Append below:
```
### YYYY-MM-DD — <one-line title>
What happened: <2 lines max>
Rule to remember: <1 line, imperative>
Evidence: <command run / file:line / error text>
```
Do NOT log: generic coding lessons, one-off trivia, anything already in a doc.

## Compaction
When LESSONS exceeds ~12 entries or any `docs/agent/*` file grows past ~150 lines:
propose a compaction to the user (merge duplicates, promote a stable lesson into the
relevant rule, delete superseded ones). Compaction deletes history, so it always needs
approval.

---

## LESSONS

### 2026-07-05 — Docs created
What happened: An Opus-4.8 session built this project governance layer (diagnosis,
CLAUDE.md rewrite + AGENTS.md sync, model-dispatch, judgment, prompt-templates, this
file, letter). The six `docs/agent/*` files are thin project layers over the universal
`~/.claude/playbooks/*`; CLAUDE.md's long architecture prose was extracted to
`docs/agent/architecture.md`.
Rule to remember: keep the project docs a *delta* over the global playbooks — don't
copy universal rules down into the repo; that's the instruction-bloat these docs warn
against.
Evidence: `~/.claude/playbooks/` (six universal files, dated 2026-07-03); this repo's
`docs/agent/`.
