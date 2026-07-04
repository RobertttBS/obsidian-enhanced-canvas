# G. Letter to Future Sessions — obsidian-enhanced-canvas

Written 2026-07-05 by an Opus-4.8 session (the last Fable-5-era handoff). The
environment-wide letter is `~/.claude/playbooks/letter-to-future-sessions.md` (open
permissions, the vault is personal, instruction-volume is the recurring disease) — read
it too. This one is about *this repo*.

## Three things nobody asked, but you need to know

### 1. This plugin writes into real users' notes — that's the thing to fear
The frontmatter sync doesn't touch a database; it rewrites YAML in people's actual
markdown files, and this is a **published community plugin with real installs**. There
is **no test** that catches a bad write. A broken invariant (wrong key order, a sync
firing mid-import, cleanup skipped when the setting flips off) silently corrupts or
strips links from user notes, and they may not notice for days. So: touching any
frontmatter path is a high-risk change even when the diff is tiny. Trace the four
invariants by hand (architecture.md), reload in Obsidian, and connect/disconnect a real
edge to watch the round-trip before you call it done. When in doubt, get a fresh `opus`
agent to attack it (model-dispatch.md).

### 2. This codebase is deliberately, aggressively minimal — match it, don't "improve" it
`main.ts` is one 1581-line file on purpose, and the last few commits *cut ~380 lines of
over-engineering* (`db8cb24`, `27f52be`, `59c08de`). The maintainer's taste is
ponytail-lazy: no speculative abstraction, no config for constants, reuse over new. If
your instinct says "this should be split into modules" or "let's add an interface here"
— that instinct will get reverted. The right move is the smallest diff that fits the
existing shape. Read `styles.css`/`utils.ts` for the density to match.

### 3. Canvas internals are a reverse-engineered guess, not a contract
`Canvas.d.ts` describes Obsidian's *undocumented* Canvas internals — it's what someone
observed, not a published API. Obsidian updates can change those internals and silently
break a patch. Two implications: (a) prefer official Obsidian API surfaces over Canvas
internals when a choice exists; (b) when a patch "just stopped working", suspect an
Obsidian version change before your own logic, and check whether `Canvas.d.ts` still
matches reality before trusting it.

## How this doc system will most likely rot, and the countermeasure

1. **Docs drift from code.** Line numbers, method names, and the `register*` list go
   stale as `main.ts` changes. → CLAUDE.md's "keeping current" rule + maintenance.md's
   "verify before you fix a reference". Never cite a line number you didn't just grep.
2. **The project docs fatten into copies of the global playbooks.** The whole point is
   that `docs/agent/*` is a *thin delta* — the moment someone pastes universal
   delegation/judgment rules down into the repo, you've rebuilt the instruction-bloat
   the diagnosis warns about. → maintenance.md compaction caps; keep it a delta.
3. **CLAUDE.md and AGENTS.md drift apart.** They're identical today; one-sided edits
   split them and Codex vs Claude start getting different instructions. → mirror every
   edit, `diff` them after.
4. **Sessions stop reading `docs/agent/`.** Routing only works while CLAUDE.md stays
   short enough that the pointers stand out. → don't grow CLAUDE.md; push detail down.
5. **Ritual "VERIFIED".** With no test suite it's tempting to write "VERIFIED: works"
   without reloading Obsidian. That's the most dangerous rot here, because #1 above
   means the failure is silent user-data loss. A VERIFIED line with no command and no
   manual step is a failed check — treat it as such, yours or an agent's.

## Handoff
Nothing unfinished. Seven deliverables written this session: this letter, the diagnosis
(A), the CLAUDE.md rewrite (B) with AGENTS.md synced and architecture.md extracted, and
model-dispatch (C), judgment (D), prompt-templates (E), maintenance (F). All under
`docs/agent/`. Not committed — the repo's git state is otherwise clean.
