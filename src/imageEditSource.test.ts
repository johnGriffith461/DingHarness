import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeAll } from "./testFs";

/**
 * 图生图输入图的读回（**审计 P20 的清尾回归**，2026-10-17）。
 *
 * ## 这条守的是什么
 *
 * `dshasset://` 有**两种形态**（见 `imageGen.ts` 的 `serveAssets`）：
 *   · `dshasset://<名字>` —— 生成图，名字走 host（standard 协议会小写化，所以只用于小写安全字符）；
 *   · `dshasset://file/<origin>/<名字>` —— 云盘/产物/导出，名字走 path（percent 编码，保留大小写）。
 *
 * 显示侧（协议处理器）两种都收，但 `readSourceImage()` 原来只认第一种 ——
 * "从云盘/产物引用来的图"当图生图输入时永远回「读不到输入图」。
 * 这是一个**半态**：同一份 URI 显示得出来、读不回去。
 *
 * 判据：三种形态（host / file / data URL）都读得出；白名单外面的 origin、
 * `..` 穿越、坏 percent 编码、不存在的文件都干净地给 null（**不抛** ——
 * 抛出去会让整条 `image:edit` reject，用户看到的是另一种话）。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  ipcMain: { handle: () => undefined },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  net: { fetch: () => undefined },
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
}));

import { readSourceImage } from "../electron/ipc/imageGen";

/** 造一个真文件，返回它的字节（内容不重要 —— 这条读的是"文件读不读得到"）。 */
function put(rel: string, bytes = Buffer.from("PNG-假字节")): Buffer {
  const file = path.join(env.userData, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes;
}

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dh-imgsrc-"));
  env.userData = tmpRoot;
});

afterEach(() => {
  if (tmpRoot) removeAll(tmpRoot);
  tmpRoot = "";
});

describe("图生图输入图的读回（P20 清尾）", () => {
  it("⭐ `dshasset://file/<origin>/<名字>` 读得出来（原来只认 host 形态 —— 这就是那个半态）", () => {
    const bytes = put(path.join("assets", "gen-1.png"));
    expect(readSourceImage("dshasset://file/asset/gen-1.png")).toEqual(bytes);
  });

  it("产物目录 + 中文名（percent 编码）：读得出来", () => {
    const bytes = put(path.join("artifacts", "产品图.png"));
    const uri = `dshasset://file/artifact/${encodeURIComponent("产品图.png")}`;
    expect(readSourceImage(uri)).toEqual(bytes);
  });

  it("生成图那条 host 形态照旧（不许修一边坏一边）", () => {
    const bytes = put(path.join("assets", "gen-2.png"));
    expect(readSourceImage("dshasset://gen-2.png")).toEqual(bytes);
  });

  it("data URL 照旧", () => {
    const got = readSourceImage("data:image/png;base64,aGVsbG8=");
    expect(got?.toString("utf8")).toBe("hello");
  });

  it("白名单外的 origin / `..` 穿越 / 坏编码 / 文件不在：都给 null，不抛", () => {
    put(path.join("assets", "gen-3.png"));
    expect(readSourceImage("dshasset://file/uploads/gen-3.png")).toBeNull();
    expect(readSourceImage("dshasset://file/asset/..%2F..%2Fgen-3.png")).toBeNull();
    expect(readSourceImage("dshasset://file/asset/../assets/gen-3.png")).toBeNull();
    expect(readSourceImage("dshasset://file/asset/abc%")).toBeNull(); // 坏 percent：不抛
    expect(readSourceImage("dshasset://file/asset/nope.png")).toBeNull();
    expect(readSourceImage("")).toBeNull();
  });
});
