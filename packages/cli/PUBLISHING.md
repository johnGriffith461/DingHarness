# @ding/cli 发布清单

> 这份文件**不进 npm 包**（`files` 白名单里没有它）。它是发布前的检查表与卡点记录。

## 现在能不能发

**不能。** 卡点如实记在这里（别在别处写"已发布"）：

| 卡点 | 现状 | 解法（要人做） |
|---|---|---|
| npm 认证 / 2FA | automation token 已取消；本机没有可用的发布凭据 | 在 npm 账号上创建 **granular token 并勾选 Bypass 2FA**，或人工 `npm publish` 时输 OTP |
| `@ding` 作用域归属 | registry 上 `@ding/cli` 是 404，但**404 ≠ 可发布**：作用域要先由账号/组织创建 | 用要发布的账号 `npm whoami` + 先发一个占位包验证；若作用域不属于我们，改用备选名 |
| 备选名 | `ding-cli` 已被占（HTTP 200）；`ding-harness` 未被占（404，可作 fallback） | 真要改名前先改 `packages/cli/package.json` 的 `name` 与 README |

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

```bash
npm i -g @ding/cli
ding --version
ding doctor
ding eval --json > /dev/null
ding bench --json --out bench-report.json
```

## 已知边界

- 单二进制那条路（Bun）不在这个包里；它走 GitHub Release 的 `dist-bin/`。
- Windows 安装包（NSIS）与代码签名是另一条线（`RELEASE.md`）；本包不含桌面。
