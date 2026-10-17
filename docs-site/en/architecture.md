# Architecture (short)

| Layer | Directory | Rule |
|---|---|---|
| Kernel | `engine/` | Pure logic: no Electron, no global paths. Fully unit-testable |
| Hosts | `hosts/` (CLI / server / ACP / MCP), `electron/` (desktop) | Assemble ports; **one assembly per capability** |
| Contract | `shared/` | Cross-process types and vocabularies; never imports the kernel |
| UI | `src/` | React; every IPC goes through `ShellBridge` and `preload` is pinned with `satisfies` |

## Event sourcing

`applyEvent` is the only reducer. `fold` → `resume` → `splitTurns` → `fork` are all
derived from it. Snapshots and replay compare **projections**, not bytes: `seq` and
`requestId` are storage details; what the user saw must be identical.

This is why "time travel" and "never-forget sessions" are not separate features:
the log is the source of truth, and an index is just a baton for the next request.

## Context management (ICM)

At the compaction threshold the manager decides between:

- `compact` — summarize older history (one model call, has a cost);
- `fork_index` — build an index from **facts already in the event log** (zero model
  calls) and keep live execution state intact.

Live state wins: pending tools, open todos, failed tools, or a "done" claim that
contradicts the evidence all force `fork_index`. Ten compactions later the goal is
still byte-identical in the carried index (there is a regression test for it).

## Verified claims

- `ding eval`: 63 process-regression cases, deterministic, no API spend.
- `ding bench`: 7 task-level cases grading files and commands, no API spend.
- SWE-bench: adapter only; **no published score** (official harness grading is required).

See `BENCHMARKS.md` for the exact methodology and failure taxonomy.
