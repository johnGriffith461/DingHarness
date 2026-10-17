# Tutorial: finish your first real task

> This is the shortest path that works. Each step says what you should see —
> if you see something else, check "When it gets stuck" instead of guessing.

## 0. What you need

- A model endpoint (OpenAI-compatible / Anthropic / DeepSeek / a local gateway);
- An **empty scratch directory** as the workspace;
- The desktop app (`pnpm dev`) **or** the CLI (`npm i -g ding-harness`).

## 1. Teach it your model (2 minutes)

Desktop: the first-run wizard walks through provider → key → model + workspace → permission mode.
The key is encrypted by the main process; it never goes into browser storage.

CLI:

```bash
ding init
ding doctor
```

Every `doctor` line tells you the next step. If it says the key is missing, it is missing.

## 2. Pick a task with a checkable artifact

Do not start with "build me a website". Pick something where **done is obvious**:

> Merge the three weekly notes in `notes/` into `summary.md`,
> with three sections: conclusions / numbers / follow-ups.

Before sending, look at the three controls:

| Control | First run | Why |
|---|---|---|
| Workspace | that empty directory | it can only read/write there |
| Permission mode | **Ask when needed** | writes and commands stop and wait for you |
| Model | any working one | this step is not a model benchmark |

CLI equivalent:

```bash
ding run "merge the three weekly notes into summary.md" --dir ./notes-workspace --mode 按需确认
```

## 3. What happens during the turn

1. It reads the files (read-only tools usually do not ask);
2. It stops before writing `summary.md` — the card says which file and what will change;
3. You click Allow. Reject and it must find another way; it must not force it;
4. If you choose "always allow" for a class of actions, that rule is persisted and survives restarts.

The gate is the product promise. If it writes without asking, that is a defect, not "intelligence".

## 4. Verify (do not trust "done")

```bash
ding sessions                 # find the turn
ding review <session-id>      # per-file diff
ding review <session-id> --revert <path>
```

Read the file. If it is wrong, revert it — reverting is part of the design.

## 5. Continue the same work

- Keep talking in the same conversation;
- Branch instead of polluting it: `ding fork <session-id> --at-turn 2 --into try-2`;
- Run after you close the app: `ding run "…" --background`, then `ding jobs`.

## When it gets stuck

| Symptom | Likely cause | Next step |
|---|---|---|
| `doctor` cannot reach the provider | key / baseURL / network | fix the item it names |
| Write rejected | target outside the workspace | point `--dir` at it |
| Stuck at "waiting" | per-step mode or a pending approval | desktop card, or `ding sessions --state <id>` |
| Slow with growing context | compaction triggered | check context pressure in Usage, or fork |

## One hard boundary worth knowing up front

Plugins run **in the same process** as the host in v1. Installing a plugin means running its code
on your machine. `ding plugins install` prints which permissions are actually enforced and which
are declaration-only. "Unsigned" is not "broken"; "signed" is not "safe".
