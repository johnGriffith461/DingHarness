import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import { agentSystemPrompt, makeAgent, normalizeAgentFile, normalizeAgents, type Agent } from "@shared/agent";
import { completeOnce } from "@/ai/aiClient";
import { NO_ROUTE_MESSAGE, resolveChatRoute } from "@/ai/route";

/**
 * 本机 AI 智能体的状态（§156）。
 *
 * ## 契约
 *
 * - 建好的智能体**落盘**（`agents.json`），读回时过 `normalizeAgents`；
 * - **选中的那个**记在本地存储里（与「确认档位」同期），因为它是个"当前选择"而不是数据；
 * - 选中的智能体，它的系统提示词会在每次对话时**拼进系统提示词**（见 `agentPromptBlock`）。
 *
 * ## 「一键完善」是真调模型
 *
 * 证据里 `create_bot_one_click_fill` = **一键完善**：把选中的标签交给模型，
 * 让它写一段像样的设定描述。这是这个表单里唯一需要模型的地方。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

let seq = 0;
const nextAgentId = (): string => {
  seq += 1;
  return `ag_${Date.now().toString(36)}_${seq}`;
};

/*
 * ⚠️「当前选中的」**不放 localStorage**（§156 的教训）。
 *
 * 原来放那儿，验收撞到：建完立刻读是有的，**强杀进程再开就没了** ——
 * 因为 localStorage 是延迟落盘的，缓冲区里的写入会随进程一起丢。
 * 而 `agents.json` 是主进程的同步原子写，所以智能体本身活了下来。
 *
 * **凡是要跨重启活下来的状态，都走主进程那条落盘路。**
 */

type AgentState = {
  agents: Agent[];
  loaded: boolean;
  selectedId: string;
  /** 「一键完善」正在跑。 */
  filling: boolean;
  note: string;

  load: () => Promise<void>;
  create: (draft: Omit<Agent, "id" | "createdAt">) => Promise<Agent>;
  remove: (id: string) => Promise<void>;
  select: (id: string) => void;
  oneClickFill: (draft: { name: string } & Omit<Agent, "id" | "createdAt" | "description">) => Promise<string>;
  clearNote: () => void;
};

export const useAgentStore = create<AgentState>()((set, get) => {
  const persist = async (): Promise<void> => {
    const shell = bridge();
    if (!shell?.agents) return;
    try {
      const { agents, selectedId } = get();
      await shell.agents.save({ agents, selected: selectedId });
    } catch {
      /* 落盘失败不该把界面搅乱 */
    }
  };

  return {
    agents: [],
    loaded: false,
    selectedId: "",
    filling: false,
    note: "",

    load: async () => {
      const shell = bridge();
      if (!shell?.agents) {
        set({ loaded: true });
        return;
      }
      try {
        // 磁盘是权威：智能体与"当前选中的"一起读回来（normalizeAgentFile 会把
        // "选了个已经不存在的"收窄成"没选"）
        const file = normalizeAgentFile(await shell.agents.load());
        set({ agents: file.agents, loaded: true, selectedId: file.selected });
      } catch {
        set({ loaded: true });
      }
    },

    create: async (draft) => {
      const agent = makeAgent(nextAgentId(), draft, Date.now());
      set((s) => ({ agents: normalizeAgents([...s.agents, agent]), selectedId: agent.id }));
      await persist();
      return agent;
    },

    remove: async (id) => {
      const wasSelected = get().selectedId === id;
      set((s) => ({ agents: s.agents.filter((a) => a.id !== id), selectedId: wasSelected ? "" : s.selectedId }));
      await persist();
    },

    select: (id) => {
      const next = get().selectedId === id ? "" : id;
      set({ selectedId: next });
      // 选择本身也要落盘（空串 = 取消选择）
      void persist();
    },

    oneClickFill: async (draft) => {
      const { provider, model } = await resolveChatRoute();
      if (!provider) {
        set({ note: NO_ROUTE_MESSAGE });
        return "";
      }
      set({ filling: true });
      try {
        const system = [
          "你在帮用户填写一个 AI 智能体的「设定描述」。",
          "只输出这段描述本身：**第二人称**写（以「你是一位…」开头），100~200 字，含性格、说话风格、擅长什么。",
          "不要写解释、不要用代码块、不要重复标签原文。",
        ].join("\n");
        const user = [
          `智能体名称：${draft.name.trim() || "（未填）"}`,
          `背景：${draft.background.join("、") || "（未选）"}`,
          `特征：${draft.characteristic.join("、") || "（未选）"}`,
          `兴趣嗜好：${draft.hobby.join("、") || "（未选）"}`,
          `场景设定：${draft.setting.join("、") || "（未选）"}`,
        ].join("\n");
        const { text, error } = await completeOnce({
          provider,
          ...(model ? { model } : {}),
          system,
          messages: [{ role: "user", content: user }],
        });
        if (error || !text.trim()) {
          set({ note: `一键完善失败：${error ?? "没有返回内容"}` });
          return "";
        }
        set({ note: "已生成设定描述" });
        return text.trim();
      } finally {
        set({ filling: false });
      }
    },

    clearNote: () => set({ note: "" }),
  };
});

/**
 * 当前选中智能体的**系统提示词块**（拼进每次对话的系统提示词）。
 *
 * @returns 提示词片段；没选或已不存在时返回空串
 */
export function agentPromptBlock(): string {
  const agent = selectedAgentNow();
  return agent ? agentSystemPrompt(agent) : "";
}

/** 当前选中的智能体（接线用：工具白名单与档位都要它）。 */
export function selectedAgentNow(): Agent | undefined {
  const { agents, selectedId } = useAgentStore.getState();
  return agents.find((a) => a.id === selectedId);
}
