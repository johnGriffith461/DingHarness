# Ding Harness

**A local-first desktop agent workbench.** One kernel, two hosts (desktop + CLI),
the same approval gates on both.

> This English section is the **minimum line** of the bilingual docs site.
> The full documentation is currently in Chinese; see the language switch.

## What it is

- **Local data sovereignty**: sessions, memory, artifacts and usage ledgers live on
  your machine. Networking only happens where *you* configure it.
- **Event-sourced core**: every turn is an append-only event log; `fold`/`replay`/`fork`
  are derived from one reducer. Restart recovery, replay and time-travel are the
  same mechanism.
- **Two-axis permissions**: tool axis (run / ask / hide) × person axis
  (owner / admin / specialist / viewer). A viewer's write is denied even under
  "allow everything".
- **Honest boundaries**: no fabricated numbers. See `BENCHMARKS.md` for what has
  actually been measured, and what has not.

## Install (when published)

```bash
npm i -g @ding/cli     # placeholder name: @ding scope belongs to another npm user
ding doctor
ding init
ding run "summarize ./docs into memo.md" --dir ./docs
```

The CLI package is built and verified but **not published yet**. The blocker is
**scope ownership**, not 2FA: the `@ding` npm scope belongs to another real user
(the same problem the engine packages had). Whether to publish at all is still a
pending owner decision.
Desktop builds are Windows-first; see the platform table in the Chinese README.

## What is not done

- No mobile client.
- No built-in RAG knowledge base yet (roadmap).
- `run_command` has a resource cap on Windows only; it is not a security sandbox.
- Plugin permissions beyond `tools:register` / `hooks:register` are declarations,
  not enforcement (v1).

Read `SECURITY.md` and `PRIVACY.md` before deploying this for a team.
