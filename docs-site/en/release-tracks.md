# Stable / nightly tracks (E02)

> Policy lives in [`RELEASE.md`](../RELEASE.md) §6. This page is the how-to.

```bash
node scripts/nightly-gates.mjs                    # run the seven gates, write evidence
node scripts/promote-nightly.mjs --manifest .verify/nightly-evidence.json          # check only
node scripts/promote-nightly.mjs --manifest .verify/nightly-evidence.json --write  # bump versions
```

`--write` only rewrites version files. It never commits, tags, or publishes — those still
require the owner's authorization (`RELEASE.md` §5).

The promotion check (unit-tested in `shared/release.test.ts`) refuses when:

- the version is not `X.Y.Z-nightly.YYYYMMDD`;
- any gate is missing or not `ok: true`;
- the evidence's `gitSha` differs from HEAD;
- `gitSha` is absent;
- artifact digests are malformed.

`.github/workflows/nightly.yml` runs the same script daily and uploads the evidence +
build output as artifacts. It does **not** publish: no npm token lives in the repo.

**It has now run on GitHub** (2026-10-18, `workflow_dispatch`, run `39139112138`, green in 3m20s).
The first attempt failed in 14 seconds: the action pinned `version: 10` while `package.json`
already declares `packageManager: pnpm@10.34.1` → "Multiple versions of pnpm specified".
Fixed by matching the CI workflow.

## Cross-platform status (2026-10-18)

Source-level gates have been run for real on **Linux** (WSL Ubuntu, Node 22):
typecheck, lint, the full unit suite (309 files / 3497 tests, 6 Windows-only skipped),
`pnpm eval` (63/63) and `pnpm bench` (7/7).
CI now includes an `ubuntu-latest` job.

**macOS has also been run on a real machine** (2026-10-18, MacPortable VM / macOS 26.7.1 /
Node 22.14 / x64): typecheck and lint green, full unit suite **3495 passed / 18 skipped /
0 failed** (the skips are 11 git-dependent cases — that VM has no Xcode command line tools
so `/usr/bin/git` is a stub — plus the legacy-DB migration case, since Node on macOS ships
without FTS5), `eval` **63/63**. No macOS desktop build has been launched, and there is no
macOS CI job yet because the runner image would need a real macOS runner.
