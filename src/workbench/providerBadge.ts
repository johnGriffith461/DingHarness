/**
 * provider 行上的**密钥状态徽标**（M-02）。
 *
 * 主人报的第 1 条是「供应商默认有密钥」—— 根因不是密钥真的存在，而是
 * 我们**把别的程序留在 `~/.dsh` 里的 key 当成了"用户配过了"**。
 * 所以这里把五种状态分开显示，一个都不合并：
 *
 * | 状态 | 文案 | 依据 |
 * |---|---|---|
 * | 已验证 | 绿 ·「已验证」 | 本应用保存 + 本会话真调通过 |
 * | 已保存 | 绿 ·「本应用已保存」 | `keySource === "app"` |
 * | 环境变量 | 黄 ·「来自环境变量」 | `keySource === "env"` |
 * | 旧目录 | 黄 ·「来自旧目录」 | `keySource === "legacy"`（`~/.dsh`） |
 * | 无密钥 | 灰 ·「无密钥」 | `keySource === "none"` |
 *
 * 纯函数：颜色/文案的映射只此一处，列表、详情、验收都读它。
 */

export type ProviderBadgeState = "verified" | "app" | "env" | "legacy" | "none";

export type ProviderBadge = {
  state: ProviderBadgeState;
  /** 界面上那个词（五个状态五个词，不共用）。 */
  text: string;
  /** 悬停解释（来源与下一步）。 */
  title: string;
  /** 状态点/文字的样式类（五个状态五个类名）。 */
  className: string;
};

/** 徽标输入：只认来源与两个布尔，别把整个 ProviderInfo 拖进来。 */
export type ProviderBadgeInput = {
  keySource?: "app" | "env" | "legacy" | "none";
  configured?: boolean;
  verified?: boolean;
  available?: boolean;
  keyRef?: string;
};

export function badgeOf(info: ProviderBadgeInput | undefined | null): ProviderBadge {
  /*
   * 旧夹具/浏览器占位没有 `keySource`：按"可用即本应用"回落。
   * 主进程现在一定给来源，这条只服务测试与旧的 plumbed-away 路径。
   */
  const source = info?.keySource ?? (info?.available ? "app" : "none");
  if (source === "app") {
    if (info?.verified) {
      return {
        state: "verified",
        text: "已验证",
        title: "密钥存在本应用，且本会话真的成功调用过",
        className: "is-verified",
      };
    }
    return {
      state: "app",
      text: "本应用已保存",
      title: "密钥存在本应用（加密库或 ~/.ding）—— 这是你自己配的",
      className: "is-app",
    };
  }
  if (source === "env") {
    return {
      state: "env",
      text: "来自环境变量",
      title: `${info?.keyRef ? `环境变量 ${info.keyRef}` : "环境变量"}里的密钥 —— 能用，但不是在本应用里配的`,
      className: "is-env",
    };
  }
  if (source === "legacy") {
    return {
      state: "legacy",
      text: "来自旧目录",
      title: "来自 ~/.dsh 的旧凭据文件 —— 那个目录别的程序也在用，不能算「你配过了」",
      className: "is-legacy",
    };
  }
  return {
    state: "none",
    text: "无密钥",
    title: "哪里都没有读到这条密钥 —— 在下面填一条，或改用环境变量",
    className: "is-none",
  };
}

/** 只有 `app` 来源算"已配置"（首跑向导、设置页的判据都走这一条）。 */
export function isConfigured(info: ProviderBadgeInput | undefined | null): boolean {
  return (info?.keySource ?? (info?.available ? "app" : "none")) === "app";
}
