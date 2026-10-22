import { describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES, imageResultFor } from "./imageContent";

/**
 * A-01：图片内容块的决定（三种输入）。
 *
 * 判据是"模型看不看得见"这件事必须**如实**：
 * 支持 → 内容块；不支持 → 一句人话（明说我看不到）；超限 → 交给调用方缩小，不截断。
 */
const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("图片内容块", () => {
  it("模型支持图片 → 给内容块", () => {
    const got = imageResultFor({ path: "/tmp/a.png", mime: "image/png", base64: png1x1, modelSupportsImage: true });
    expect(got.kind).toBe("image");
    if (got.kind !== "image") return;
    expect(got.media.mime).toBe("image/png");
    expect(got.media.base64).toBe(png1x1);
  });

  it("⭐ 模型不支持图片 → 明说看不到，并给下一步（不假装看过）", () => {
    const got = imageResultFor({ path: "/tmp/a.png", mime: "image/png", base64: png1x1, modelSupportsImage: false });
    expect(got.kind).toBe("path");
    if (got.kind !== "path") return;
    expect(got.text).toContain("我看不到");
    expect(got.text).toContain("/tmp/a.png");
    expect(got.text).toContain("支持图片的模型");
  });

  it("超过上限 → 说清多大、要调用方缩小（不截断 base64）", () => {
    const big = "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3));
    const got = imageResultFor({ path: "/tmp/big.png", mime: "image/png", base64: big, modelSupportsImage: true });
    expect(got.kind).toBe("path");
    if (got.kind !== "path") return;
    expect(got.text).toContain("缩小");
    expect(got.text).not.toContain("截断后");
  });

  it("空图 → 说它是空的（不假装有内容）", () => {
    const got = imageResultFor({ path: "/tmp/empty.png", mime: "image/png", base64: "", modelSupportsImage: true });
    expect(got.kind).toBe("path");
  });
});
