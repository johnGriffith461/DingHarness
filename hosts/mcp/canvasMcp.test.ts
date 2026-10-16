import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyCanvasTool, canvasDocPath, canvasTools, emptyCanvasDoc, nextPosition } from "./canvasTools";
import { handleMessage } from "./canvasServer";

/**
 * **画布 MCP server 的纯函数那一半**（V5-4 任务 4.5）。
 *
 * 端到端那一条（真起进程、真走 stdio、真改磁盘）在 `scripts/verify-canvas-mcp.mjs`
 * —— 那一条要起子进程，不该塞进单测。这里钉的是：改画布的规则、协议往返的边界
 * （通知不回、未知方法 -32601、工具层拒绝是结果不是协议错）。
 */

/** 发一条消息并解析回应（`null` = 通知没回应 —— 那种情况由调用方自己断言）。 */
const replyOf = (msg: unknown, deps: { docFile: string }): Record<string, any> => {
  const out = handleMessage(typeof msg === "string" ? msg : JSON.stringify(msg), deps);
  expect(out, "这条该有回应，但回的是 null（被当成通知了？）").not.toBeNull();
  return JSON.parse(out ?? "{}") as Record<string, any>;
};

describe("画布 MCP（V5-4 4.5）", () => {
  it("工具面从 `canvasContract` 那张表读（不在 MCP 层重抄一份）", () => {
    const tools = canvasTools();
    expect(tools.map((t) => t.name)).toEqual(["canvas_add_node"]);
    expect(tools[0]!.inputSchema.required).toEqual(["kind", "text"]);
    /* 描述里要如实说它的判定（宿主有闸门时应当先问）—— 工具面不许比策略表宽松 */
    expect(tools[0]!.description).toContain("ask");
  });

  it("加节点：revision 涨、节点进数组、位置不重叠", () => {
    const first = applyCanvasTool({ doc: emptyCanvasDoc(), name: "canvas_add_node", args: { kind: "markdown", text: "甲" } });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.doc.revision).toBe(1);
    expect(first.doc.nodes).toHaveLength(1);
    expect(first.result.isError).toBeUndefined();

    const second = applyCanvasTool({ doc: first.doc, name: "canvas_add_node", args: { kind: "code", text: "x", lang: "py" } });
    if ("error" in second) throw new Error(second.error);
    expect(second.doc.nodes).toHaveLength(2);
    expect(second.doc.nodes[1]!.data.lang).toBe("py");
    /* 第二个节点不与第一个重叠（"打开就看得见"那条） */
    expect(second.doc.nodes[1]!.position).not.toEqual(second.doc.nodes[0]!.position);
    expect(second.doc.updatedAt).toBeTruthy();
  });

  it("摆位：四个一列往下排（打开就看得见，不叠在一起）", () => {
    expect(nextPosition([])).toEqual({ x: 80, y: 80 });
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, type: "markdown" as const, position: { x: 0, y: 0 }, data: {} }));
    expect(nextPosition(four)).toEqual({ x: 80, y: 320 });
  });

  it("输入不合法：给一句能看懂的话（不抛、也不假装成功）", () => {
    const doc = emptyCanvasDoc();
    const cases = [
      { args: { kind: "image", text: "x" }, want: "kind 只支持" },
      { args: { kind: "markdown", text: "   " }, want: "不能是空的" },
      { args: { kind: "markdown", text: "y".repeat(2001) }, want: "太长" },
      { args: { kind: "markdown", text: "x" }, name: "canvas_rm_rf", want: "不认识的画布工具" },
    ];
    for (const c of cases) {
      const got = applyCanvasTool({ doc, name: c.name ?? "canvas_add_node", args: c.args as Record<string, unknown> });
      expect("error" in got, `这条该被拒：${JSON.stringify(c.args)}`).toBe(true);
      if ("error" in got) expect(got.error).toContain(c.want);
    }
  });

  it("协议往返：initialize / tools/call / 通知 / 未知方法", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-canvas-mcp-unit-"));
    try {
      const docFile = path.join(dir, "canvas", "document.json");
      const init = replyOf({ jsonrpc: "2.0", id: 1, method: "initialize" }, { docFile });
      expect(init.result.serverInfo.name).toBe("ding-canvas");

      /* 通知（没有 id）不该有回应 —— 有回应的话客户端会当成一条它没发过的请求 */
      expect(handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { docFile })).toBeNull();

      /* 工具层拒绝：200 的 result 里带 isError（"错误即结果"，不是协议错） */
      const refused = replyOf(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canvas_add_node", arguments: { kind: "bogus", text: "x" } } },
        { docFile },
      );
      expect(refused.error).toBeUndefined();
      expect(refused.result.isError).toBe(true);

      /* 协议层该守的规矩照守：未知方法 -32601、坏 JSON -32700 */
      const unknown = replyOf({ jsonrpc: "2.0", id: 3, method: "resources/list" }, { docFile });
      expect(unknown.error.code).toBe(-32601);
      const broken = replyOf("这不是 JSON", { docFile });
      expect(broken.error.code).toBe(-32700);

      /* 成功的调用会**写盘**（这是"驱动画布"的唯一证据） */
      const okCall = replyOf(
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "canvas_add_node", arguments: { kind: "markdown", text: "落盘" } } },
        { docFile },
      );
      expect(okCall.result.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(docFile, "utf8")).nodes).toHaveLength(1);

      /* 文档坏掉时：如实说"画布文件出问题"，不把进程带走 */
      writeFileSync(docFile, "{ 半个文档", "utf8");
      const brokenDoc = replyOf(
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "canvas_add_node", arguments: { kind: "markdown", text: "x" } } },
        { docFile },
      );
      expect(brokenDoc.result.isError).toBe(true);
      expect(brokenDoc.result.content[0].text).toContain("画布文件出问题");
      expect(canvasDocPath(dir)).toBe(docFile);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
