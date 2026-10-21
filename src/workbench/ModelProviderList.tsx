import { Search } from "lucide-react";

import { badgeOf } from "./providerBadge";

/**
 * 模型页的**左列：供应商列表**（M-01，照 Cherry 的三段式）。
 *
 * - 顶部搜索（前端过滤，按 id 与显示名）；
 * - 每行：状态点 + 名字 + 状态词（五种密钥来源，见 `providerBadge`）；
 * - 底部固定「＋ 添加供应商」；
 * - 有隐藏项时给一个恢复入口（内置供应商只能隐藏，不能删）。
 */

export type ProviderListRow = {
  id: string;
  label: string;
  keySource?: "app" | "env" | "legacy" | "none";
  configured?: boolean;
  verified?: boolean;
  available?: boolean;
  keyRef?: string;
  /** 被隐藏的（只在「显示已隐藏」打开时出现）。 */
  hidden?: boolean;
};

export function ModelProviderList({
  rows,
  active,
  query,
  onQueryChange,
  onSelect,
  onAdd,
  hiddenCount,
  showHidden,
  onToggleHidden,
}: {
  rows: readonly ProviderListRow[];
  active: string;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
}) {
  return (
    <div className="wb-modelset-list" data-testid="wb-modelset-list">
      <div className="wb-mset-search">
        <Search size={13} />
        <input
          data-testid="wb-modelset-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索供应商…"
          spellCheck={false}
        />
      </div>

      <div className="wb-mset-rows">
        {rows.length === 0 ? (
          <div className="wb-card-note" data-testid="wb-modelset-no-provider">
            {query.trim() ? "没有匹配的供应商" : "还没有供应商 —— 点下面的添加"}
          </div>
        ) : (
          rows.map((p) => {
            const badge = badgeOf(p);
            return (
              <button
                key={p.id}
                className={`wb-modelset-row${p.id === active ? " is-on" : ""}`}
                data-testid={`wb-modelset-provider-${p.id}`}
                onClick={() => onSelect(p.id)}
                title={p.hidden ? "已隐藏（从模型选择器里消失）" : badge.title}
              >
                <span className={`wb-mset-dot ${badge.className}`} aria-hidden />
                <span className="wb-modelset-name">{p.label}</span>
                {/*
                 * 「已验证」与「来源」是**两件事**：来源说这条 key 是谁的，
                 * 已验证说本会话真的调通过。环境变量来源的那条按方案文案仍写
                 * 「来自环境变量」（不升级成"已验证"），但成功这件事必须看得见 ——
                 * 所以另给一颗小字，不合并进来源词（`accept-providers` 盯着它）。
                 */}
                {p.verified && !p.hidden ? (
                  <em className="wb-mset-verified" data-testid={`wb-modelset-verified-${p.id}`}>
                    已验证
                  </em>
                ) : null}
                <em className={badge.className}>{p.hidden ? "已隐藏" : badge.text}</em>
              </button>
            );
          })
        )}
      </div>

      <div className="wb-mset-list-foot">
        {hiddenCount > 0 ? (
          <button
            className="wb-page-btn"
            data-testid="wb-modelset-toggle-hidden"
            onClick={onToggleHidden}
            title="隐藏的供应商仍可用配置恢复"
          >
            {showHidden ? "只看可见" : `显示已隐藏（${hiddenCount}）`}
          </button>
        ) : null}
        <button className="wb-page-btn wb-page-btn-primary" data-testid="wb-modelset-new-provider" onClick={onAdd}>
          ＋ 添加供应商
        </button>
      </div>
    </div>
  );
}
