import { UPLOAD_PANEL_LABELS } from "@shared/upload";
import { shouldShowPanel, uploadSummary, useUploadStore } from "./uploadStore";
import { taskLine } from "@shared/upload";

/**
 * 上传状态面板（§170，对应 `drive_upload_*` 十余条）。
 *
 * 文案逐字：状态（未开始 / 正在上传 / 已完成 / 解析失败 / 暂不支持该文件类型）、
 * 汇总（已上传 N 个，M 个上传失败）、三个按钮（关闭 / 收起 / 展开）。
 *
 * ⚠️ **本机版做不到的粒度不假装**：导入是一次复制，所以状态只有
 * 正在上传 → 已完成 / 失败；`正在解析` 与 `已暂停` 这两档不会出现
 * （证据里有，但那是**流式**上传才有的中间态）。
 */
export function UploadPanel() {
  const tasks = useUploadStore((s) => s.tasks);
  const collapsed = useUploadStore((s) => s.collapsed);
  const toggleCollapsed = useUploadStore((s) => s.toggleCollapsed);
  const clear = useUploadStore((s) => s.clear);

  if (!shouldShowPanel(tasks)) return null;

  return (
    <section className="wb-upload" data-testid="wb-upload-panel">
      <header className="wb-upload-head">
        <span className="wb-upload-sum" data-testid="wb-upload-sum">
          {uploadSummary(tasks)}
        </span>
        <span className="wb-spacer" />
        <button
          className="wb-icon"
          title={collapsed ? UPLOAD_PANEL_LABELS.expand : UPLOAD_PANEL_LABELS.collapse}
          data-testid="wb-upload-collapse"
          onClick={toggleCollapsed}
        >
          {collapsed ? "▴" : "▾"}
        </button>
        <button
          className="wb-icon"
          title={UPLOAD_PANEL_LABELS.close}
          data-testid="wb-upload-close"
          onClick={clear}
        >
          ×
        </button>
      </header>

      {collapsed ? null : (
        <ul className="wb-upload-list" data-testid="wb-upload-list">
          {tasks.map((t, i) => (
            <li className="wb-upload-row" key={`${t.name}-${i}`} data-testid={`wb-upload-row-${t.name}`}>
              <span className="wb-upload-name">{t.name}</span>
              <span className={t.status === "failed" ? "wb-upload-bad" : "wb-upload-ok"}>{taskLine(t)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
