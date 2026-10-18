# Troubleshooting

> Read what the product says first: `ding doctor`, approval cards and tool trace lines are
> written for humans. Guessing before reading wastes a turn.

## Startup

| Symptom | Check | Next |
|---|---|---|
| Blank window / no window | error in the `pnpm dev` terminal | run `pnpm electron:build`; for packaged builds verify the install is complete |
| `pnpm start` says artifacts are stale | source newer than build | `pnpm build` (or web + electron builds) |
| `ECONNREFUSED` on the debug port | a leftover instance | kill it; pick another port |
| CLI: unknown subcommand | typo / wrong version | `ding --help`; `ding --version` |

## Model & credentials

| Symptom | Cause | Next |
|---|---|---|
| `doctor` cannot read any key | nothing configured / wrong YAML section | `ding init`; a hand-written key must sit **one level under** `refs:` |
| Key configured but still "missing" | neither env nor credentials file hit | `--provider <other>`; `ding providers list` shows each `keyRef` |
| `DSH_NO_REAL_MODEL` blocks a remote call | zero-network gate is on | intended: run against a local fake service, or unset it explicitly |
| Desktop key disappears after restart | OS encryption unavailable | the desktop refuses to write plaintext and says why; see doctor's credential line |

## Tools & permissions

| Symptom | Cause | Next |
|---|---|---|
| Write rejected | target outside the workspace | pass `--dir`; authorize the folder in the desktop |
| Stuck on "waiting for confirmation" | per-step mode / pending approval | approval card; `ding sessions --state <id>` |
| "Always allow" still asks next turn | old build missed the wiring (fixed) | upgrade; rules are listed under Settings → General |
| Sub-agent reported "blocked" | sub-agents cannot approve inline | the parent step shows a pending row (G11) — approve it there |
| Plugin call times out | plugin hung / over 30s | check the isolation level in `ding plugins list`; hangs are terminated |

## Context & cost

| Symptom | Cause | Next |
|---|---|---|
| Slow turn, context growing | compaction triggered | context pressure in Usage; fork a new branch |
| Cost higher than expected | low cache hit / expensive model | `ding sessions --cost --by model` |
| It "forgot" an earlier constraint | compaction dropped detail | put constraints in long-term memory, or fork earlier |

## Recovery & data

| Symptom | Cause | Next |
|---|---|---|
| A turn vanished after a crash | unfinished run | `ding resume`; `--continue` re-runs it |
| Want a previous state | — | `ding tree`; `ding fork <id> --at-turn N` |
| Want to undo one file | — | `ding review <id> --revert <path>` (overwrites are honestly not recoverable) |
| Moving machines | — | `ding export` / `ding import` (no secrets); `ding backup` for everything |

## Still stuck

1. Keep `ding doctor --json`;
2. Desktop: Settings → About → export diagnostics (redacted; read it before sharing);
3. File an issue using `.github/ISSUE_TEMPLATE/bug_report.yml` — a reproducible path beats "it broke".
