/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由原本记在 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 */

import { type CatalogItem } from "./catalog";
import { catalogIcon } from "./catalogIcon";

export function PluginCard({
  item,
  installed,
  enabled,
  onInstall,
  onEnable,
}: {
  item: CatalogItem;
  installed: boolean;
  enabled: boolean;
  onInstall: () => void;
  onEnable: () => void;
}) {
  /*
   * 左侧那枚图标：2026-10-14 之前这里是 `<span className="wb-plugin-icon" />` ——
   * **一个空的色块**。15 张卡长得一模一样，扫不动，而且和卡片底色同调、读起来像断图。
   * 现在按 id 取一枚（`catalogIcon`，未登记的回落中性方块 —— 不回落到别的条目的图标）。
   */
  const Icon = catalogIcon(item);
  return (
    <div className="wb-plugin" data-testid={`wb-plugin-${item.id}`}>
      <span className="wb-plugin-icon" aria-hidden>
        <Icon size={17} />
      </span>
      <span className="wb-plugin-text">
        <b>{item.name}</b>
        <em>{item.hint}</em>
        <span className="wb-plugin-users">{item.users}</span>
      </span>
      {installed ? (
        <button
          className={`wb-install${enabled ? " is-enabled" : ""}`}
          title={enabled ? "这次任务会用它" : "装了但这次不用"}
          data-testid={`wb-enable-${item.id}`}
          onClick={onEnable}
        >
          {enabled ? "已启用" : "启用"}
        </button>
      ) : null}
      <button
        className={`wb-install${installed ? " is-done" : ""}`}
        data-testid={`wb-install-${item.id}`}
        onClick={onInstall}
      >
        {installed ? "卸载" : "安装"}
      </button>
    </div>
  );
}

/* ============================================================
 * 云盘（Ctrl Shift D）
 * ============================================================ */

/**
 * 云盘文件行的右键菜单（对标实机 `04-cloud-row-context.png`）。
 *
 * 实机的七项：问问豆包 / 分享 / 复制链接 / 创建副本 / 添加快捷方式到 › / 收藏 / 删除。
 * 这里**能做的就真做，做不了的写清为什么** —— 分享与快捷方式需要服务端/系统集成，
 * 硬凑一个点了没反应的项比不放更糟。
 */
