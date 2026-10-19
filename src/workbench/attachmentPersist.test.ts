import { describe, expect, it } from "vitest";

import { normalizeAttachments, normalizeStep } from "./task";
import { normalizeTask } from "./taskPersist";

/**
 * G2：附件的**持久化形状**。
 *
 * 验收要钉死两件事：① 旧盘（没有 attachments）不炸；
 * ② `tasks.json` 里只有引用，**绝不能出现 base64**（否则一张图就是几 MB）。
 */

const meta = {
  path: "C:/data/sessions/t-1/attachments/uuid.png",
  mediaType: "image/png",
  bytes: 8,
  sha256: "a".repeat(64),
  name: "shot.png",
};

describe("附件元数据收窄", () => {
  it("合法条目保留；base64 字段被丢掉", () => {
    const got = normalizeAttachments([{ ...meta, data: "iVBORw0KGgo=" }]);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(meta);
    expect(JSON.stringify(got)).not.toContain("iVBORw0KGgo=");
    expect(JSON.stringify(got)).not.toContain('"data"');
  });

  it("坏条目（缺 path / bytes 非数字）逐条丢掉，不影响别的", () => {
    const got = normalizeAttachments([{ ...meta }, { path: "", mediaType: "image/png" }, null, { ...meta, bytes: "8" }]);
    expect(got).toHaveLength(1);
  });

  it("一步最多收 20 个（防病态数据把界面拖垮）", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...meta, sha256: String(i) }));
    expect(normalizeAttachments(many)).toHaveLength(20);
  });
});

describe("步骤 / 任务恢复", () => {
  it("步骤序列化再恢复，附件元数据还在", () => {
    const step = { id: "s1", role: "user", text: "看图", at: 1, attachments: [meta] };
    const json = JSON.parse(JSON.stringify(step));
    const got = normalizeStep(json, 0);
    expect(got.attachments).toEqual([meta]);
  });

  it("⭐ 旧盘步骤没有 attachments → undefined（不补空数组、不炸）", () => {
    const got = normalizeStep({ id: "s1", role: "user", text: "旧消息", at: 1 }, 0);
    expect(got.attachments).toBeUndefined();
  });

  it("normalizeTask 保留用户步骤上的附件", () => {
    const got = normalizeTask({
      id: "t-1",
      title: "带图任务",
      brief: "看图",
      createdAt: 1,
      stage: "done",
      startedAt: 1,
      finishedAt: 2,
      steps: [{ id: "s1", role: "user", text: "看图", at: 1, attachments: [meta] }],
      questions: [],
      questionIndex: 0,
      activity: "",
      artifacts: [],
    });
    expect(got?.steps[0]?.attachments).toEqual([meta]);
  });

  it("落盘内容里没有 base64（只有路径与 sha256）", () => {
    const task = normalizeTask({
      id: "t-1",
      title: "带图任务",
      brief: "看图",
      createdAt: 1,
      stage: "done",
      startedAt: 1,
      finishedAt: 2,
      steps: [{ id: "s1", role: "user", text: "看图", at: 1, attachments: [{ ...meta, data: "AAAA" }] }],
      questions: [],
      questionIndex: 0,
      activity: "",
      artifacts: [],
    });
    const saved = JSON.stringify(task);
    expect(saved).toContain('"sha256"');
    expect(saved).not.toContain("AAAA");
  });
});
