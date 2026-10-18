# Ding Harness

> A local-first desktop agent workbench: AI workspace + infinite canvas.

Ding Harness is an Electron desktop app that puts a conversational agent and an infinite
canvas in one workbench. It runs locally, stores data locally, and talks to the model
providers **you** configure (OpenAI-compatible, Anthropic, or Google protocols) — there is
no backend service.

> Status: **v0.6.0**. Windows builds only at the moment.

## Features

- **Agent tool surface**: file read/write/edit, directory listing, search, command
  execution, sub-agents, plus connectors (MCP over stdio **and** streamable HTTP).
- **Approval gates**: three modes (allow all / ask before writes / ask every step). Every
  tool call is classified, and risky shell commands are flagged even in "allow all" mode.
- **Tool output spill**: oversized results are written to a session-private file and the
  model gets a preview plus a path it can page through with `read_file`.
- **Context budget**: history is sized from the model's window (`W − output reserve − buffer`),
  with explicit `long` / `balanced` / `economy` modes. Not a fixed 20k cap.
- **Crash recovery**: a persisted run state machine (`running` / `waiting_for_confirmation` /
  `paused` / …) so an interrupted turn is reported as such instead of spinning forever.
- **Cost ledger**: provider-reported usage only, with cache read/write pricing when the
  provider gives the details.
- **Browser agent**: snapshot the page into compact, stable element refs, then click / type /
  scroll / screenshot — localhost by default, external URLs need explicit approval.
- **Element-based computer use** (Windows): enumerate windows and UI Automation elements and
  invoke them by index — no pixel guessing, and no focus stealing.
- **Change review**: `ding review <session>` shows a per-file diff of what the agent changed
  and can roll back files it can prove (edits and newly created files).

## Quick start

```bash
# CLI
npm i -g ding-harness
ding init          # interactive: provider → key → model → workspace
ding doctor        # self-check: tells you what is missing and what to do next
ding run "list the files in this directory and summarize them"
```

Desktop: run the installer, or from source:

```bash
pnpm install
pnpm dev           # Vite + Electron in one command
```

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm eval          # 63 offline regression cases (no model calls)
pnpm bench         # 7 task-level benchmarks (judges artifacts)
pnpm verify        # gates + build freshness + CLI artifact + smoke test
```

Real model calls are gated behind `DSH_NO_REAL_MODEL=1` and explicit flags; nothing in the
test suite spends money.

## Architecture

**Kernel + hosts**: the agent logic lives in `engine/` (pure, unit-testable), and the
desktop app (`electron/` + `src/`) and the CLI (`hosts/cli/`) are just hosts around it.
Event sourcing is the foundation: `applyEvent` is the only reducer, and projections,
resume, fork and replay all derive from it.

See [`README.md`](README.md) (Chinese, more detailed), [`SAFETY.md`](SAFETY.md) for the
security boundaries (what is *not* sandboxed), and [`BENCHMARKS.md`](BENCHMARKS.md) for what
the published numbers actually measure.

## License

Apache-2.0.
