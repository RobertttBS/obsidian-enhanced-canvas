# CLAUDE.md

Obsidian plugin (Enhanced Canvas). This file is the always-loaded map + traps.
Deep detail lives in `docs/agent/`; read the relevant one when you're in that code.

> Keep this file short (routing + traps only). Long prose belongs in
> `docs/agent/architecture.md`. Any edit here must be mirrored into `AGENTS.md`
> (they are kept byte-identical for Codex). Update rules: `docs/agent/maintenance.md`.

## Commands

- `npm run dev` — esbuild watch → `main.js` (inline sourcemap). **Default.** Reload
  the plugin in Obsidian to pick up changes.
- `npx tsc --noEmit` — the **only** correctness gate. esbuild ignores type errors,
  so a green `dev` build proves nothing. Run this after edits.
- `npm run build` exists but isn't in the maintainer's flow — don't run unless asked.
- No tests, no lint, no CI. Behavior is only observable by reloading in Obsidian.

## Mental model

- Entry `main.ts` (one large file, every feature) → `main.js`. Features register from
  `onload()` via `register*` methods. Obsidian & CodeMirror are externals — never bundle.
- Canvas internals are reverse-engineered in `Canvas.d.ts`; extend it over `any`.
- Full architecture, module catalog, and the frontmatter-sync mechanics:
  **`docs/agent/architecture.md`**.

## Traps (each has wrecked this repo before — details in architecture.md)

- **Two `node` concepts.** JSON node `node.file` = path **string**; live `CanvasNode`
  `node.file` = **TFile** (`node.filePath` is its string). Same name, different type —
  confirm which you hold before editing anything named `node`. (`main.ts:158-160`)
- **Never hand-roll a patcher retry.** All prototype patches go through
  `registerLazyPatcher`; it detaches its retry listeners on success. Hand-rolling and
  leaving them attached re-patches and broke Windows pinned tabs (commit `742eb70`).
  Register uninstallers with `this.register(...)`.
- **Frontmatter sync writes user notes — 4 invariants, all silent-data-loss if broken:**
  cleanup runs *before* flipping `enableFrontmatter` off; `canvas` key precedes
  per-canvas keys (`ensureCanvasKeyOrder` in every write callback); all edge syncs go
  through the debounced queue (never immediate — mid-import strips valid links); the
  metadata cache only gates *whether* a sync runs, decisions read real frontmatter in
  the callback. Mutation fns early-return when the setting is off.
- **New DOM listener?** Attach per-document (popped-out windows have their own
  `Document`) — follow `registerFocusCanvas`. Workspace events are global and safe.

## Conventions

`any` / `@ts-ignore` are accepted against Canvas internals (ESLint allows it); prefer
extending `Canvas.d.ts` for new code. `randomId` in `utils.ts` over `Math.random()`.

## Working here — agent governance

Universal working rules (delegation, judgment, prompt templates, verification) live in
`~/.claude/playbooks/`. The **project-specific layer** is in `docs/agent/`:

- `diagnosis.md` — what wastes tokens / breaks in *this* repo (read once per new session).
- `model-dispatch.md` — when to delegate here (rarely — small repo) and to which model.
- `judgment.md` — what "done" means here (no tests → tsc + Obsidian reload).
- `prompt-templates.md` — dispatch templates pre-filled with this repo's files.
- `maintenance.md` — how to safely update these docs and CLAUDE.md.
- `letter-to-future-sessions.md` — read if you're a smaller model or new here.

## Keeping this current

When a change alters a `register*` method, a `src/` module, a load-bearing invariant,
a settings key, or a fact stated here or in `docs/agent/architecture.md`, update the
doc in the **same change** (and mirror CLAUDE.md ↔ AGENTS.md). Stale guidance is worse
than none.
