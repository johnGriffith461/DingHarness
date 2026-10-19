import type { SettingsSubPage } from "./SettingsPages";

/**
 * T-05：左栏标签 → 设置子页（**唯一映射**）。
 *
 * 为什么要抽出来：这段映射原来是 `SettingsDialog` 里的一串 `if`，
 * 而「记忆」那一支写的是"打开左栏内联面板"（`setMemoryOpen`），
 * 不是"切子页" —— 于是右侧主面板停在上一页。把映射变成纯函数之后，
 * 单测能钉住"记忆必须是一个子页"，而不用起 Electron。
 */
export function subPageForLabel(label: string): SettingsSubPage | null {
  switch (label) {
    case "模型":
      return "models";
    case "团队空间":
      return "team";
    case "知识库":
      return "knowledge";
    case "本机档案":
      return "profile";
    case "账号":
      return "account";
    case "通用":
      return "general";
    case "关于":
      return "about";
    case "插件":
    case "插件·技能·伙伴":
      return "plugins";
    /* T-05：记忆是**独立子页**（右侧跟着切），不再在左栏内联展开 */
    case "记忆":
      return "memory";
    default:
      return null;
  }
}
