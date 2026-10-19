import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";

import type { SavedAttachmentMeta, ShellBridge } from "@shared/ipc";

/**
 * G2：步骤里的附件（重启后仍在）。
 *
 * 磁盘上只存了元数据；这里在**渲染时**按路径向主进程要 data URL。
 * 这样 `tasks.json` 不会因为一张图膨胀，附件被用户清理时也只是占位而不是崩溃。
 */
export function StepAttachments({ attachments }: { attachments: SavedAttachmentMeta[] }) {
  if (!attachments.length) return null;
  return (
    <div className="wb-step-attachments" data-testid="wb-step-attachments">
      {attachments.map((item, index) => (
        <AttachmentChip key={`${item.sha256}-${index}`} item={item} index={index} />
      ))}
    </div>
  );
}

function AttachmentChip({ item, index }: { item: SavedAttachmentMeta; index: number }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const isImage = item.mediaType.startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
    void Promise.resolve(bridge?.attachments?.readAsDataUrl?.(item.path))
      .then((got) => {
        if (!alive) return;
        if (got?.ok) setSrc(got.dataUrl);
        else setError(got?.error ?? "读不到");
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [isImage, item.path]);

  return (
    <span className="wb-step-attachment" data-testid={`wb-step-attachment-${index}`} title={item.name}>
      {isImage ? (
        src ? (
          <>
            <button
              type="button"
              className="wb-attachment-thumb"
              data-testid={`wb-attachment-thumb-${index}`}
              onClick={() => setPreview(true)}
              aria-label={`预览 ${item.name}`}
            >
              <img src={src} alt={item.name} />
            </button>
            {preview ? (
              <span
                className="wb-attachment-preview"
                role="dialog"
                aria-label={`${item.name} 预览`}
                onClick={() => setPreview(false)}
              >
                <button
                  type="button"
                  className="wb-attachment-preview-x"
                  aria-label="关闭预览"
                  onClick={() => setPreview(false)}
                >
                  <X size={16} />
                </button>
                <img src={src} alt={item.name} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="wb-attachment-fallback" data-testid={`wb-attachment-fallback-${index}`}>
            <ImageIcon size={12} /> {error || "读取中…"} · {item.name}
          </span>
        )
      ) : (
        <span className="wb-attachment-fallback" data-testid={`wb-attachment-fallback-${index}`}>
          <FileText size={12} /> PDF：{item.name}
        </span>
      )}
    </span>
  );
}
