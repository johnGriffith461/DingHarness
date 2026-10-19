import { describe, expect, it } from "vitest";

import {
  LspFrameParser,
  diagnosticsFromPublish,
  encodeLspMessage,
  newDiagnostics,
  normalizeLspConfig,
  serverForFile,
  summarizeLspDiagnostics,
} from "./lsp";

/**
 * G6：LSP 的纯逻辑。
 * 挡的是三件最容易写错的事：半包/粘包、把旧错误当新错误、warning 混进 error 报告。
 */

function frame(message: unknown): Buffer {
  return encodeLspMessage(message);
}

describe("Content-Length 帧解析", () => {
  it("一条完整帧", () => {
    const parser = new LspFrameParser();
    const out = parser.push(frame({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    expect(parser.pendingBytes()).toBe(0);
  });

  it("⭐ 粘包：一次 push 两条", () => {
    const parser = new LspFrameParser();
    const out = parser.push(Buffer.concat([frame({ a: 1 }), frame({ b: 2 })]));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("⭐ 半包：头部/正文分三次到达，最后才解出", () => {
    const parser = new LspFrameParser();
    const full = frame({ hello: "世界" });
    expect(parser.push(full.subarray(0, 5))).toEqual([]);
    expect(parser.push(full.subarray(5, 12))).toEqual([]);
    expect(parser.push(full.subarray(12))).toEqual([{ hello: "世界" }]);
  });

  it("坏帧跳过它自己，后面的帧仍能解", () => {
    const parser = new LspFrameParser();
    const bad = Buffer.from("Content-Length: 5\r\n\r\nnotjs", "ascii");
    const out = parser.push(Buffer.concat([bad, frame({ after: true })]));
    expect(out).toEqual([{ after: true }]);
  });
});

describe("诊断收窄与差异", () => {
  const publish = (items: Array<{ message: string; severity?: number; line?: number; code?: string }>) => ({
    uri: "file:///p/a.ts",
    diagnostics: items.map((d) => ({
      message: d.message,
      ...(d.severity === undefined ? {} : { severity: d.severity }),
      ...(d.code === undefined ? {} : { code: d.code }),
      range: { start: { line: d.line ?? 0, character: 0 }, end: { line: d.line ?? 0, character: 1 } },
    })),
  });

  it("只留 error；warning/info 不报；行号转 1 基", () => {
    const got = diagnosticsFromPublish(
      publish([
        { message: "类型不匹配", line: 3, code: "TS2322" },
        { message: "未使用变量", severity: 2, line: 1 },
        { message: "提示", severity: 4 },
      ]),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ message: "类型不匹配", line: 4, code: "TS2322" });
  });

  it("⭐ 差异只报新增（同一条消息的行号/代码相同才算旧错误）", () => {
    const before = diagnosticsFromPublish(publish([{ message: "旧错", line: 0, code: "TS1" }]));
    const after = diagnosticsFromPublish(
      publish([
        { message: "旧错", line: 0, code: "TS1" },
        { message: "新错", line: 2, code: "TS2" },
      ]),
    );
    const got = newDiagnostics(before, after);
    expect(got.map((d) => d.message)).toEqual(["新错"]);
  });

  it("没有新错误时给出「无新诊断」；有错误时带文件与行号", () => {
    expect(summarizeLspDiagnostics([])).toBe("LSP：无新诊断");
    const text = summarizeLspDiagnostics([
      { uri: "file:///p/a.ts", message: "类型不匹配", line: 3 },
    ]);
    expect(text).toContain("新引入 1 个错误");
    expect(text).toContain("a.ts:3");
  });
});

describe("配置与服务器选择", () => {
  it("按扩展名选服务器（默认表）", () => {
    const config = normalizeLspConfig({
      servers: [
        { languageId: "typescript", command: "typescript-language-server", args: ["--stdio"] },
        { languageId: "python", command: "pyright-langserver" },
      ],
    });
    expect(serverForFile(config, "C:/p/a.ts")?.languageId).toBe("typescript");
    expect(serverForFile(config, "C:/p/a.py")?.languageId).toBe("python");
    expect(serverForFile(config, "C:/p/a.txt")).toBeNull();
  });

  it("enabled:false 时完全跳过（回滚开关）", () => {
    const config = normalizeLspConfig({ enabled: false, servers: [{ languageId: "typescript", command: "x" }] });
    expect(serverForFile(config, "a.ts")).toBeNull();
  });

  it("坏配置逐条丢掉，不把整份配置判死", () => {
    const config = normalizeLspConfig({
      servers: [{ languageId: "", command: "x" }, { languageId: "go", command: "" }, { languageId: "go", command: "gopls" }, "bad"],
    });
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.languageId).toBe("go");
  });

  it("扩展名不带点也能收窄成 .ext", () => {
    const config = normalizeLspConfig({ servers: [{ languageId: "custom", command: "x", extensions: ["abc"] }] });
    expect(serverForFile(config, "a.abc")?.languageId).toBe("custom");
  });
});
