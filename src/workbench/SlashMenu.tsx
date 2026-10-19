import type { SlashCommand } from "@shared/slashCommands";

/**
 * `/` 命令菜单（B2）。
 *
 * 只负责"显示 + 点选"；键盘上下与执行在 `Composer`（那里才有输入框与动作上下文）。
 * 分组顺序固定，避免同一组命令在不同时候跳来跳去。
 */

const GROUP_ORDER: Array<SlashCommand["group"]> = ["会话", "上下文", "模型", "权限", "工具", "帮助"];

export function SlashMenu({
  commands,
  selected,
  onPick,
}: {
  commands: readonly SlashCommand[];
  selected: number;
  onPick: (command: SlashCommand) => void;
}) {
  if (!commands.length) {
    return (
      <div className="wb-phrase-menu" data-testid="wb-slash-menu" onMouseDown={(e) => e.preventDefault()}>
        <div className="wb-phrase-head">命令</div>
        <p className="wb-phrase-empty" data-testid="wb-slash-empty">
          没有这个命令，试试 /help
        </p>
      </div>
    );
  }

  let index = -1;
  return (
    <div className="wb-phrase-menu" data-testid="wb-slash-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="wb-phrase-head">命令</div>
      {GROUP_ORDER.map((group) => {
        const items = commands.filter((c) => c.group === group);
        if (!items.length) return null;
        return (
          <div key={group}>
            <div className="wb-phrase-group">{group}</div>
            {items.map((command) => {
              index += 1;
              const active = index === selected;
              return (
                <button
                  key={command.name}
                  className={`wb-phrase-item${active ? " is-active" : ""}`}
                  data-testid={`wb-slash-${command.name}`}
                  aria-selected={active}
                  onClick={() => onPick(command)}
                  title={command.description}
                >
                  /{command.name}
                  <span className="wb-slash-desc">{command.description}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
