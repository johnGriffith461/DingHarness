import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clapperboard, ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import {
  generateImage,
  humanImageError,
  imageBridgeReady,
  listImageModels,
  type ImageModelInfo,
} from "../ai/imageClient";
import {
  DEFAULT_SIZE_CHOICE,
  PRESET_RATIOS,
  resolveChoice,
  type SizeChoice,
  type SizeMode,
  type Tier,
} from "@shared/imageSize";

/**
 * 生成面板（图片 / 视频），挂在底部工具条上。
 *
 * 对标原版 `aiCreation_canvas_toolbar_imageGenerator` / `_videoGenerator`：
 * 原版把"生成图片 / 生成视频"直接放在画布工具条上，点开面板；生成结果**落成画布上的节点**。
 *
 * 尺寸部分严格按 Lunora 的规格实现（`shared/imageSize.ts`）：三档模式
 * （自动 / 按比例 / 自定义宽高）× 8 个比例 × 3 个档位，外加确定性规整。
 * 界面**显示算出来的真实尺寸**，规整过就带上 ⚠ —— 用户提交前就知道会拿到什么。
 *
 * 视频这一档要诚实：通道的**接口存在**（`POST /v1/videos`），但这把 Key 下
 * **一个视频模型都没有**（列出来 16 个全是图像模型），所以视频面板说清"没有模型"，
 * 而不是摆一个点了没反应的按钮。
 */
