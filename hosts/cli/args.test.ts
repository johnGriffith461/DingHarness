import { describe, expect, it } from "vitest";

import { flag, flagAll, parseArgv } from "./args";

/**
 * 命令行解析（Phase 9）。
 *
 * ## 这组断言挡的是什么
 *
 * 参数解析写错了**不会崩**：它只会表现为"某个参数没生效" ——
 * 比如 `--dir` 被当成位置参数吃掉、`--mode` 的值被当成子命令。
 * 而那种错在真实使用里极难归因（"我明明给了 --provider"）。
 */

describe("parseArgv", () => {
  it("位置参数与旗标分开", () => {
    const got = parseArgv(["run", "把文件整理一下", "--provider", "deepseek"]);
    expect(got.command).toBe("run");
    expect(got.args).toEqual(["把文件整理一下"]);
    expect(flag(got, "provider")).toBe("deepseek");
  });

  it("⭐ 三种写法都认：`--k v` / `--k=v` / `-k v`", () => {
    expect(flag(parseArgv(["--provider", "deepseek"]), "provider")).toBe("deepseek");
    expect(flag(parseArgv(["--provider=deepseek"]), "provider")).toBe("deepseek");
    expect(flag(parseArgv(["-provider", "deepseek"]), "provider")).toBe("deepseek");
  });

  it("不带值的旗标当 `true`（`--json`）", () => {
    expect(flag(parseArgv(["--json"]), "json")).toBe("true");
    expect(flagAll(parseArgv(["--json", "sessions"]), "json")).toEqual(["true"]);
  });

  it("可重复的旗标收成数组（`--dir a --dir b`）", () => {
    expect(flagAll(parseArgv(["--dir", "a", "--dir", "b"]), "dir")).toEqual(["a", "b"]);
  });

  it("旗标后面跟着另一个旗标时，前一个当 `true`（不被后一个的值吞掉）", () => {
    const got = parseArgv(["--yes", "--grant", "tools:register"]);
    expect(flag(got, "yes")).toBe("true");
    expect(flag(got, "grant")).toBe("tools:register");
  });

  it("⭐ 只给旗标时 command 是**空串**（要进交互模式，不是要帮助）", () => {
    // 第一版这里是 "help"，于是 `ding --provider strata` 永远进不了 REPL ——
    // 而它表现成"打印了一屏帮助"，看着不像 bug。
    const got = parseArgv(["--provider", "strata"]);
    expect(got.command).toBe("");
    expect(got.args).toEqual([]);
  });

  it("空 argv：什么都不给（由调用方决定是进 REPL 还是给帮助）", () => {
    expect(parseArgv([])).toEqual({ command: "", args: [], flags: new Map() });
  });

  it("`--` 之外的连字符参数照原样进 args（`-5` 这种负数值不当旗标）", () => {
    // 只是记录当前行为：真出现负数值参数时，应当走 `--k=v` 或加 `--`
    const got = parseArgv(["run", "-5"]);
    expect(got.args).toEqual([]);
    expect(flag(got, "5")).toBe("true");
  });
});
