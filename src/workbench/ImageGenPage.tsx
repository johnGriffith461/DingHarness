import { useState } from "react";
import { IMAGE_PAGE_LABELS, addGeneration, canRetry, downloadName, type Generation } from "@shared/imagePage";
import GeneratePanel from "../canvas/GeneratePanel";
import { ImageActionBar } from "./ImageActionBar";
import { useWorkbenchStore } from "./store";

/**
 * 生成图片（`chat/create-image` 独立页，§165）。
 *
 * ⚠️ **生成能力与尺寸选择整个是复用的**（`src/canvas/GeneratePanel.tsx`）：
 * 本体里 `create-image` 是**另一个入口**，不是另一套实现。
 * 这一页只加它自己独有的东西：**最近生成**（生成结果在本体落进素材库，
 * 独立页这边先在本页留一份列表）。
 */
export function ImageGenPage() {
  const [history, setHistory] = useState<Generation[]>([]);
  /** 「重新生成」：换 `key` 把面板重挂一次并带上原句（面板的提示词是它自己的状态）。 */
  const [seed, setSeed] = useState<{ prompt: string; seq: number }>({ prompt: "", seq: 0 });
  /** 动作条给的回话（"抠图完成" / 失败原因）。 */
  const [note, setNote] = useState("");
  const setView = useWorkbenchStore((s) => s.setView);

  return (
    <section className="wb-imagepage" data-testid="wb-imagepage">
      <header className="wb-imagepage-head">
        <h2>{IMAGE_PAGE_LABELS.title}</h2>
        <span className="wb-imagepage-tag">{IMAGE_PAGE_LABELS.category}</span>
      </header>

      <GeneratePanel
        key={seed.seq}
        kind="image"
        placeholder={IMAGE_PAGE_LABELS.placeholder}
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

      {note ? (
        <p className="wb-imagepage-note" data-testid="wb-imagegen-note">
          {note}
        </p>
      ) : null}

      <div className="wb-imagepage-recent" data-testid="wb-imagegen-recent">
        <h3>{IMAGE_PAGE_LABELS.recent}</h3>
        {history.length === 0 ? (
          <p className="wb-imagepage-empty" data-testid="wb-imagegen-empty">
            {IMAGE_PAGE_LABELS.recentEmpty}
          </p>
        ) : (
          <div className="wb-imagepage-grid">
            {history.map((g) => (
              <figure className="wb-imagepage-card" key={g.url} data-testid={`wb-imagegen-item-${g.name}`}>
                {/* 生成结果是主进程落盘后给的直链（local 资源协议），所以直接当图片源 */}
                <img src={g.url} alt={g.prompt} />
                <figcaption>
                  <span className="wb-imagepage-prompt" title={g.prompt}>
                    {g.prompt}
                  </span>
                  <span className="wb-imagepage-meta">
                    {g.size} · {g.model}
                  </span>
                  <span className="wb-imagepage-acts">
                    {/* 「保存图片」与「下载」在浏览器里是同一件事（都是下载）；
                        本体是两个入口，这里保留两个按钮但**都指向同一个动作**，不假装有区别 */}
                    <a
                      className="wb-imagepage-act"
                      href={g.url}
                      download={downloadName(g)}
                      data-testid={`wb-imagegen-save-${g.name}`}
                      title={IMAGE_PAGE_LABELS.save}
                    >
                      {IMAGE_PAGE_LABELS.save}
                    </a>
                    <a
                      className="wb-imagepage-act"
                      href={g.url}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`wb-imagegen-download-${g.name}`}
                      title={IMAGE_PAGE_LABELS.download}
                    >
                      {IMAGE_PAGE_LABELS.download}
                    </a>
                    {canRetry(g) ? (
                      <button
                        className="wb-imagepage-act"
                        data-testid={`wb-imagegen-retry-${g.name}`}
                        onClick={() => setSeed((s) => ({ prompt: g.prompt, seq: s.seq + 1 }))}
                      >
                        {IMAGE_PAGE_LABELS.retry}
                      </button>
                    ) : null}
                  </span>
                  {/* 图生图动作（§167）：定义在画布那套里，这里只是再给它一个出口 */}
                  <ImageActionBar
                    source={g.url}
                    sourceSize={g.size}
                    model={g.model}
                    onNote={(n) => setNote(n)}
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
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
