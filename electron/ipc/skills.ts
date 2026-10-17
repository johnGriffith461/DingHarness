import { app, ipcMain } from "electron";
import path from "node:path";

import { SKILLS_DIR, discoverSkills, selectSkills, skillPromptBlock } from "../../engine/runtime/skills";

/**
 * 技能的 IPC 面（G08，2026-10-18）。
 *
 * 渲染层没有 `fs`：技能的发现与提示词拼接都在**主进程**做完，
 * 只把"这一段提示"（或列表）交给渲染层。
 *
 * 目录：`<userData>/skills/<技能名>/SKILL.md`。不存在就是"没有技能"（正常状态）。
 */

export const SKILLS_CHANNEL = {
  list: "skills:list",
  block: "skills:block",
} as const;

export function skillsDir(): string {
  return path.join(app.getPath("userData"), SKILLS_DIR);
}

/** 注册通道。 */
export function registerSkillsIpc(ipc: Pick<typeof ipcMain, "handle"> = ipcMain): void {
  ipc.handle(SKILLS_CHANNEL.list, () => {
    const dir = skillsDir();
    return { dir, skills: discoverSkills(dir).map((s) => ({ id: s.id, name: s.name, description: s.description, triggers: s.triggers, paths: s.paths, always: s.always })) };
  });
  ipc.handle(SKILLS_CHANNEL.block, (_event, text: unknown) => {
    const dir = skillsDir();
    const picked = selectSkills(discoverSkills(dir), { text: String(text ?? ""), files: [] });
    return skillPromptBlock(picked);
  });
}
