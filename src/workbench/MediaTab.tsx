/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由见 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import { revealArtifact } from "./store";
import type { ShellBridge } from "@shared/ipc";
import type { DriveEntry } from "@shared/drive";

import { formatBytes } from "./uiUtil";

export function MediaTab() {
  const [images, setImages] = useState<DriveEntry[]>([]);
  const [videos, setVideos] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
      <div className="wb-summary-desc" data-testid="wb-media-note">
        视频生成接口已接（Lunora /v1/videos），但当前 Key 下没有可用的视频模型
      </div>
    </div>
  );
}

/* ============================================================
 * 设置弹窗
 * ============================================================ */

