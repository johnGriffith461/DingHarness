import { useState } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import {
  AGENT_GROUP_LABEL,
  AGENT_LABELS,
  AGENT_TAGS,
  AGENT_TAG_GROUPS,
  agentSummary,
  validateAgent,
  type AgentTagGroup,
} from "@shared/agent";
import { useAgentStore } from "./agentStore";
import { useWorkbenchStore } from "./store";

/**
 * 创建 AI 智能体（`chat/bot/create`，§156）。
 *
 * 文案与四组标签**逐字取自** `docs/evidence-bot.txt`（`create_bot_*` 49 条）。
 *
 * ⚠️ 本体的智能体在云端（有头像生成、有封禁、能发现别人的）。本机版只做本机这一份：
 * 建好、存本地、能在对话里选用。**头像生成 / 封禁 / discover 不做。**
 */
export function AgentCreatePanel() {
  const agents = useAgentStore((s) => s.agents);
  const filling = useAgentStore((s) => s.filling);
  const note = useAgentStore((s) => s.note);
  const create = useAgentStore((s) => s.create);
  const remove = useAgentStore((s) => s.remove);
  const select = useAgentStore((s) => s.select);
  const selectedId = useAgentStore((s) => s.selectedId);
  const oneClickFill = useAgentStore((s) => s.oneClickFill);
  const setView = useWorkbenchStore((s) => s.setView);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<Record<AgentTagGroup, string[]>>({
    background: [],
    characteristic: [],
    hobby: [],
    setting: [],
  });
  const [error, setError] = useState("");

  const toggleTag = (group: AgentTagGroup, tag: string): void =>
    setTags((cur) => {
      const picked = cur[group];
      return { ...cur, [group]: picked.includes(tag) ? picked.filter((x) => x !== tag) : [...picked, tag] };
    });

  const doFill = async (): Promise<void> => {
    const filled = await oneClickFill({ name, ...tags });
    if (filled) setDescription(filled);
  };

  const doStart = async (): Promise<void> => {
    const verdict = validateAgent({ name, description });
    if (verdict) {
      setError(verdict);
      return;
    }
    setError("");
    await create({ name, description, ...tags });
    setView("home");
  };

  return (
    <section className="wb-agent" data-testid="wb-agent">
      <header className="wb-agent-head">
        <h2>{AGENT_LABELS.title}</h2>
        {note ? (
          <span className="wb-agent-note" data-testid="wb-agent-note">
            {note}
          </span>
        ) : null}
      </header>

      <div className="wb-agent-form">
        <label className="wb-agent-field">
          <span>{AGENT_LABELS.name}</span>
          <input
            data-testid="wb-agent-name"
            value={name}
            placeholder={AGENT_LABELS.namePlaceholder}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {AGENT_TAG_GROUPS.map((g) => (
          <div className="wb-agent-group" data-testid={`wb-agent-group-${g}`} key={g}>
            <span className="wb-agent-group-title">{AGENT_GROUP_LABEL[g]}</span>
            <div className="wb-agent-tags">
              {AGENT_TAGS[g].map((tag) => (
                <button
                  key={tag}
                  className={`wb-agent-tag${tags[g].includes(tag) ? " is-on" : ""}`}
                  data-testid={`wb-agent-tag-${g}-${tag}`}
                  onClick={() => toggleTag(g, tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        ))}

        <label className="wb-agent-field">
          <span>{AGENT_LABELS.promptTitle}</span>
          <textarea
            className="wb-agent-desc"
            data-testid="wb-agent-desc"
            value={description}
            placeholder={AGENT_LABELS.promptPlaceholder}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="wb-agent-bar">
          <button
            className="wb-agent-fill"
            data-testid="wb-agent-fill"
            disabled={filling}
            onClick={() => void doFill()}
          >
            <Sparkles size={13} /> {AGENT_LABELS.oneClickFill}
          </button>
          <button className="wb-agent-start" data-testid="wb-agent-start" onClick={() => void doStart()}>
            {AGENT_LABELS.start}
          </button>
          <button className="wb-agent-cancel" data-testid="wb-agent-cancel" onClick={() => setView("home")}>
            {AGENT_LABELS.cancel}
          </button>
          {error ? (
            <span className="wb-agent-error" data-testid="wb-agent-error">
              {error}
            </span>
          ) : null}
        </div>
      </div>

      {/* 已有的智能体：能选、能删（本体是在「伙伴」里管理，本机版放在这里） */}
      <div className="wb-agent-existing" data-testid="wb-agent-existing">
        <h3>我的智能体</h3>
        {agents.length === 0 ? (
          <p className="wb-agent-none">还没有，建一个试试</p>
        ) : (
          agents.map((a) => (
            <div className="wb-agent-row" key={a.id}>
              <button
                className={`wb-agent-pick${a.id === selectedId ? " is-on" : ""}`}
                data-testid={`wb-agent-pick-${a.id}`}
                title={a.description}
                onClick={() => select(a.id)}
              >
                {agentSummary(a)}
                {a.id === selectedId ? <em data-testid={`wb-agent-selected-${a.id}`}> 正在使用</em> : null}
              </button>
              <button
                className="wb-agent-del"
                aria-label="删除" title="删除"
                data-testid={`wb-agent-del-${a.id}`}
                onClick={() => void remove(a.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