export default function GeneratePanel({
  kind,
  onDone,
  onClose,
  placeholder,
  initialPrompt = "",
}: {
  kind: "image" | "video";
  /** 生成成功：交给画布把它落成节点（独立页里则是收进"最近生成"）。 */
  onDone: (result: { name: string; url: string; prompt: string; model: string; size: string }) => void;
  onClose: () => void;
  /**
   * 覆盖提示词占位（§165）。
   *
   * 画布与**独立页**（`chat/create-image`）的占位文案**不是同一句**：
   * 本体画布那条是「描述你想要的画面，例如：」（带例子），
   * 而独立页那条是 `aiCreation_canvas_imageGenerator_inputPlaceholder` =「描述你想生成的图片」。
   * 给一个可选覆盖，比在页面里再抄一份生成逻辑干净得多。
   */
  placeholder?: string;
  /** 打开时预填的提示词（「重新生成」用：换 `key` 重挂一次就带上原句）。 */
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [models, setModels] = useState<ImageModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [choice, setChoice] = useState<SizeChoice>(DEFAULT_SIZE_CHOICE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    void listImageModels().then((list) => {
      setModels(list);
      setModel(list[0]?.models[0] ?? "");
    });
  }, []);

  /** 生成要 ~30 秒，给个秒表 —— 否则用户不知道是在跑还是卡死了。 */
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const current = useMemo(() => models.find((m) => m.models.includes(model)) ?? models[0], [models, model]);
  const ready = imageBridgeReady() && models.length > 0;
  const resolved = useMemo(() => resolveChoice(choice), [choice]);
  const canRun = ready && Boolean(prompt.trim()) && !resolved.invalid && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    const outcome = await generateImage(prompt.trim(), model, resolved.size);
    setBusy(false);
    if (outcome.ok) {
      onDone({
        name: outcome.name,
        url: outcome.url,
        prompt: prompt.trim(),
        model: outcome.model,
        // auto 模式下上游可能不回尺寸，回落到我们请求的那个
        size: outcome.size ?? resolved.size,
      });
      return;
    }
    setError(humanImageError(outcome.error));
  };

  const isVideo = kind === "video";
  const patch = (next: Partial<SizeChoice>) => setChoice((prev) => ({ ...prev, ...next }));

  return (
    <div className="gen-panel" data-testid={`gen-panel-${kind}`}>
      <div className="gen-panel-head">
        <span className="gen-panel-title">
          {isVideo ? <Clapperboard size={13} /> : <ImagePlus size={13} />}
          {isVideo ? "视频生成" : "图片生成"}
        </span>
        <button className="gen-panel-close" onClick={onClose} title="收起">
          <X size={13} />
        </button>
      </div>

      {isVideo ? (
        <VideoPanel placeholder={placeholder} />
      ) : !imageBridgeReady() ? (
        <div className="gen-panel-empty">图像通道需要在 Electron 里运行。</div>
      ) : models.length === 0 ? (
        <div className="gen-panel-empty">
          没有可用的图像通道（缺少密钥）。
          <em>
            需要 <code>LUNORA_API_KEY</code>。
          </em>
        </div>
      ) : (
        <>
          <textarea
            className="gen-panel-input"
            data-testid="gen-prompt"
            rows={3}
            placeholder={placeholder ?? "描述你想要的画面，例如：一只橘猫坐在窗台上，窗外是黄昏的城市，摄影风格"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter 直接出图，Shift+Enter 换行
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run();
              }
            }}
          />

          <div className="gen-panel-row">
            <select data-testid="gen-model" value={model} onChange={(e) => setModel(e.target.value)} title="模型">
              {(current?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className="gen-panel-run"
              data-testid="gen-run"
              disabled={!canRun}
              onClick={() => void run()}
            >
              {busy ? <Loader2 size={13} className="is-spin" /> : <Sparkles size={13} />}
              {busy ? `生成中 ${elapsed}s` : "生成"}
            </button>
          </div>

          {/* ---- 尺寸：模式 → 档位 / 比例 / 自定义宽高 ---- */}
          <div className="gen-size" data-testid="gen-size">
            <div className="gen-size-modes" role="group" aria-label="尺寸模式">
              {(
                [
                  ["auto", "自动"],
                  ["ratio", "按比例"],
                  ["resolution", "自定义"],
                ] as Array<[SizeMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`gen-size-btn${choice.mode === mode ? " on" : ""}`}
                  data-testid={`gen-size-mode-${mode}`}
                  onClick={() => patch({ mode })}
                >
                  {label}
                </button>
              ))}
            </div>

            {choice.mode === "ratio" ? (
              <div className="gen-size-row">
                <div className="gen-size-tiers" role="group" aria-label="档位">
                  {(["1K", "2K", "4K"] as Tier[]).map((tier) => (
                    <button
                      key={tier}
                      className={`gen-size-btn is-tiny${choice.tier === tier ? " on" : ""}`}
                      data-testid={`gen-tier-${tier}`}
                      onClick={() => patch({ tier })}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
                <select
                  data-testid="gen-ratio"
                  value={choice.ratio}
                  onChange={(e) => patch({ ratio: e.target.value })}
                  title="比例"
                >
                  {PRESET_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {choice.mode === "resolution" ? (
              <div className="gen-size-row">
                <input
                  className="gen-size-num"
                  data-testid="gen-width"
                  type="number"
                  min={16}
                  max={3840}
                  step={16}
                  value={choice.width}
                  onChange={(e) => patch({ width: Number(e.target.value) })}
                />
                <span className="gen-size-x">×</span>
                <input
                  className="gen-size-num"
                  data-testid="gen-height"
                  type="number"
                  min={16}
                  max={3840}
                  step={16}
                  value={choice.height}
                  onChange={(e) => patch({ height: Number(e.target.value) })}
                />
              </div>
            ) : null}

            <div className="gen-size-out" data-testid="gen-size-out">
              {resolved.invalid ? (
                <span className="gen-size-bad">尺寸无效</span>
              ) : (
                <>
                  将使用 <b>{resolved.size === "auto" ? "auto（由模型决定）" : resolved.size}</b>
                  {resolved.normalized ? (
                    <span className="gen-size-warn" title="不符合模型限制，已被自动规整">
                      <AlertTriangle size={11} /> 已规整
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {current?.note ? <div className="gen-panel-note">{current.note}</div> : null}
          {error ? (
            <div className="gen-panel-error" data-testid="gen-error">
              {error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * 视频面板（阶段 11.12）。
 *
 * 打开时**真去列一次模型** —— 不把某次探测的结果写死在界面上。
 * 没有模型就说清是"这个 Key 下没有"，并说明接口本身是通的；
 * 有模型就给提示词与生成按钮，走真正的"提交 + 轮询"。
 */
function VideoPanel({ placeholder }: { placeholder?: string } = {}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const bridge = (window as unknown as { shell?: import("@shared/ipc").ShellBridge }).shell;
    if (!bridge?.video) {
      setModels([]);
      setNote("需要在 Electron 里运行");
      return;
    }
    void bridge.video
      .listModels()
      .then((list) => setModels(list))
      .catch(() => setModels([]));
  }, []);

  const run = async () => {
    const bridge = (window as unknown as { shell?: import("@shared/ipc").ShellBridge }).shell;
    if (!bridge?.video || !prompt.trim()) return;
    setBusy(true);
    setNote("已提交，正在生成（视频通常要几十秒到几分钟）…");
    const result = await bridge.video.generate(prompt.trim());
    setBusy(false);
    setNote(result.ok ? `完成：${result.name}（${Math.round(result.ms / 1000)} 秒）` : result.error);
  };

  if (models === null) return <div className="gen-panel-empty">正在列出视频模型…</div>;

  if (models.length === 0) {
    return (
      <div className="gen-panel-empty" data-testid="video-unavailable">
        接口是通的（<code>POST /v1/videos</code>），但这把 Key 下
        <b>没有可用的视频模型</b>。
        <em>换成带视频模型的密钥，这里就能直接生成视频节点。</em>
      </div>
    );
  }

  return (
    <div className="gen-panel-body">
      <textarea
        className="gen-panel-input"
        data-testid="video-prompt"
        rows={3}
        placeholder={placeholder ?? "描述你想要的视频画面…"}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="gen-panel-row">
        <span className="gen-panel-label">模型</span>
        <span className="gen-panel-value">{models[0]}</span>
      </div>
      <button
        className="gen-panel-run"
        data-testid="video-generate"
        disabled={busy || !prompt.trim()}
        onClick={() => void run()}
      >
        {busy ? "生成中…" : "生成视频"}
      </button>
      {note ? (
        <div className="gen-panel-note" data-testid="video-note">
          {note}
        </div>
      ) : null}
    </div>
  );
}
