/**
 * 命令行解析（Phase 9 从 `ding.ts` 拆出来）。
 *
 * ⚠️ 拆出来不只是为了短：`ding.ts` 一 import 就会执行 `main()` ——
 * 于是**它的内部函数没法被单测**（import 它就等于跑一遍 CLI）。
 * 而"`--k=v`、`-k v`、`--flag` 三种写法都认"这种事恰恰是最该被单测钉住的
 * （它错了不会崩，只会表现为"某个参数没生效"）。
 */

/** 解析结果。 */
export type Parsed = {
  /**
   * 子命令。
   *
   * ⚠️ 没有位置参数时是**空串**，不是 `"help"`：`ding --provider strata`（只给旗标）
   * 应当进交互模式，而 `ding help` 才是要帮助。第一版把空串也当 help，
   * 于是"带旗标进 REPL"永远进不去（表现成"打印了一屏帮助"，看着不像 bug）。
   */
  command: string;
  args: string[];
  flags: Map<string, string[]>;
};

/**
 * **哪些旗标带值**（Phase 9 的必需品，不是装饰）。
 *
 * ⚠️ 没有这张表就只能"看到下一个不是 `-` 开头的就当成它的值"，于是
 * ```
 * ding --json sessions        → json = "sessions"，**没有子命令** → 进交互模式
 * ```
 * —— 用户要的是"用 JSON 列会话"，得到的是"进了 REPL"。这类错不会崩，
 * 只会让人以为命令没实现（单测里那条就是为它写的）。
 *
 * 表里的才吃下一个参数；其余一律当**开关**（`--json` / `--yes` / `--dev`）。
 * 带值的也可以写成 `--k=v`（那种写法不看这张表）。
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "dir",
  "provider",
  "model",
  "mode",
  "steps",
  "out",
  "by",
  "kind",
  "export",
  "grant",
]);

/**
 * 极简 argv 解析（不引依赖）：`--k v` / `--k=v` / `-k v` 三种都认，
 * 其余当位置参数。哪些旗标吃值见 `VALUE_FLAGS`。
 *
 * @param argv 参数（不含 node 与脚本路径）
 * @returns 解析结果
 */
export function parseArgv(argv: readonly string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (key: string, value: string) => flags.set(key, [...(flags.get(key) ?? []), value]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      add(token.slice(0, eq).replace(/^-+/, ""), token.slice(eq + 1));
      continue;
    }
    const key = token.replace(/^-+/, "");
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key) && next && !next.startsWith("-")) {
      add(key, next);
      i += 1;
    } else {
      add(key, "true");
    }
  }
  return { command: args[0] ?? "", args: args.slice(1), flags };
}

/** 取一个旗标的全部取值（可重复给）。 */
export const flagAll = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];

/** 取一个旗标的最后一个取值（`--k a --k b` → `b`）。 */
export const flag = (p: Parsed, name: string): string | undefined => flagAll(p, name).at(-1);
