import { describe, expect, it } from "vitest";

import {
  UIA_ACTIONS,
  describeUiaSnapshot,
  parseUiaAction,
  parseUiaRef,
  supportsAction,
  type UiaElement,
} from "./uia";
import { UIA_TOOL_SPECS, isUiaTool } from "./uiaTools";

/**
 * 元素版 Computer Use 的**纯逻辑**（G05）。
 *
 * 真枚举要 Windows UIA（在 `electron/ipc/uia.ts`，由 `computer_elements` 工具跑）；
 * 这里钉三件不依赖平台的事：索引/动作解析只认白名单、快照文案不淹没模型、
 * 能力判断说得清。
 */

const el = (index: number, over: Partial<UiaElement> = {}): UiaElement => ({
  index,
  controlType: "Button",
  name: `按钮${index}`,
  automationId: "",
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  patterns: ["invoke"],
  ...over,
});

describe("解析（只认白名单）", () => {
  it("⭐ ref 只认 `#数字` / `数字`", () => {
    expect(parseUiaRef("#3")).toBe(3);
    expect(parseUiaRef("12")).toBe(12);
  });

  it("⭐ 其它字符串一律 null（不接受任意选择器/表达式）", () => {
    for (const bad of ["#", "#-1", "abc", "#3; Write-Host x", "3.5", "", null, undefined]) {
      expect(parseUiaRef(bad as never), String(bad)).toBeNull();
    }
  });

  it("动作只认五个词", () => {
    for (const action of UIA_ACTIONS) expect(parseUiaAction(action)).toBe(action);
    expect(parseUiaAction("delete")).toBeNull();
    expect(parseUiaAction("")).toBeNull();
  });
});

describe("快照文案", () => {
  it("⭐ 一行一个元素：索引 / 类型 / 名字 / 支持的动作", () => {
    const text = describeUiaSnapshot({
      window: "无标题 - 记事本",
      process: "notepad",
      truncated: false,
      elements: [el(0, { name: "文件" }), el(1, { controlType: "Edit", name: "编辑区", patterns: ["setValue"] })],
    });
    expect(text).toContain("窗口：「无标题 - 记事本」（notepad）");
    expect(text).toContain("#0 Button「文件」 invoke");
    expect(text).toContain("#1 Edit「编辑区」 setValue");
  });

  it("无名且无模式的容器不列（淹没目标）", () => {
    const text = describeUiaSnapshot({
      window: "w",
      process: "p",
      truncated: false,
      elements: [el(0, { name: "", patterns: [] }), el(1, { name: "保存" })],
    });
    expect(text).not.toContain("#0");
    expect(text).toContain("#1");
  });

  it("超过上限时收尾一句（不吐几百行）", () => {
    const many = Array.from({ length: 200 }, (_, i) => el(i));
    const text = describeUiaSnapshot({ window: "w", process: "p", truncated: false, elements: many }, { maxLines: 10 });
    expect(text).toContain("还有 190 个元素");
  });

  it("截断标记如实带出来", () => {
    const text = describeUiaSnapshot({ window: "w", process: "p", truncated: true, elements: [el(0)] });
    expect(text).toContain("已按上限截断");
  });

  it("输入框现值会带出来（便于模型判断要不要覆盖）", () => {
    const text = describeUiaSnapshot({
      window: "w",
      process: "p",
      truncated: false,
      elements: [el(0, { controlType: "Edit", name: "搜索", patterns: ["setValue"], value: "旧内容" })],
    });
    expect(text).toContain("=「旧内容」");
  });
});

describe("能力判断", () => {
  it("focus 任何元素都能试；其它动作要有对应模式", () => {
    expect(supportsAction({ patterns: [] }, "focus")).toBe(true);
    expect(supportsAction({ patterns: [] }, "invoke")).toBe(false);
    expect(supportsAction({ patterns: ["setValue"] }, "setValue")).toBe(true);
  });
});

describe("工具声明", () => {
  it("三条都在，且都说明「不靠坐标」", () => {
    expect(UIA_TOOL_SPECS.map((t) => t.name)).toEqual(["computer_windows", "computer_elements", "computer_invoke"]);
    for (const spec of UIA_TOOL_SPECS) {
      expect(spec.description, spec.name).toContain("不");
      expect(spec.schema, spec.name).toBeTruthy();
    }
  });

  it("isUiaTool 只认这三条", () => {
    expect(isUiaTool("computer_invoke")).toBe(true);
    expect(isUiaTool("computer_click")).toBe(false);
    expect(isUiaTool("browser_click")).toBe(false);
  });
});
