/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import { revealArtifact } from "./store";
import { readModelSettings } from "./ModelSettingsPage";
import type { ShellBridge } from "@shared/ipc";
import type { DriveEntry } from "@shared/drive";

import { formatBytes } from "./uiUtil";

export function MediaTab() {
  const [images, setImages] = useState<DriveEntry[]>([]);
  const [videos, setVideos] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /*
   * 本机在这个通道下**已经拉取过**几个模型（同步读本地设置，**不联网**）。
   *
   * ⚠️ 刻意不在这个面板里调 `video:listModels`：那一次是**真出网**，
   * 而用户只是打开了右栏的「图片与视频」页签 —— 不该因此打一次请求。
   * 也因此**不在这里复述"哪些名字算视频模型"**（那份判据在主进程 `videoGen.isVideoModel` 里）：
   * 这里只说产品真知道的数字，别长成第二份判断。
   */
  const pulledModels = readModelSettings()["lunora"]?.models?.length ?? 0;

  useEffect(() => {
    const bridge = (window as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.drive) {
      setLoading(false);
      return;
    }
    void bridge.drive
      .list()
      .then((list) => {
        const entries = list as DriveEntry[];
        setImages(entries.filter((e) => e.kind === "image"));
        setVideos(entries.filter((e) => /\.(mp4|webm|mov|mkv)$/i.test(e.name)));
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="wb-summary-section">
      <div className="wb-summary-title">
        图片与视频
        {images.length + videos.length > 0 ? (
          <em className="wb-media-count">{images.length + videos.length}</em>
        ) : null}
      </div>
      {loading ? (
        <div className="wb-summary-empty">读取中…</div>
      ) : images.length + videos.length === 0 ? (
        <div className="wb-summary-empty" data-testid="wb-media-empty">
          还没有图片或视频。在画布上生成图片、或往云盘里传图片，都会出现在这里。
        </div>
      ) : (
        <div className="wb-media" data-testid="wb-media">
          {images.map((entry) => (
            <button
              className="wb-media-cell"
              key={entry.path}
              title={`${entry.name}（${formatBytes(entry.bytes)}）`}
              data-testid={`wb-media-${entry.name}`}
              onClick={() => void revealArtifact(entry.path)}
            >
              <img
                className="wb-media-thumb"
                src={`dshasset://file/${entry.origin}/${encodeURIComponent(entry.name)}`}
                alt={entry.name}
                draggable={false}
                onError={(e) => {
                  // 取不到就退成文件名块，不留一个破图
                  const el = e.currentTarget;
                  el.style.display = "none";
                  el.parentElement?.classList.add("is-broken");
                }}
              />
              <span className="wb-media-name">{entry.name}</span>
            </button>
          ))}
          {videos.map((entry) => (
            <button
              className="wb-media-cell is-video"
              key={entry.path}
              title={entry.name}
              onClick={() => void revealArtifact(entry.path)}
            >
              <span className="wb-media-name">▶ {entry.name}</span>
            </button>
          ))}
        </div>
      )}
      {/*
        ⚠️ 2026-10-16（审计 P92）：这句话原来是**写死的**
        「…但当前 Key 下没有可用的视频模型」—— 那是关于**外部账号状态**的断言，
        换一把 Key、拉一次模型就变成假话；而兄弟页（设置 → 模型）是**真动态**的
        （`models === null` 说"正在列出…"、`length === 0` 才说"没有"）。同一产品两处口径相反。
        现在只说产品**真知道**的事：接口接了（这句是代码事实），
        以及"本地拉过几个模型"（本地设置，不联网）——有没有得看设置里那一栏。
      */}
      <div className="wb-summary-desc" data-testid="wb-media-note">
        {pulledModels > 0
          ? `视频生成接口已接（Lunora /v1/videos）；本机在这个通道下已拉取 ${pulledModels} 个模型，生成时按名字挑一个（清单在「设置 → 模型」）`
          : "视频生成接口已接（Lunora /v1/videos）；有没有可用的视频模型，要在「设置 → 模型」里拉取一次才知道（这里不替你猜）"}
      </div>
    </div>
  );
}

/* ============================================================
 * 设置弹窗
 * ============================================================ */

