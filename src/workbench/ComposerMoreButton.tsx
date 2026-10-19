/**
 * 首页输入区的「更多」按钮（C-01）。
 *
 * 首屏只留输入框 / 推荐卡 / 模型 / 档位 / 技能；项目、附件、插件、计划、思考、用量
 * 收在它后面（任务页不渲染它，那些 chip 直接全显示）。
 */
export function ComposerMoreButton({ advanced, onToggle }: { advanced: boolean; onToggle: () => void }) {
  return (
    <button
      className={`wb-chip${advanced ? " is-on" : ""}`}
      data-testid="wb-composer-more"
      aria-expanded={advanced}
      title={advanced ? "收起高级选项" : "更多：项目 / 插件 / 计划 / 思考 / 用量 / 附件"}
      onClick={onToggle}
    >
      {advanced ? "收起" : "更多"}
    </button>
  );
}
