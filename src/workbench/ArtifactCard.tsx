import { useState } from "react";
import { ExternalLink, MoreHorizontal } from "lucide-react";

import { ARTIFACT_FORMATS, type Artifact } from "./artifact";
import { formatBytes } from "@shared/drive";
import { resourceTypeOf } from "@shared/artifactProto";
import { openArtifact } from "./store";
import { openInCanvas, opensInCanvas } from "./openInCanvas";

/**
 * 对话流里的产物卡片（对标实机形态）。§186 从 Workbench 里抽出来共享 ——
 * 聊天那条路上**同样需要它**：模型在聊天里产出的文件，如果只在磁盘上、
 * 界面上看不见，那就是 §141 打的"暗箱"。
 *
 * 实机看到的是：圆角卡片 + 类型图标 + 标题 + 「创建时间: 10-11 14:09」+ 右上角打开图标。
 * 只在右侧面板列产物是不够的 —— 那会丢掉「**这句话产出了这个东西**」这层对应关系，
 * 用户得自己回去对是哪一轮跑出来的。
 */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState("");
  const format = ARTIFACT_FORMATS[artifact.kind];
  const when = new Date(artifact.createdAt);
  const stamp = `${when.getMonth() + 1}-${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(
    when.getMinutes(),
  ).padStart(2, "0")}`;

  /**
   * 点卡片本体 = **在画布里打开**（对标实机：产物卡片打开的是画布面板）。
   * 右上角那个 ↗ 才是"用系统程序打开"—— 两者是不同的意图，分开给。
   */
  const openInCanvasNow = async () => {
    if (!opensInCanvas(artifact)) {
      // 不能进画布的类型（docx/pptx/xlsx）直接交给系统程序，别让用户点了没反应
      open();
      return;
    }
    setOpening(true);
    const error = await openInCanvas(artifact).finally(() => setOpening(false));
    if (error) setNote(error);
  };

  const open = () => {
    if (!artifact.filePath) {
      setNote("还没落盘");
      return;
    }
    setOpening(true);
    void openArtifact(artifact.filePath)
      .then((error) => setNote(error ? `打不开：${error}` : ""))
      .finally(() => setOpening(false));
  };

  return (
    <div
      className="wb-artcard"
      data-testid={`wb-artcard-${artifact.id}`}
      data-office-artifact-card-kind={artifact.kind}
      /*
       * 协议层的类型编号（`ArtifactResourceType` 0–17）。
       * 本地类型与协议的对应关系集中在 `shared/artifactProto.ts` ——
       * 贴在这里是为了让"这个产物在协议里是什么"变成**外部可观测**的东西，
       * 不然那层映射就只是文档里的一段说明。
       */
      data-artifact-resource-type={resourceTypeOf(artifact.kind)}
    >
      <button
        className="wb-artcard-main"
        data-testid={`wb-artcard-body-${artifact.id}`}
        title={opensInCanvas(artifact) ? "在画布里打开" : `用系统默认程序打开（.${format.ext}）`}
        onClick={() => void openInCanvasNow()}
      >
        <span className={`wb-artcard-icon is-${artifact.kind}`}>{format.label.slice(0, 1)}</span>
        <span className="wb-artcard-text">
          <b>{artifact.title}</b>
          <em>
            创建时间: {stamp}
            {typeof artifact.bytes === "number" ? ` · ${formatBytes(artifact.bytes)}` : ""}
            {note ? ` · ${note}` : ""}
          </em>
        </span>
      </button>
      <button
        className="wb-icon"
        title={artifact.filePath ? `用系统默认程序打开（.${format.ext}）` : "尚未落盘"}
        data-testid={`wb-artcard-open-${artifact.id}`}
        onClick={open}
      >
        {opening ? <MoreHorizontal size={15} /> : <ExternalLink size={14} />}
      </button>
    </div>
  );
}
