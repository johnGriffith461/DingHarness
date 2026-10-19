import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lspNoteForEdits, stopAllLsp } from "./lspClient";

/**
 * G6 端到端：**真的子进程 + 真的 Content-Length 帧**。
 *
 * 假 LSP server 只看 `didOpen`/`didChange` 的文本：含 `BROKEN` 就发一条 error。
 * 这条挡的是"帧解析在单测里成立、真进程一接就全坏"。
 */

const SERVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii"), body]));
}
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === "initialized") return;
  const doc = msg.params && msg.params.textDocument;
  if ((msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") && doc) {
    const text = msg.method === "textDocument/didOpen"
      ? msg.params.textDocument.text
      : (msg.params.contentChanges && msg.params.contentChanges[0] && msg.params.contentChanges[0].text) || "";
    const diagnostics = text.includes("BROKEN")
      ? [{ severity: 1, code: "FAKE1", message: "假错误：这里坏了", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } } },
         { severity: 2, message: "warning 不该被报", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
      : [];
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: doc.uri, diagnostics } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString("ascii");
    const m = /content-length\\s*:\\s*(\\d+)/i.exec(header);
    if (!m) { buffer = buffer.subarray(end + 4); continue; }
    const start = end + 4;
    const len = Number(m[1]);
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`;

let dir: string;
let file: string;
let script: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ding-lsp-"));
  file = path.join(dir, "a.fake");
  script = path.join(dir, "server.js");
  fs.writeFileSync(script, SERVER, "utf8");
});

afterEach(async () => {
  stopAllLsp();
  /*
   * Windows：子进程退出是异步的，cwd 还占着目录时 rmSync 会 EPERM。
   * 重试几次是这台机器上唯一可靠的做法（与 accept 脚本里的 freshDir 同一口径）。
   */
  for (let i = 0; i < 8; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
});

function config() {
  return {
    servers: [
      {
        languageId: "fake",
        command: process.platform === "win32" ? "node" : process.execPath,
        args: [script],
        extensions: [".fake"],
      },
    ],
  };
}

describe("G6 端到端（真子进程）", () => {
  it("改出错误 → 工具结果附「新引入 1 个错误」；改对 → 「无新诊断」", async () => {
    const before = "const x = 1;\n";
    fs.writeFileSync(file, "const x = BROKEN;\n", "utf8");
    const got = await lspNoteForEdits(config(), [{ path: file, before }]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]?.message).toContain("假错误");
    expect(got.errors[0]?.line).toBe(3);
    expect(got.line).toContain("新引入 1 个错误");
    expect(got.line).not.toContain("warning");

    /* 第二次：从"坏"改成"好"，旧错误不该被当成新引入 */
    fs.writeFileSync(file, "const x = 1;\n", "utf8");
    const fixed = await lspNoteForEdits(config(), [{ path: file, before: "const x = BROKEN;\n" }]);
    expect(fixed.errors).toHaveLength(0);
    expect(fixed.line).toBe("LSP：无新诊断");
  }, 20_000);

  it("没配置 → 完全跳过（空串、不启进程）", async () => {
    const got = await lspNoteForEdits({ servers: [] }, [{ path: file, before: null }]);
    expect(got.line).toBe("");
    expect(got.errors).toEqual([]);
  });

  it("server 起不来 → 不抛、本次没有诊断（编辑不受影响）", async () => {
    fs.writeFileSync(file, "x", "utf8");
    const got = await lspNoteForEdits(
      { servers: [{ languageId: "fake", command: "definitely-not-a-real-lsp-binary-xyz", extensions: [".fake"] }] },
      [{ path: file, before: null }],
    );
    expect(got.errors).toEqual([]);
    /* ⭐ 没起来 = "未诊断"，不能把"没看"说成"没问题" */
    expect(got.line).toContain("未诊断");
    expect(got.line).not.toContain("无新诊断");
  }, 20_000);
});
