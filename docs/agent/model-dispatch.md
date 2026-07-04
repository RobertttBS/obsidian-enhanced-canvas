# C. Model Dispatch — project layer

Universal rules: **`~/.claude/playbooks/delegation.md`** (thresholds, model table,
report contract, escalation ladder). Read that first. This file records only how
those rules land in *this* repo, and reconciles them with its reality.

## The principle, and this repo's reality

The commander stays out of the ring: bulk reading, open-ended repo scans, batch
edits, and web research belong to subagents, so the main conversation holds
**conclusions, not raw material**. But delegation is the expensive path (every spawn
re-derives context cold), so it is threshold-gated, not reflexive.

**This repo is tiny** — 9 source files, one of them (`main.ts`, 1581 lines) holding
almost everything. Consequence: most "scans" here are 1–3 grep/Read calls and fall
*below* the delegation threshold. Delegating a `grep main.ts` burns money to feel
rigorous (the letter's "delegation cargo-culting" rot). So in practice:

| Situation | Do it… |
|---|---|
| "Where is X in the code" / grep + read one method | **Inline.** It's 1–3 tool calls. |
| Change one feature in `main.ts` or one `src/*.ts` | **Inline.** Single-file edit. |
| Read `main.js` for any reason | **Never** (diagnosis.md #1) — 284 KB bundle. |
| Web research on Obsidian / Canvas API behavior (>3 pages) | **Delegate** — Research template. |
| Fresh-context verification of a finished change | **Delegate** — always fresh context. |
| A genuinely cross-cutting rename touching many call sites | **Delegate** — but grep first; it's usually <5 sites here. |

Net: in this repo the two dispatches that actually earn their cost are **web
research** and **fresh-context verification**. Everything else is usually inline.

## Models & effort available here (verified 2026-07-05)

Agent tool `model`: `haiku`, `sonnet`, `opus`, `fable`. If a `fable` spawn errors on
this plan, fall back to `opus` — do not retry `fable`. There is **no per-agent effort
param**; effort comes from global `effortLevel` in `~/.claude/settings.json`.
Agent types used here: `Explore` (read-only search), `Plan` (design only),
`general-purpose` (can edit/run).

| Task in this repo | Model | Type |
|---|---|---|
| Repo search (rare — usually inline) | `haiku` | Explore |
| Implement/fix a feature in `main.ts`/`src` | `sonnet` | general-purpose |
| Design a new patcher / debug a Canvas-internals mystery | `opus` | Plan / general-purpose |
| Research Obsidian or Canvas API / changelog | `sonnet` | general-purpose |
| Verify a finished change (fresh eyes) | `sonnet` (`opus` if it touches frontmatter sync) | general-purpose |

## Every dispatch carries three things (delegation.md — restated because it's absolute)

1. **Goal + why** — what to produce and what it feeds. Include the domain constraint
   that applies (e.g. "don't hand-roll the patcher retry — use `registerLazyPatcher`";
   "frontmatter writes must keep the 4 invariants — see architecture.md").
2. **Acceptance** — a check the agent runs before reporting: for code here that is
   `npx tsc --noEmit` clean, plus a stated manual Obsidian step if behavior changed.
3. **Report format** — the contract below.

Pre-filled templates: `docs/agent/prompt-templates.md`.

## Report contract (paste into every dispatch)

- Conclusions + `file:line` only. Never paste file contents; never dump `main.js`.
- Anything >~30 lines → write to the scratchpad dir, return the path.
- End with three lines: `VERIFIED:` (what you ran + output), `NOT VERIFIED:` (what
  you couldn't run — e.g. the Obsidian reload), `SURPRISES:` (or "none").
- On failure: exact error text, everything attempted, current tree state.

## Escalation / demotion (delegation.md ladder — repo notes only)

- `haiku` returns garbage once → redo with `sonnet`, don't debug haiku.
- `sonnet` fails the **same subtask twice** → escalate to `opus` **with the full
  trail** (both attempts, errors verbatim, what was ruled out).
- Once `opus` cracks a pattern (root cause found, first working instance written),
  **demote**: batch-apply with `sonnet`/`haiku`.
- **Max two retry rounds per approach.** After that the approach is wrong — stop and
  re-read `docs/agent/judgment.md` §4 (wrong-direction signals). In this repo, "about
  to modify `Canvas.d.ts` or a type to make my change fit" is a classic such signal.

## Verification is never self-verification

The one who wrote the code doesn't get the last word. Because this repo has **no
tests**, verification means: (a) code → `npx tsc --noEmit` re-run fresh + the manual
Obsidian step actually done or explicitly flagged as not done; (b) files/docs →
read-back; (c) high-risk frontmatter-sync changes → a fresh `opus` agent attacks the
result, since a wrong sync silently corrupts user notes. Fresh context matters: the
agent that watched the work inherits its blind spots.
