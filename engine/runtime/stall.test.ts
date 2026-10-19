import { describe, expect, it } from "vitest";

import { createStallDetector, emptyResponseOutcome, signatureOf } from "./stall";

/**
 * P0-06：卡住检测的表驱动用例。
 *
 * 判据只看"同一签名在窗口内出现几次"，与调用内容无关。
 */
describe("signatureOf", () => {
  it("键顺序不同视为同一签名", () => {
    expect(signatureOf("read_file", { path: "a", limit: 1 })).toBe(signatureOf("read_file", { limit: 1, path: "a" }));
  });

  it("嵌套对象同样稳定", () => {
    expect(signatureOf("x", { a: { y: 1, z: 2 } })).toBe(signatureOf("x", { a: { z: 2, y: 1 } }));
  });

  it("参数不同就是不同签名", () => {
    expect(signatureOf("read_file", { path: "a" })).not.toBe(signatureOf("read_file", { path: "b" }));
  });

  it("工具名不同就是不同签名", () => {
    expect(signatureOf("read_file", { path: "a" })).not.toBe(signatureOf("list_dir", { path: "a" }));
  });
});

describe("createStallDetector", () => {
  it("同一签名 1→ok、3→nudge、5→stop", () => {
    const d = createStallDetector();
    const sig = signatureOf("read_file", { path: "a" });
    expect(d.push(sig)).toBe("ok");
    expect(d.push(sig)).toBe("ok");
    expect(d.push(sig)).toBe("nudge");
    expect(d.push(sig)).toBe("ok");
    expect(d.push(sig)).toBe("stop");
  });

  it("nudge 只给一次（之后不会每步都提示）", () => {
    const d = createStallDetector();
    const sig = signatureOf("read_file", { path: "a" });
    const verdicts = [1, 2, 3, 4].map(() => d.push(sig));
    expect(verdicts).toEqual(["ok", "ok", "nudge", "ok"]);
  });

  it("窗口外的旧调用不算（window=3 时第 4 次只算 3 次）", () => {
    const d = createStallDetector({ window: 3 });
    const a = signatureOf("a", {});
    d.push(a);
    d.push(a);
    d.push(signatureOf("b", {}));
    /* 此时窗口里只有 [a, a, b] → a 出现 2 次 */
    expect(d.push(signatureOf("a", {}))).toBe("ok");
  });

  it("不同签名交替出现不会误判", () => {
    const d = createStallDetector();
    const a = signatureOf("a", {});
    const b = signatureOf("b", {});
    for (let i = 0; i < 4; i += 1) {
      expect(d.push(i % 2 ? a : b)).toBe("ok");
    }
  });

  it("非法配置回落到安全默认（nudgeAt < 2 抬到 2）", () => {
    const d = createStallDetector({ nudgeAt: 0, stopAt: 1 });
    const sig = signatureOf("a", {});
    expect(d.push(sig)).toBe("ok");
    expect(d.push(sig)).toBe("nudge");
  });
});

describe("emptyResponseOutcome", () => {
  it("给出明确错误，而不是空成功", () => {
    expect(emptyResponseOutcome()).toEqual({ ok: false, error: "模型没有返回任何内容" });
  });
});
