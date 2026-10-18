# nightly → stable 双轨（E02）

> 纪律写在 [`RELEASE.md`](../RELEASE.md) 第六条；这一页说的是**怎么跑**。

## 两条命令

```bash
# ① 跑七道门，留下证据（不发布、不打 tag、不改版本）
node scripts/nightly-gates.mjs                 # 版本 = 当前 patch+1 的 nightly
node scripts/nightly-gates.mjs --base 0.6.0    # 指定基础版本
# → .verify/nightly-evidence.json

# ② 核对证据并晋升（默认只检查）
node scripts/promote-nightly.mjs --manifest .verify/nightly-evidence.json
node scripts/promote-nightly.mjs --manifest .verify/nightly-evidence.json --write

# ③ 发版前的机械核对（不发布）
pnpm release:check            # 版本一致 / 轨道形状 / CHANGELOG 标题 / 三份产物在
pnpm release:check -- --stable # 断言这是稳定版（不许预发布后缀）
```

`--write` **只改版本号**（`shared/version.json` / `package.json` / `packages/cli/package.json`），
不 commit、不打 tag、不上 npm —— 那三件仍需主人授权（`RELEASE.md` 第五条）。

## 证据里有什么

```json
{
  "version": "0.5.2-nightly.20261018",
  "gitSha": "…40 位…",
  "gates": {
    "pnpm typecheck": { "ok": true, "at": "...", "elapsedMs": 1234, "note": "输出尾部" },
    "…": {}
  },
  "artifacts": [{ "name": "dist-cli", "sha256": "…64 位…" }]
}
```

晋升检查（`shared/release.ts`，有单测）会拒绝：

- 不是 `X.Y.Z-nightly.YYYYMMDD` 形状；
- 任何一道门没记录或 `ok !== true`；
- 证据的 `gitSha` 与当前 HEAD 不一致（"全绿的不是这份代码"）；
- 版本里没有 `gitSha`；
- `artifacts` 给了但摘要不是 64 位十六进制。

## CI 里的 nightly

`.github/workflows/nightly.yml` 每天跑同一份 `nightly-gates.mjs`，把证据与构建产物
作为 workflow artifact 上传。**它不发布**：仓库里没有 npm 令牌，发布也轮不到流水线决定。

**它已经在 GitHub 上真跑过**（2026-10-18，手动触发，run `39139112138`，3 分 20 秒全绿）。
第一次跑是**红的**（14 秒）：action 里写了 `version: 10`，而 `package.json` 已有
`packageManager: pnpm@10.34.1` → "Multiple versions of pnpm specified" 直接退出。
改成与 CI 同一写法后通过 —— 这就是"写了但没跑过"的代价，记在这里。

## 最近一次本机实跑（2026-10-18）

命令：`node scripts/nightly-gates.mjs --out .verify/nightly-evidence.json`

| 门 | 结果 |
|---|---|
| `pnpm typecheck` | 绿 |
| `pnpm lint` | 绿 |
| `pnpm test` | 绿（3467 条） |
| `pnpm eval` | 绿（63/63） |
| `pnpm bench` | 绿（7/7） |
| `pnpm verify:supply-chain` | 绿 |
| `pnpm verify:sdk` | 绿 |

在同一提交（`88efe31`）上跑 `promote-nightly.mjs`（检查模式）：通过，
`0.5.2-nightly.20261018 → 0.5.2`。`--write` 只在**临时副本**上演示过（没有改本仓库版本号）——
这证明链路本身能用；要不要真的晋升下一个版本，是主人的决定。

顺带验到了一条真守卫：中途改过代码之后，拿**上一个提交**的证据去晋升会被拒
（"证据来自另一个提交（722cf03），当前 HEAD 是 …"）—— 这正是它该做的，
而不是"上次全绿了这次也算"。
