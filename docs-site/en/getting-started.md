# Getting started (10 minutes)

Goal: **clean machine → installed → one model configured → first turn completed.**

## From source

```bash
git clone https://github.com/johnGriffith461/DingHarness.git
cd DingHarness
pnpm install
pnpm ding init            # provider / model / workspace (asks for your key)
pnpm ding doctor          # self-check; every failure names the next step
pnpm ding run "summarize the markdown in demo/" --dir ./demo
```

## From npm

```bash
npm i -g ding-harness
ding doctor
ding init
ding run "…" --dir ./your-dir
```

Verified on a clean machine (2026-10-18): empty npm cache and prefix, `ding-harness@0.6.0`,
`ding --version` = `0.6.0`, `ding eval` = **63/63**. Re-run it yourself with
`node scripts/verify-clean-install.mjs` (needs network, so it is not part of `pnpm verify`).

⚠️ **CLI keys are plaintext** (`~/.dsh/.credentials.yaml`, under `refs:`). The CLI has no OS
keychain integration and says so. To reduce plaintext exposure, use environment variables or
enter the key in the desktop app (it uses the OS-encrypted store).

## What the first turn should look like

- Toolbar: model, permission mode (allow all / ask when needed / ask every step), workspace;
- Under "ask when needed", writes and commands **stop and wait for you** — the gate is real;
- `ding sessions` lists that turn; `ding sessions --cost` shows usage;
- Desktop: the same turn appears in the task list with per-file review and revert.

## Where to go next

- Tutorial: finishing one real task — [`tutorial.md`](tutorial.md)
- Stuck? — [`troubleshooting.md`](troubleshooting.md)
- Honest boundaries — [`../zh/honesty.md`](../zh/honesty.md) (Chinese; the English summary lives in
  the repository `SAFETY.md`)
