import { useState } from "react";
import { VIDEO_PAGE_LABELS, addGeneration, canRetry, downloadName, type Generation } from "@shared/imagePage";
import GeneratePanel from "../canvas/GeneratePanel";
import { useWorkbenchStore } from "./store";

/**
 * 生成视频（`chat/create-video` 独立页，§174）。
 *
 * ## 与图片页同一套骨架
 *
 * 生成面板复用画布那个（`GeneratePanel kind="video"`），记录逻辑复用
 * `addGeneration` / `downloadName` / `canRetry` —— **两个页面是兄弟**，
 * 差别只有文案、以及视频没有"图生图动作条"。
 *
 * ## ⚠️ 如实说清通道状态
 *
 * 视频通道的**接口是通的**（`POST /v1/videos`），但这把 Key 下**一个视频模型都没有**
 * （列出来全是图像模型）。所以这一页**不自作主张**：面板会真去列一次模型，
 * 没有就说清"没有"，**不摆一个点了没反应的生成按钮**。
 */
export function VideoGenPage() {
  const [history, setHistory] = useState<Generation[]>([]);
  const [seed, setSeed] = useState<{ prompt: string; seq: number }>({ prompt: "", seq: 0 });
  const setView = useWorkbenchStore((s) => s.setView);

  return (
    <section className="wb-imagepage" data-testid="wb-videopage">
      <header className="wb-imagepage-head">
        <h2>{VIDEO_PAGE_LABELS.title}</h2>
        <span className="wb-imagepage-tag">{VIDEO_PAGE_LABELS.category}</span>
      </header>

      <GeneratePanel
        key={seed.seq}
        kind="video"
        placeholder={VIDEO_PAGE_LABELS.placeholder}
        initialPrompt={seed.prompt}
        onClose={() => setView("home")}
        onDone={(r) => {
          setHistory((cur) =>
            addGeneration(cur, {
              url: r.url,
              name: r.name,
              prompt: r.prompt,
              model: r.model,
              size: r.size,
              at: Date.now(),
            }),
          );
        }}
      />

      <div className="wb-imagepage-recent" data-testid="wb-videogen-recent">
        <h3>{VIDEO_PAGE_LABELS.recent}</h3>
        {history.length === 0 ? (
          <p className="wb-imagepage-empty" data-testid="wb-videogen-empty">
            {VIDEO_PAGE_LABELS.recentEmpty}
          </p>
        ) : (
          <div className="wb-imagepage-grid">
            {history.map((g) => (
              <figure className="wb-imagepage-card" key={g.url} data-testid={`wb-videogen-item-${g.name}`}>
                <video src={g.url} controls preload="metadata" />
                <figcaption>
                  <span className="wb-imagepage-prompt" title={g.prompt}>
                    {g.prompt}
                  </span>
                  <span className="wb-imagepage-acts">
                    <a
                      className="wb-imagepage-act"
                      href={g.url}
                      download={downloadName(g, "mp4")}
                      data-testid={`wb-videogen-save-${g.name}`}
                    >
                      保存视频
                    </a>
                    {canRetry(g) ? (
                      <button
                        className="wb-imagepage-act"
                        data-testid={`wb-videogen-retry-${g.name}`}
                        onClick={() => setSeed((s) => ({ prompt: g.prompt, seq: s.seq + 1 }))}
                      >
                        重新生成
                      </button>
                    ) : null}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
