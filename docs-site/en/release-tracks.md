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

⚠️ Honest status: the workflow has not run on GitHub yet (local commits are unpushed).
The same script has run locally once — see the Chinese page for the result table.
