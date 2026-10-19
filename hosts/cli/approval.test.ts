import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCliApprover } from "./approval";

/**
 * A-03：CLI 就地审批。
 *
 * 判据（方案原文）：
 * - `y` → allow；`a` → allow-always；`n` / 空行 / 乱写 → deny（默认安全）；
 * - 非 TTY **不读 stdin**，打一行无头提示，并 deny；
 * - 同一个调用只问一次（allow-always 之后连问都不问）。
 */
function harness(answers: string[], opts: { interactive?: boolean } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (d) => (printed += String(d)));
  for (const line of answers) input.write(`${line}\n`);
  input.end();
  const approver = createCliApprover({
    input,
    output,
    interactive: opts.interactive ?? true,
  });
  const req = { name: "write_file", input: { path: "a.md", content: "x" } };
  /*
   * ⚠️ 这里**不要**提前挂 `data` 监听：那会把 PassThrough 切进流动模式，
   * 测试自己的监听器就把输入吃掉了，approver 永远读到空。要验"非 TTY 不读 stdin"，
   * 看 `input.readableLength`（没被读走 = 数据还在缓冲里）。
   */
  return { approver, req, input, printed: () => printed };
}

describe("A-03 · CLI 就地审批", () => {
  it("y → allow", async () => {
    const h = harness(["y"]);
    expect(await h.approver(h.req)).toBe("allow");
  });

  it("大小写不敏感、前后空白不算错", async () => {
    const h = harness(["  A  "]);
    expect(await h.approver(h.req)).toBe("allow-always");
  });

  it("n → deny", async () => {
    const h = harness(["n"]);
    expect(await h.approver(h.req)).toBe("deny");
  });

  it("空行 → deny（默认安全）", async () => {
    const h = harness([""]);
    expect(await h.approver(h.req)).toBe("deny");
  });

  it("乱写 → deny", async () => {
    const h = harness(["随便吧"]);
    expect(await h.approver(h.req)).toBe("deny");
  });

  it("非 TTY：不读 stdin，打印无头提示，deny", async () => {
    const h = harness(["y"], { interactive: false });
    expect(await h.approver(h.req)).toBe("deny");
    expect(h.printed()).toContain("无头环境无法确认");
    expect(h.printed()).toContain("--mode allow");
    /* 没读 stdin：预写的 'y' 还在缓冲里 */
    expect(h.input.readableLength).toBeGreaterThan(0);
  });

  it("allow-always 之后同一签名不再问（第二次直接放行）", async () => {
    const h = harness(["a"]);
    expect(await h.approver(h.req)).toBe("allow-always");
    expect(await h.approver({ name: "write_file", input: { content: "x", path: "a.md" } })).toBe("allow-always");
  });

  it("allow 之后同一签名再问也算过（不重复问同一次调用）", async () => {
    const h = harness(["y"]);
    expect(await h.approver(h.req)).toBe("allow");
    expect(await h.approver(h.req)).toBe("allow");
  });
});
