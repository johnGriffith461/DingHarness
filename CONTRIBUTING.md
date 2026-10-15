# 参与开发

先看 [`SAFETY.md`](./SAFETY.md) —— 那份文档里写清了"什么隔离了、什么没有"，
本项目对"如实"的要求比一般项目高：**承诺与代码对不上就是缺陷**。

## 环境

- Node 24+（`.nvmrc` / CI 都是 24）、pnpm 10（`packageManager` 字段钉的版本）
- Windows 上开发体验最完整（桌面端、打包、验收脚本都在这个平台上验过）
- 可选：Rust（编命令沙箱 `pnpm sandbox:build`）
- 可选：Bun（编 CLI 单二进制 `pnpm cli:bin`）

```bash
pnpm install
pnpm dev:web          # 终端 1：Vite（http://localhost:5173）
pnpm electron:dev     # 终端 2：编译主进程并起 Electron
```

## 提交前必须过的四道门

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval
```

- `typecheck` / `lint` / `test`：常规门。
- **`pnpm eval`（离线评测集，63 条）**：它是"行为有没有变"的最快信号。
  通过率跌超 5 个百分点会被 `engine/eval/eval.test.ts` 直接判红
  （基线在 `engine/eval/baseline.json`）。改了模型 / 提示词 / SDK / 引擎**一定**要跑它。

改动了会影响界面的东西，再跑一次免模型验收批跑：

```bash
node scripts/verify-acceptances.mjs    # 68 条，约 30 分钟
```

## 几条本项目特有的规矩（都是踩出来的）

1. **注释讲"为什么"，不讲"做了什么"** —— 读代码能知道是什么，读注释要能知道为什么不那样做。
   每条"不显然的取舍"都要留一句，否则下一个人会把它改回去。
2. **改缺陷先复现**，流程见 [`scripts/accept/DEFECT-PROTOCOL.md`](./scripts/accept/DEFECT-PROTOCOL.md)：
   复现 → 代码级根因 → 修复 → **常驻回归** → CHANGELOG。没有回归用例的修复不算修完。
3. **不许留"disabled + 借口"的死控件**（`src/deadControls.test.ts` 会挡）：
   要么实现、要么移除、要么降级成非交互元素。
4. **不许编数**：拿不到的价格 / 用量 / 版本，写"未知"，不填一个看起来合理的值
   （`shared/cost.ts` 与 `engine/runtime/models.ts` 的开头都写了这条）。
5. **守卫测试是写法的门，验收脚本是行为的门** —— 两层都要有：
   新增约定时问自己"下一个人怎么把它改回去"，那个答案就是守卫该断言的东西。
6. **别把 TODO 当完成**：`SAFETY.md` 与 README 的「已知边界」里写"未做"的，就是真的没做。

## 文档在哪

| 想写什么 | 写在哪 |
|---|---|
| 用户可见的变化 | `CHANGELOG.md`（只记用户能感知的，加"如实记下的边界"） |
| 安全 / 隔离的现状 | `SAFETY.md`（与代码逐条对应） |
| 用法与排错 | `README.md` |
| 为什么这么设计 | 代码注释（不另建 docs/ —— 那个目录不入公开仓） |

## 提交信息

一句话说清"做了什么 + 为什么"，正文里写证据（跑过的命令、数字、截图路径）。
本项目的历史提交可以直接当范例看。
