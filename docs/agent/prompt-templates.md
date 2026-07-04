# E. Dispatch Prompt Templates — project layer

Full skeletons + the report-contract block: **`~/.claude/playbooks/prompt-templates.md`**.
These are the same five shapes **pre-filled for this repo** — copy, fill the `{SLOTS}`,
delete optional lines. Per `model-dispatch.md`, in this small repo only **Research** and
**Review/verify** usually clear the delegation threshold; the other three are here for
the rare cross-cutting case. Every prompt ends with the contract block (below).

**Contract block — append to every dispatch:**
```
REPORT BACK (contract):
- Conclusions + file:line only. Never paste file contents. NEVER open or paste main.js (284KB bundle).
- Anything >~30 lines → write to the scratchpad dir, return the path.
- End with: VERIFIED: <cmd + output>. NOT VERIFIED: <e.g. the Obsidian reload>. SURPRISES: <or "none">.
- On failure: exact error, everything attempted, current tree state. No vague summaries.
```

## 1. Search — model: haiku, type: Explore
```
GOAL: Find {WHAT} in this repo (obsidian-enhanced-canvas).
WHY: I'll use it to {MOTIVATION}.
KNOWN ALREADY: main.ts is one 1581-line file; method map via
  grep -nE "register[A-Z]\w*\(|syncAllCanvasProperties|ensureCanvasKeyOrder" main.ts.
  src/ has 8 small modules. Do not read main.js.
ACCEPTANCE: every "X is/isn't here" backed by a file:line you opened, or the exact
  search that came up empty.
REPORT BACK: each hit as file:line + one sentence. {+ contract block}
```

## 2. Implementation (feature / bugfix) — model: sonnet, type: general-purpose
```
GOAL: {WHAT} in {main.ts / src/<file>}.
WHY: {USER-VISIBLE MOTIVATION}.
CONSTRAINTS: Follow CLAUDE.md and docs/agent/architecture.md. Minimum diff; touch only
  what the goal needs (this repo just removed ~380 lines of over-engineering — don't
  re-add). DOMAIN RULES that apply: {pick as relevant}
    - prototype patches go through registerLazyPatcher, never a hand-rolled retry;
    - frontmatter writes must hold all 4 invariants (order/debounce/cache-gate/cleanup);
    - new DOM listeners attach per-document like registerFocusCanvas.
ACCEPTANCE (run before reporting):
  1. npx tsc --noEmit → clean.
  2. npm run dev starts without error.
  3. State the manual Obsidian step needed to confirm behavior (you can't run it).
REPORT BACK: files changed, one line each; tsc output; the manual step to verify. {+ contract}
```

## 3. Refactor / batch change — model: haiku if pattern proven else sonnet, type: general-purpose
```
GOAL: Apply exactly this transform: {BEFORE → AFTER, real example from the code}.
SCOPE: {file list / the grep that enumerates sites}. Nothing outside it.
WHY: {MOTIVATION}. BEHAVIOR MUST NOT CHANGE.
If a site doesn't fit cleanly, SKIP and list it — don't improvise a variant.
ACCEPTANCE: npx tsc --noEmit clean after ALL edits; skipped-sites list produced.
REPORT BACK: count changed, skipped sites + one-line reasons, tsc output. {+ contract}
```

## 4. Research (Obsidian / Canvas API) — model: sonnet, type: general-purpose
```
GOAL: Answer, numbered: {QUESTIONS about Obsidian API / Canvas internals / a plugin behavior}.
WHY: {DECISION this feeds, e.g. "whether to patch onResize or listen for an event"}.
SOURCES: prefer the official Obsidian API docs / typings and changelogs; note the
  version. Canvas internals are undocumented — mark anything inferred from behavior as
  inferred, not documented. Cross-check against our Canvas.d.ts.
ACCEPTANCE: each answer cites a source URL; "documented" vs "inferred" distinguished;
  unanswerable questions reported as such with where you looked.
REPORT BACK: numbered answers matching my questions + source each. {+ contract}
```

## 5. Review / verify (fresh context, ALWAYS) — model: sonnet, opus if frontmatter-sync, type: general-purpose
```
GOAL: Adversarially review {diff / files at PATHS}. Assume ≥1 real problem; hunt it.
CONTEXT: it should {INTENDED BEHAVIOR}. Produced to satisfy: {ORIGINAL ACCEPTANCE}.
CHECK SPECIFICALLY:
  1. Re-run npx tsc --noEmit yourself → clean?
  2. If it touches frontmatter sync: are all 4 invariants held? Trace one edge add and
     one setting-toggle-off by hand; a wrong sync silently corrupts user notes.
  3. If it touches a patcher: does it use registerLazyPatcher and register its
     uninstaller? Any hand-rolled retry that leaves listeners attached?
  4. What would a user hit first if this is wrong?
ACCEPTANCE: every problem has file:line + a concrete failure scenario; every criterion
  gets explicit PASS/FAIL, none skipped.
REPORT BACK: verdict per criterion, then findings by severity. "No findings" only with
  the list of checks that came up clean. {+ contract}
```
