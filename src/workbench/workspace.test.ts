import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACES,
  WORKSPACE_LABELS,
  addedNote,
  emptyWorkspaces,
  normalizeWorkspaces,
  workspaceLabel,
} from "@shared/workspace";

/**
 * 工作区（2026-10-14）：**用户授权给 agent 干活的目录**。
 *
 * 这一层是纯的（不碰磁盘），钉的是"磁盘上读回来的东西一律不可信"那一条：
 * 手改过 / 老版本写坏的 `workspaces.json` 不许把界面或工具搞崩。
 *
 * 授权流程本身（系统目录选择器 → 落盘 → `ownedDirs()` 生效）在
 * `scripts/accept/accept-workspace.mjs` 里端到端验 —— 那条脚本走的是
 * **真实 IPC 调用工具**这条路，所以它同时证明了"授权之后 agent 真能在那个目录里干活"。
 */
describe("normalizeWorkspaces", () => {
  it("正常形状原样保留", () => {
    expect(normalizeWorkspaces({ dirs: ["D:\\a", "D:\\b"] })).toEqual({ dirs: ["D:\\a", "D:\\b"] });
  });

  it("裸数组也认（老数据没有信封）", () => {
    expect(normalizeWorkspaces(["D:\\a"])).toEqual({ dirs: ["D:\\a"] });
  });

  it("坏值一律兜成空表（不许把界面搞崩）", () => {
    expect(normalizeWorkspaces(null)).toEqual({ dirs: [] });
    expect(normalizeWorkspaces("字符串")).toEqual({ dirs: [] });
    expect(normalizeWorkspaces({ dirs: "不是数组" })).toEqual({ dirs: [] });
    expect(normalizeWorkspaces({ dirs: [1, null, {}, ""] })).toEqual({ dirs: [] });
  });

  it("去掉首尾空白，空串丢掉", () => {
    expect(normalizeWorkspaces({ dirs: ["  D:\\a  ", "   "] })).toEqual({ dirs: ["D:\\a"] });
  });

  it("⭐ 去重按**大小写不敏感**：Windows 上同一个目录两种写法不该算两个", () => {
    expect(normalizeWorkspaces({ dirs: ["D:\\Work", "d:\\work"] })).toEqual({ dirs: ["D:\\Work"] });
  });

  it("条数有上限（授权一多就没人记得清哪里能碰了）", () => {
    const many = Array.from({ length: MAX_WORKSPACES + 5 }, (_, i) => `D:\\w${i}`);
    expect(normalizeWorkspaces({ dirs: many }).dirs.length).toBe(MAX_WORKSPACES);
    expect(MAX_WORKSPACES).toBe(8);
  });
});

describe("界面文案", () => {
  it("短名字取最后一段（长路径塞不进菜单）", () => {
    expect(workspaceLabel("D:\\我的项目\\子目录")).toBe("子目录");
    expect(workspaceLabel("D:\\我的项目\\")).toBe("我的项目");
    expect(workspaceLabel("/home/u/work")).toBe("work");
  });

  it("授权回执带目录短名", () => {
    expect(addedNote("D:\\我的项目")).toContain("我的项目");
    expect(addedNote("D:\\我的项目")).toContain("跑命令");
  });

  it("文案是**本机自定**（证据里没有「工作区」这个概念，不假装逐字一致）", () => {
    expect(WORKSPACE_LABELS.add).toBe("授权文件夹给 agent");
    expect(WORKSPACE_LABELS.remove).toBe("撤销");
    expect(emptyWorkspaces()).toEqual({ dirs: [] });
  });
});
