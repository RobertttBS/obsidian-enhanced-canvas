# D. Judgment Rubrics — project layer

Universal rubrics: **`~/.claude/playbooks/judgment.md`**. This file re-grounds each
one in *this* repo, where the defining fact is: **there are no tests**, so the usual
"run the suite" shortcut for "done" does not exist. Every rule below has a ✅ (do it)
and a ❌ (don't) drawn from real situations here.

## 1. When it is actually done

Done here = **`npx tsc --noEmit` is clean, run after your last edit**, AND either you
reloaded the plugin in Obsidian and exercised the feature, OR you stated plainly that
you couldn't and what's therefore unverified. "It compiles" ≠ "it works": esbuild and
even tsc pass on logic that's wrong at runtime.
- ✅ YES: "Ran `npx tsc --noEmit`: clean. Reloaded in Obsidian, connected two nodes
  with an edge, confirmed the linked note gained the `canvas` property and the
  per-canvas key, in that order."
- ❌ NO: "The frontmatter logic looks correct and handles the edge cases." — a
  prediction. With no test, an unrun prediction is worth nothing.
- If you truly can't reach Obsidian: say "tsc clean; NOT verified in Obsidian —
  needs a manual reload + edge-connect to confirm the sync." Never imply otherwise.

## 2. When to escalate to a stronger model

Escalate when the problem is *why*, not *what* — you have the facts but can't explain
them, or two fixes surprised you by failing.
- ✅ YES: "The patch works in the main window but not the popped-out one, and my two
  guesses about `activeDocument` were both wrong." → escalate to `opus` with the trail.
- ❌ NO: "grep didn't find the method." → a search problem; the file is `main.ts`,
  grep the method map (diagnosis.md #2), don't escalate.

## 3. When to stop and ask the user

Ask only when interpretations **fork the deliverable** AND a wrong pick is **expensive
to undo**. Both. Plus always-ask safety cases: destroying something you didn't create,
or outward-facing actions (push, publish, release).
- ✅ YES: "Change the frontmatter property naming scheme" — this rewrites keys in every
  user note irreversibly and there are two plausible schemes. Fork + expensive + touches
  user data → ask.
- ❌ NO: "Add a setting for node default size" without a default value named — pick a
  sensible one matching existing settings, say "defaulted to 250×60 to match Canvas's
  own default", continue.
- Release-specific: **never bump `manifest.json` / commit / push a release on your own
  initiative.** That's outward-facing — ask.

## 4. Wrong-direction signals (switch path, don't retry)

Stop and change approach — not parameters — when:
- The same class of error survives two *different* fixes.
- Each fix creates a new failure elsewhere (whack-a-mole).
- **You're about to edit `Canvas.d.ts`, a type, or Obsidian's own behavior to make
  your change fit.** In this repo that almost always means you're fighting the Canvas
  API, not extending it — zoom out.
- You catch yourself hand-rolling the patcher retry "just this once" instead of using
  `registerLazyPatcher`.
- ✅ YES: patched the edge-sync twice for two orderings of events, a third ordering
  breaks it → stop; the sync needs to go through the debounce queue, not more guards.
- ❌ NO: a fix failed once because of a typo in the fix. Correct the typo; that's not a
  direction signal.

## 5. Quality floor (before declaring any code change complete)

Every "no" must be deliberate and stated:
1. `npx tsc --noEmit` clean, run fresh after the last edit? (§1)
2. Diff contains ONLY lines traceable to the request? (No opportunistic reformat — this
   repo just cut ~380 lines of over-engineering; don't re-add it.)
3. Grepped `main.ts` for other callers of anything you changed? (One giant file — a
   helper often has several callers a few hundred lines apart.)
4. Does something already in `utils.ts`/`main.ts` do this? Reuse beats new.
5. Touched a frontmatter write path? Are all four invariants still held
   (order / debounce / cache-as-gate / cleanup-before-flip)? A miss here silently
   corrupts user notes — this is below-floor, not a nice-to-have.
6. Tree still builds (`npm run dev` starts clean)?
- ✅ YES floor-pass: bugfix in `writeLinkSet` + grepped its 3 callers, all compatible +
  tsc clean + reloaded and confirmed a note's links round-trip.
- ❌ NO floor-fail: "fixed the sync path the report named" while the sibling edge-add
  path still writes keys in the wrong order.

## 6. What these rubrics can't fix

Checklists recover execution, not taste. UX of a new command, naming a user-facing
setting, "should this feature exist at all" — no runnable check, experts disagree.
Then: don't present one answer; produce 2–3 real candidates with one-line tradeoffs;
get an `opus` fresh-context second opinion or hand the candidates to the user. If even
framing candidates is beyond you, say so — that sentence beats a confident guess.
