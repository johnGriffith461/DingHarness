import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMMAND_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_LINES,
  describeRunResult,
  runCommandForModel,
} from "@engine/runtime/tools/execTool";

/**
 * agent 的「跑命令」工具（2026-10-14）。
 *
 * 这是"agent 能干活"与"只能聊天"的分水岭：装依赖、跑测试、调用本机工具全靠它。
 *
 * ⚠️ 这一组**真跑命令**（不是打桩）：回显、退出码、超时、输出截断、
 * 工作目录越界 —— 每一条都真的执行一次，看结果。用真命令是因为这个工具的价值
 * 恰恰在于"它真的能执行东西"，用假 spawn 测出来的绿说明不了这件事。
 *
 * 平台：这台机器与打包目标都是 Windows，所以命令用 cmd.exe 能认的写法
 * （`echo` / `exit N` / `node <脚本>`）；脚本一律**先落成文件再跑**，
 * 避免在测试里和 cmd 的引号规则搏斗（那会让"测试挂了"和"命令写错了"分不清）。
 */
let ROOT = "";
let OUTSIDE = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "exectool-"));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "exectool-out-"));
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  /* 生成大输出的脚本（三千行，超过 2000 行上限） */
  fs.writeFileSync(
    path.join(ROOT, "work", "gen.js"),
    "for (let i = 1; i <= 3000; i += 1) console.log('line-' + i);\n",
    "utf8",
  );
  /* 睡 5 秒的脚本（给超时用） */
  fs.writeFileSync(path.join(ROOT, "work", "sleep.js"), "setTimeout(() => {}, 5000);\n", "utf8");
  /* 写一个文件出来（证明命令对磁盘的影响是真的） */
  fs.writeFileSync(
    path.join(ROOT, "work", "write.js"),
    "require('fs').writeFileSync(process.argv[2], 'written-by-command');\n",
    "utf8",
  );
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const dirs = () => [path.join(ROOT, "work")];

describe("真的能跑", () => {
  it("回显拿到、退出码 0", async () => {
    const r = await runCommandForModel({ command: "echo hello-agent" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hello-agent");
  });

  it("⭐ 命令的副作用真落在磁盘上（不是「返回值里说成功了」）", async () => {
    const out = path.join(ROOT, "work", "由命令写出.txt");
    const r = await runCommandForModel(
      { command: `node "${path.join(ROOT, "work", "write.js")}" "${out}"` },
      dirs(),
    );
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toBe("written-by-command");
  });

  it("退出码原样带回来（失败命令不许当成功）", async () => {
    const r = await runCommandForModel({ command: "exit 3" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(3);
  });

  it("stderr 也算输出（合成一份：终端里看到的就是合在一起的）", async () => {
    const r = await runCommandForModel({ command: "node -e \"console.error('bad-thing')\"" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toContain("bad-thing");
  });

  it("没输出时说明「没有输出」，不是空白", async () => {
    const r = await runCommandForModel({ command: "ver >nul" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toContain("没有输出");
  });
});

describe("超时与截断", () => {
  it("⭐ 超时会被中止，并告诉模型可以调大 timeout（而不是永远挂着）", async () => {
    const r = await runCommandForModel({ command: `node "${path.join(ROOT, "work", "sleep.js")}"`, timeout: 1000 }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain("1000 ms");
    expect(r.output).toContain("timeout");
  }, 20000);

  it("默认超时是 2 分钟（与 opencode 同值）", () => {
    expect(COMMAND_DEFAULT_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });

  it("输出过长只留**尾部**，并注明截断了（结论通常在后几行）", async () => {
    const r = await runCommandForModel({ command: `node "${path.join(ROOT, "work", "gen.js")}"` }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("line-3000");
    expect(r.output).not.toContain("line-1\n");
    expect(r.output.split("\n").length).toBeLessThanOrEqual(COMMAND_MAX_OUTPUT_LINES + 2);
  }, 30000);
});

describe("拒绝的每一条都要有理由", () => {
  it("空命令 → 拒绝", async () => {
    const r = await runCommandForModel({ command: "   " }, dirs());
    expect(r.ok).toBe(false);
  });

  it("⭐ 工作目录越界 → 拒绝（并且说明「只能在授权目录里跑」）", async () => {
    const r = await runCommandForModel({ command: "echo x", workdir: OUTSIDE }, dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("授权");
  });

  it("没给 workdir 时用第一个授权目录（模型不知道绝对路径）", async () => {
    const r = await runCommandForModel({ command: "cd" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cwd.toLowerCase()).toBe(path.join(ROOT, "work").toLowerCase());
  });
});

describe("describeRunResult", () => {
  it("成功说清跑了什么、退出码是多少", () => {
    const line = describeRunResult(
      { ok: true, command: "npm test", cwd: "D:/x", exitCode: 1, output: "", truncated: false, timedOut: false },
      "npm test",
    );
    expect(line).toContain("npm test");
    expect(line).toContain("退出码 1");
  });

  it("超时那句话与「跑完了」分开（看的人要能一眼分辨）", () => {
    const line = describeRunResult(
      { ok: true, command: "npm test", cwd: "D:/x", exitCode: null, output: "", truncated: false, timedOut: true },
      "npm test",
    );
    expect(line).toContain("超时");
  });

  it("失败时把原因带上", () => {
    const line = describeRunResult({ ok: false, error: "不在授权范围内" }, "echo x");
    expect(line).toContain("不在授权范围内");
  });
});
