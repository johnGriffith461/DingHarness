# `ding-harness` 发布清单（CLI）

> 这份文件**不进 npm 包**（`files` 白名单里没有它）。它是发布前的检查表与事实记录。

## 包名与版本

| 项 | 值 | 说明 |
|---|---|---|
| 发布状态 | **已发布 `0.5.1`（2026-10-18）** | registry `latest` = `0.5.1`；干净安装后 `--version` / `doctor` / DOCX 入库 / `eval` 都验过。`0.5.0` 已弃用（缺 `jszip`） |
| 包名 | **`ding-harness`** | 不带作用域。`@ding` 作用域属于另一个真实 npm 用户（与引擎包当初同一个病），**404 ≠ 可发布** |
| 版本 | **`0.5.1`** | 与根 `package.json` / `PRODUCT_VERSION` / `shared/version.json` **同一份**（D09，2026-10-18）；`ding --version` 优先读**安装包自己**的 `package.json`，所以装的是哪版就报哪版 |
| npm 账号 | `sunwenshan` | `~/.npmrc` 里的发布令牌：`bypass_2fa=true`、`package:write`、all packages、到期 2027-01-15（`zcode-cli-publish`，id `09bb80`） |
| 2FA | **未开** | 不是卡点：profile 显示 `Enable 2FA`，首页横幅也写明未启用。旧令牌 `zcode-cli`（`bypass_2fa=false`，id `f4a245`）不要再用于发布 |

## 发布

```bash
pnpm cli:build          # 产物落在仓库根 dist-cli/
pnpm cli:pkg            # 拷进 packages/cli/dist-cli，并校验 bin/shebang
pnpm cli:pkg:check      # 包清单守卫（bin 在 files 里、无 src 残留）

cd packages/cli
npm pack --dry-run      # 人眼看一遍文件清单
npm publish             # 未带作用域，默认 public
```

## 已完成的发布证据（2026-10-18）

- `0.5.0`：首次发布（tarball 535.5 kB / 188 files，shasum `488fd018…`）。
- **`0.5.0` 有一个真缺陷**：`packages/cli` 的依赖清单漏了 `jszip` ——
  从 npm 装出来的 CLI 跑 `ding knowledge add *.docx` 会失败。
  供给链守卫（`pnpm verify:supply-chain`）在发布后当场逮到，按补丁版 `0.5.1` 修掉。
- **`0.5.1`**：补 `jszip@3.10.2`；`npm publish` 后 `latest` = `0.5.1`。
- `npm deprecate ding-harness@0.5.0 "缺少 jszip 依赖：ding knowledge add 的 DOCX 入库会失败；请用 0.5.1"`。
- **从 registry 干净安装 `0.5.1`**（临时 prefix，不碰本机全局）：
  `--version` → `0.5.1`；`doctor` → 10 项全通过；DOCX 入库 + 检索命中；
  `eval --json` → 63/63。
- ⚠️ `npm view ding-harness versions` 里会看到一个 `0.0.0-stage`：那是 npm 的
  **staged publishing** 处理窗口留下的占位（引擎包当初也一样），`latest` 指向 0.5.1。

## 发布后验证（干净安装）

```bash
# 临时前缀装一份，避免污染本机全局
npm i --prefix /tmp/ding-install ding-harness@0.5.1
/tmp/ding-install/node_modules/.bin/ding --version
/tmp/ding-install/node_modules/.bin/ding --help
DH_DATA_DIR=/tmp/ding-data /tmp/ding-install/node_modules/.bin/ding doctor
```

## 历史：为什么叫 `ding-harness`

最初写的是 `@ding/cli`。但 `@ding` 是**另一个真实用户的作用域**，发不出去 ——
与引擎包 `@ding/engine*` → `ding-engine*` 是同一条处置：**改到能发布的名字**。
备选名实测：`ding-cli` 已被占（200）；`ding-harness` 未占（404，采用）。

## 已知边界

- 单二进制那条路（Bun）不在这个包里；它走 GitHub Release 的 `dist-bin/`。
- Windows 安装包（NSIS）与代码签名是另一条线（`RELEASE.md`）；本包不含桌面。
- npm 包里是 `dist-cli/`（CommonJS）+ 依赖清单；运行时需要 Node ≥22.5。
