# @ding/cli 发布清单

> 这份文件**不进 npm 包**（`files` 白名单里没有它）。它是发布前的检查表与卡点记录。

## 现在能不能发

**不能——但原因只有一个：作用域归属。** 另外「发不发」本身还没拍。

| 项 | 现状 | 下一步 |
|---|---|---|
| **`@ding` 作用域归属（真实卡点）** | `@ding` 这个 npm 作用域属于**另一个真实用户（npm 用户 `ding`）**——与引擎包当初 `@ding/engine*` 完全同一个病。registry 上 `@ding/cli` 是 404，但 **404 ≠ 可发布** | 改到我们能发布的名字（与引擎包同一次改名口径） |
| **npm 认证（不是卡点）** | 本机 `~/.npmrc` 已配 **`sunwenshan`** 的发布令牌（`bypass_2fa=true`、`package:write`、all packages、到期 2027-01-15；`npm whoami` 实测为 `sunwenshan`） | 无需处理 |
| **2FA（不是卡点）** | 账号**没有开** 2FA：profile 页显示 `Enable 2FA` 按钮，首页横幅原文 “You don't have two-factor authentication (2FA) enabled on your account.” | 无 |
| **发布决定（待主人拍）** | `RELEASE.md` 2026-10-16 的决定仍是「主仓 CLI 暂不发 npm」 | 等主人明确「发」或「不发」；在拍之前不改名、不发布 |
| 备选名 | `ding-cli` 已被占（HTTP 200）；`ding-harness` 未被占（404，可作 fallback） | 改名时再定（先等发布决定） |

> ⚠️ 旧令牌 `zcode-cli`（`bypass_2fa=false`，id `f4a245`）不要再用；当前生效的是 `zcode-cli-publish`（id `09bb80`）。

## 发布前检查

```bash
pnpm cli:build          # 产物落在仓库根 dist-cli/
pnpm cli:pkg            # 拷进 packages/cli/dist-cli，并校验 bin/shebang
pnpm cli:pkg:check      # npm pack --dry-run 的守卫（bin 在 files 里、无 src 残留）

cd packages/cli
npm pack --dry-run      # 人眼看一遍文件清单
npm publish --access public
```

## 发布后验证（十条）

> 下面的包名**取决于改名结果**；在发布决定拍板前，这里写的 `@ding/cli` 只是占位。

```bash
npm i -g @ding/cli
ding --version
ding doctor
ding eval --json > /dev/null
ding bench --json --out bench-report.json
```

## 改名清单（**发布决定拍板后**再执行）

`@ding/cli` 只是**占位名**：`@ding` 作用域不属于本账号，发不出去。改名时按这张表走
（与引擎包当初 `@ding/engine*` → `ding-engine*` 同一条口径）：

| 要改的地方 | 说明 |
|---|---|
| `packages/cli/package.json` 的 `name` | 唯一定义处；备选名见上表（`ding-cli` 已被占，`ding-harness` 未占） |
| `README.md` 的 npm 安装行 | `npm i -g <新名>` |
| `RELEASE.md` 第五节 | CLI 包的现状与卡点 |
| `docs-site/zh/getting-started.md`、`docs-site/en/index.md` | 安装命令与「未发布」说明 |
| `packages/cli/PUBLISHING.md` | 本文件（发布后验证那段的占位名） |
| `scripts/verify-cli-package.mjs` | 不写死名字（读 package.json）；改完跑一次 `pnpm cli:pkg:check` |

改名后：`pnpm cli:pkg && pnpm cli:pkg:check`，再 `cd packages/cli && npm pack --dry-run` 看清单。

## 已知边界

- 单二进制那条路（Bun）不在这个包里；它走 GitHub Release 的 `dist-bin/`。
- Windows 安装包（NSIS）与代码签名是另一条线（`RELEASE.md`）；本包不含桌面。
