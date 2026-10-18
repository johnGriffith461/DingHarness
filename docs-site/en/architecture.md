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
- SWE-bench: 50-instance stratified sample graded by the **official harness** —
  **31/50 resolved (62%)**, with all 11 unresolved cases having their patch
  successfully applied (genuine model failures, not harness errors).
  This is an **external validity check and cost profile, not a score** — we do not
  rank against the leaderboard (it can no longer order its top entries; see
  `BENCHMARKS.md` §5.0), and we treat it as evidence that the loop runs on
  unfamiliar repositories, not as a capability claim.

See `BENCHMARKS.md` for the exact methodology and failure taxonomy.
