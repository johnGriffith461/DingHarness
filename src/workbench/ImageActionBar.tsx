import { useState } from "react";
import { IMAGE_ACTIONS, actionSizeFor, imageAction, type ImageActionId } from "../canvas/imageActions";
import { editImage } from "../ai/imageClient";
import { normalize, parseSize } from "@shared/imageSize";

/**
 * 图片动作条（§167）——把「抠图 / 变清晰 / 扩图 / 编辑 / 消除」摆到图旁边。
 *
 * ## 为什么是**复用**而不是另写一套
 *
 * 那组动作的定义（标签、提示词、尺寸策略）在 `src/canvas/imageActions.ts` 里**早就有**，
 * 而且是照证据写的（`aiCreation_canvas_imageAction_*`）。画布的图片节点上已经在用它。
 * 这里只是**再给它一个出口**（生成图片页的"最近生成"每条下面）——
 * **动作定义只有一处**，界面可以有多个。
 *
 * ## 输入图怎么指
 *
 * `image:edit` 的 `source` 是**文件名**（主进程按白名单目录解析，挡 `..` 穿越）——
 * 生成图落在 `assets/`，而那个目录 §166 已经进了白名单，所以生成图能直接当输入。
 */
export function ImageActionBar({
  source,
  sourceSize,
  model,
  onDone,
  onNote,
}: {
  /**
   * 输入图 — **必须是主进程认的那种引用**，不是裸文件名。
   *
   * ⚠️ `readSourceImage()` 只认两种：`dshasset://<名字>`（§166 那条资源协议）
   * 或 `data:image/...;base64,…`。第一版我传的是**裸文件名**，
   * 主进程回「读不到输入图（节点上没有可用的图片数据）」——
   * 而生成结果给的 `url` 正是 `dshasset://<名字>`，直接用它就对上了。
   */
  source: string;
  /** 输入图尺寸（例如 `1024x1024`；生成记录里带着它）。 */
  sourceSize?: string;
  model?: string;
  /** 改成功：把新图交给调用方（生成页把它收进"最近生成"）。 */
  onDone: (result: { name: string; url: string; prompt: string; model: string; size: string }) => void;
  onNote?: (note: string) => void;
}) {
  /** 正在跑的那个动作（同时只允许一个 —— 并发生成同一个源图没意义，还容易打爆额度）。 */
  const [busy, setBusy] = useState<ImageActionId | null>(null);
  /** 需要指令的那两个（编辑 / 消除）用哪一行输入。 */
  const [asking, setAsking] = useState<ImageActionId | null>(null);
  const [instruction, setInstruction] = useState("");

  const run = async (id: ImageActionId, text?: string): Promise<void> => {
    const action = imageAction(id);
    if (!action) return;
    if (action.needsInstruction && !String(text ?? "").trim()) {
      // 需要指令却没给：把输入框打开，而不是发一个空提示词上去
      setAsking(id);
      return;
    }
    setBusy(id);
    setAsking(null);
    try {
      const prompt = action.prompt({ instruction: text });
      /*
       * 尺寸策略：`keep` 传 undefined（让主进程沿用输入图尺寸），
       * `scale`（扩图）才算目标尺寸 —— 混成一个策略会让扩图扩不出去。
       *
       * ⚠️ 源尺寸**必须真的传进去**（生成记录里带着 `size`）：
       * 传 undefined 的话扩图就永远不放大，而且看不出来（图能生成、只是没变大）。
       */
      const size = actionSizeFor(id, sourceSize, parseSize, normalize);
      const got = await editImage(source, prompt, model, size);
      if (!got.ok) {
        onNote?.(got.error);
        return;
      }
      onDone({ name: got.name, url: got.url, prompt, model: got.model, size: got.size });
      onNote?.(`${action.label}完成`);
    } finally {
      setBusy(null);
      setInstruction("");
    }
  };

  return (
    /*
     * ⚠️ testid **不带 source**（第一版把 url 拼进去了，选择器一长串还跟着数据变）。
     * 这一条动作条本来就在那一张卡片的 DOM 里，定位用卡片作用域就够：
     * `[data-testid="wb-imagegen-item-<名字>"] [data-testid="wb-imageaction-enhance"]`
     */
    <div className="wb-imageactions" data-testid="wb-imageactions">
      {IMAGE_ACTIONS.map((a) =>
        a.needsInstruction ? (
          <button
            key={a.id}
            className="wb-imageaction"
            data-testid={`wb-imageaction-${a.id}`}
            title={a.hint}
            disabled={busy !== null}
            onClick={() => setAsking((cur) => (cur === a.id ? null : a.id))}
          >
            {a.label}
          </button>
        ) : (
          <button
            key={a.id}
            className="wb-imageaction"
            data-testid={`wb-imageaction-${a.id}`}
            title={a.hint}
            disabled={busy !== null}
            onClick={() => void run(a.id)}
          >
            {busy === a.id ? "…" : a.label}
          </button>
        ),
      )}

      {asking ? (
        <span className="wb-imageaction-ask">
          <input
            data-testid="wb-imageaction-input"
            value={instruction}
            placeholder={asking === "remove" ? "要消除什么" : "想怎么改"}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run(asking, instruction);
            }}
          />
          <button
            className="wb-imageaction"
            data-testid="wb-imageaction-go"
            disabled={!instruction.trim() || busy !== null}
            onClick={() => void run(asking, instruction)}
          >
            确认
          </button>
        </span>
      ) : null}
    </div>
  );
}
