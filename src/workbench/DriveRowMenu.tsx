/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由见 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 */

import type { ShellBridge } from "@shared/ipc";
import { type DriveEntry } from "@shared/drive";
import { useLibraryStore } from "./libraryStore";
import { useWorkbenchStore } from "./store";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import {
  BookOpen,
  Copy,
  Download,
  Link2,
  MessageCircle,
  Pencil,
  Share2,
  SquarePlus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";

export function DriveRowMenu({
  entry,
  x,
  y,
  starred,
  onClose,
  onChanged,
  onAiReading,
  onRename,
  onDelete,
  onDownload,
}: {
  entry: DriveEntry;
  x: number;
  y: number;
  starred: boolean;
  onClose: () => void;
  onChanged: (note: string) => void;
  /** 送到 AI 阅读（§158，证据里的 `drive_menuOption_AIReading`）。 */
  onAiReading: (entry: DriveEntry) => void;
  /** 改名（`drive_menuOption_rename`）。 */
  onRename: (entry: DriveEntry) => void;
  /** 删除（**要走确认框**，`drive_confirm_title_deleteFile`）。 */
  onDelete: (entry: DriveEntry) => void;
  /** 下载 / 另存为（§169）。 */
  onDownload: (entry: DriveEntry) => void;
}) {
  const openFloat = useWorkbenchStore((s) => s.openFloat);
  const star = useLibraryStore((s) => s.star);
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;

  const items: MenuItem[] = [
    {
      label: "问问助手",
      icon: <MessageCircle size={13} />,
      run: () => openFloat(`读一下这个文件：${entry.path}\n然后用一句话说清它讲了什么。`),
    },
    {
      /* 「AI 阅读」：把文件读成文本送进阅读面板 —— 真接上的（大纲/页面检索/图表都能用，§155） */
      label: "AI 阅读",
      icon: <BookOpen size={13} />,
      run: () => onAiReading(entry),
    },
    {
      /* 「下载」（§169）：给了目标目录就静默复制，不给就弹系统"另存为"框 */
      label: "下载",
      icon: <Download size={13} />,
      run: () => onDownload(entry),
    },
    {
      label: "重命名",
      icon: <Pencil size={13} />,
      run: () => onRename(entry),
    },
    { label: "分享", icon: <Share2 size={13} />, disabled: "分享需要服务端支持，本机版没有" },
    {
      label: "复制链接",
      icon: <Link2 size={13} />,
      run: () => {
        void navigator.clipboard.writeText(`dshasset://file/${entry.origin}/${encodeURIComponent(entry.name)}`);
        onChanged("已复制链接");
      },
    },
    {
      label: "创建副本",
      icon: <Copy size={13} />,
      run: () => {
        void bridge?.drive
          ?.duplicate(entry.path)
          .then((name) => onChanged(name ? `已创建副本：${name}` : "创建副本失败"));
      },
    },
    { label: "添加快捷方式到", icon: <SquarePlus size={13} />, disabled: "需要系统级快捷方式支持，本机版没有" },
    {
      label: starred ? "取消收藏" : "收藏",
      icon: starred ? <Star size={13} /> : <StarOff size={13} />,
      run: () => star(entry.name),
    },
    {
      // 删除**必须走确认**（证据 `drive_confirm_title_deleteFile`）—— 删文件是不可逆的
      label: "删除",
      icon: <Trash2 size={13} />,
      run: () => onDelete(entry),
    },
  ];

  return <ContextMenu items={items} x={x} y={y} onClose={onClose} testid="wb-drive-menu" />;
}
/**
 * 云盘（Ctrl Shift D）。
 *
 * **接真实目录**（阶段 11.5）：产物 / 画布导出 / 云盘本体三个来源，
 * 列表里每一条都是磁盘上真有的文件。原来那 10 行是遍历原版时的截图内容 ——
 * 等于把「当时看到的东西」当成了实现，换个账号一行都不对。
 *
 * 列口径说明：上位是 `标题 / 所有者 / 创建时间 / 最近访问`，
 * 这里是**单机版**、没有多用户，所以把「所有者」换成更有用的「类型 / 大小」。
 * 这是有意分歧，不是漏做。
 */
