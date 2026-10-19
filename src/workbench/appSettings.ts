import { create } from "zustand";
import type { PermissionRuleWire, ShellBridge } from "@shared/ipc";
import { DEFAULT_KEYMAP, normalizeKeymap, validateChord, type KeyAction, type Keymap } from "@shared/keymap";
import { normalizePersona, type PersonaPref } from "@shared/persona";

/**
 * 本机版设置（§183）。
 *
 * 五项：
 *   · **新对话默认模型**（`settings_defaultNewChatModel`）——
 *     空串 = 「记忆上次」（`settings_modelSelection_useLast`）；
 *   · **左栏收起态**（2026-10-16，审计 P187 / P191）——
 *     它原来只活在 `store.ts` 的内存里，**重启就忘**（用户每开一次都要再收一次）；
 *   · **权限规则**（U03）：「总是允许」攒出来的那些；
 *   · **键位表**（L06）：三个动作的快捷键（`""` = 解绑）；
 *   · **助手人格**（L06）：称呼 / 语气 / 补充说明（只影响提示词，不改界面排版）。
 *
 * ⚠️ 走主进程落盘（不走 localStorage）：§156 那次"硬杀进程就没了"的教训。
 * 另外**读一次缓存在内存里** —— `resolveChatRoute()` 是同步被调的，
 * 不能每次都 await 一趟 IPC。
 *
 * ⚠️ 写的是**整份设置**：`appSettings:write` 收到的是一整个对象，只送自己那一项
 * 会把别的从盘上抹掉（用户会看到"钉住的模型重启后没了"）。
 * 所以写盘只有 `persist()` **一处** —— L06 加字段时正是靠这一点没有漏写。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

type State = {
  /** 钉住的默认通道（`provider/model`）；空串 = 记忆上次。 */
  pinnedModel: string;
  /** C3：轻量模型（`provider/model`）；空串 = 跟随主模型。 */
  liteModel: string;
  /** 左侧导航栏收起来了没有。 */
  navCollapsed: boolean;
  /** **权限规则**（U03）：「总是允许」攒出来的那些。 */
  rules: PermissionRuleWire[];
  /** 键位表（L06）。 */
  keymap: Keymap;
  /** 助手人格偏好（L06）。 */
  persona: PersonaPref;
  loaded: boolean;
  /** 上一次写盘的说明（成功为空串；失败时给一句人话，界面据此如实提示）。 */
  note: string;
  load: () => Promise<void>;
  setPinned: (value: string) => Promise<void>;
  /** C3：设置轻量模型（起标题 / 压缩用）。 */
  setLiteModel: (value: string) => Promise<void>;
  /** 收起 / 展开左栏（持久化：重启之后还是收起的样子）。 */
  setNavCollapsed: (value: boolean) => Promise<void>;
  /** 追加一条「总是允许」规则（与已有规则一模一样就不重复加）。 */
  addRule: (rule: PermissionRuleWire) => Promise<boolean>;
  /**
   * 改一个动作的键位。
   *
   * @returns `ok:false` 时带着能直接显示的原因（裸键/宿主键/与别人重复）
   */
  setKeyChord: (action: KeyAction, chord: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 改人格偏好（传 undefined 的字段表示不改）。 */
  setPersona: (patch: Partial<PersonaPref>) => Promise<void>;
};

/** 磁盘上那份（不可信）→ 干净的设置对象。 */
function readSettings(
  raw: { pinnedModel?: unknown; liteModel?: unknown; navCollapsed?: unknown; rules?: unknown; keymap?: unknown; persona?: unknown } | undefined,
): {
  pinnedModel: string;
  liteModel: string;
  navCollapsed: boolean;
  rules: PermissionRuleWire[];
  keymap: Keymap;
  persona: PersonaPref;
} {
  return {
    pinnedModel: typeof raw?.pinnedModel === "string" ? raw.pinnedModel : "",
    liteModel: typeof raw?.liteModel === "string" ? raw.liteModel : "",
    /*
     * 只认布尔：缺字段（这次修复之前的 `settings.json`）与坏值（写着 `"yes"`）
     * 一律回落到"展开"—— 左栏莫名其妙收起来，用户找不到导航。
     */
    navCollapsed: raw?.navCollapsed === true,
    /*
     * 规则只做**形状**收窄（主进程那侧还会用引擎的 `normalizeRules` 再洗一遍）：
     * 坏条目必须在这里就丢掉，否则渲染层会拿着一条没有 action 的规则去显示。
     */
    rules: Array.isArray(raw?.rules)
      ? raw.rules.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const r = item as Record<string, unknown>;
          if (typeof r.action !== "string" || !r.action.trim()) return [];
          if (r.effect !== "allow" && r.effect !== "deny" && r.effect !== "ask") return [];
          const rule: PermissionRuleWire = {
            action: r.action.trim(),
            effect: r.effect,
            ...(typeof r.resource === "string" && r.resource.trim() ? { resource: r.resource.trim() } : {}),
            ...(typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? { expiresAt: r.expiresAt } : {}),
            ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
          };
          return [rule];
        })
      : [],
    /* 键位与人格的收窄在 `shared/` 那一份里（主进程也用同一份，不许两边各写一遍） */
    keymap: normalizeKeymap(raw?.keymap),
    persona: normalizePersona(raw?.persona),
  };
}

export const useAppSettings = create<State>()((set, get) => ({
  pinnedModel: "",
  liteModel: "",
  navCollapsed: false,
  rules: [],
  keymap: { ...DEFAULT_KEYMAP },
  persona: {},
  loaded: false,
  note: "",

  load: async () => {
    const shell = bridge();
    if (!shell?.appSettings) {
      set({ loaded: true });
      return;
    }
    try {
      const got = await shell.appSettings.read();
      const clean = readSettings(got);
      set({
        pinnedModel: clean.pinnedModel,
        liteModel: clean.liteModel,
        navCollapsed: clean.navCollapsed,
        rules: clean.rules,
        keymap: clean.keymap,
        persona: clean.persona,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  setPinned: async (value) => {
    const before = get().pinnedModel;
    set({ pinnedModel: value, note: "" });
    /*
     * ⚠️ **写盘失败要回滚**（2026-10-16 审计 P273）。
     *
     * 原来这里是 `await bridge()?.appSettings?.write({...})` —— 无 try/catch、也不回滚：
     * 调用点（`SettingsPages.tsx`）是 `void ...setPinned(...)`，于是 IPC 一拒绝
     * 就是一条**未处理的拒绝**；更要紧的是界面上已经显示新值而盘上还是旧值，
     * 用户以为钉住了，重启后**悄悄回到原来那个通道**。
     * 取舍与 `codingLikes.ts` 的 `toggle` 一致：失败就回到改动前那个值，并如实说一句。
     */
    try {
      await persist(get());
    } catch (error) {
      set({
        pinnedModel: before,
        note: `没能存下这个默认模型：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },

  setLiteModel: async (value) => {
    const before = get().liteModel;
    set({ liteModel: value, note: "" });
    try {
      await persist(get());
    } catch (error) {
      set({
        liteModel: before,
        note: `没能存下轻量模型：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },

  setNavCollapsed: async (value) => {
    const before = get().navCollapsed;
    set({ navCollapsed: value, note: "" });
    /* 同 `setPinned` 的取舍：失败回滚 + 如实说一句（不回滚的话界面收起、盘上没记，重启自己弹回来） */
    try {
      await persist(get());
    } catch (error) {
      set({
        navCollapsed: before,
        note: `没能记住左栏的收起态：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },

  /**
   * 加一条「总是允许」规则（U03）。
   *
   * 返回**是否真的写进去了**：调用方（审批卡片）据此说"以后这类不再问"
   * 还是"这次做了，但没记住"。写失败就回滚内存里的那份，别让界面显示一条不存在的规则。
   */
  addRule: async (rule) => {
    const key = (r: PermissionRuleWire) => `${r.action}|${r.resource ?? "*"}|${r.effect}`;
    if (get().rules.some((r) => key(r) === key(rule))) return true;
    const before = get().rules;
    set({ rules: [...before, rule], note: "" });
    try {
      await persist(get());
      return true;
    } catch (error) {
      set({
        rules: before,
        note: `没能记住这条权限规则：${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  },

  setKeyChord: async (action, chord) => {
    const current = get().keymap;
    const others = Object.fromEntries(
      (Object.entries(current) as Array<[KeyAction, string]>).filter(([name]) => name !== action),
    ) as Partial<Record<KeyAction, string>>;
    const verdict = validateChord(chord, others, action);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const before = current;
    const next: Keymap = { ...current, [action]: verdict.chord };
    set({ keymap: next, note: "" });
    try {
      await persist(get());
      return { ok: true };
    } catch (error) {
      set({
        keymap: before,
        note: `没能记住这个键位：${error instanceof Error ? error.message : String(error)}`,
      });
      return { ok: false, reason: "写盘失败（重试过仍失败），键位没有改变" };
    }
  },

  setPersona: async (patch) => {
    const before = get().persona;
    /* 走同一份收窄：表单里能清空（`undefined` 与空串都表示"这一项不设"） */
    const next = normalizePersona({ ...before, ...patch });
    set({ persona: next, note: "" });
    try {
      await persist(get());
    } catch (error) {
      set({
        persona: before,
        note: `没能记住人格偏好：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
}));

/**
 * 写盘（**唯一一处**：整份写）。
 *
 * 加字段时只改这里与 `readSettings`，不会出现"某个写入口漏带了新字段、
 * 把它从盘上抹掉"—— 那正是这个文件头警告过的缺陷形状。
 */
async function persist(
  state: Pick<State, "pinnedModel" | "liteModel" | "navCollapsed" | "rules" | "keymap" | "persona">,
): Promise<void> {
  await bridge()?.appSettings?.write({
    pinnedModel: state.pinnedModel,
    liteModel: state.liteModel,
    navCollapsed: state.navCollapsed,
    rules: state.rules,
    keymap: state.keymap,
    persona: state.persona,
  });
}

/** C3：同步读一眼轻量模型（`provider/model`；空串 = 未设置）。 */
export function liteModelNow(): string {
  return useAppSettings.getState().liteModel;
}

/** 同步读一眼（给 `resolveChatRoute` 用）。 */
export function pinnedModelNow(): string {
  return useAppSettings.getState().pinnedModel;
}

/** 同步读一眼左栏收起态（给"接盘"的那一刻用，见 `NavSidebar.tsx`）。 */
export function navCollapsedNow(): boolean {
  return useAppSettings.getState().navCollapsed;
}

/**
 * 同步读一眼键位表（L06：窗口级 keydown 在事件回调里读，不能 await）。
 *
 * 读到的是**载入完成之后**的那份；载入之前是默认键位 ——
 * 这与左栏收起态的处理一致（`loaded` 之前界面用默认值，载入后订阅更新）。
 */
export function keymapNow(): Keymap {
  return useAppSettings.getState().keymap;
}

/** 同步读一眼人格偏好（任务启动时拼提示词用）。 */
export function personaNow(): PersonaPref {
  return useAppSettings.getState().persona;
}

/**
 * 把「左栏收起态」这条状态接起来（2026-10-16，审计 P187 / P191）。
 *
 * ## 为什么是一条接线，而不是把字段搬个家
 *
 * 它有两个家，缺一不可：**界面要用它**（`store.ts` 的 `navCollapsed`，`NavSidebar`
 * 从那里读、那颗按钮从那里切），而**"记住它"是设置**（走 `appSettings` 落盘，
 * 重启读回来）。两个家各存一份必然漂 —— 所以这里只做**搬运**：
 * 载入完成之后把盘上的值灌进界面状态一次，之后界面状态一变就写回盘上。
 *
 * ## 三种时序，逐条交代
 *
 * · **灌进去的那一次不回写**（`applying`）：否则每次启动都白写一次盘；
 * · **载入还没回来时用户先按了**（`userPressed`）：以他按的为准 ——
 *   谁也不愿意自己刚按完，界面又"啪"地弹回去。此时盘上那份**放弃**（下一次改动会覆盖它）；
 * · **载入完成之后**：界面状态是权威，每一次变化都落盘。
 *
 * 端口由调用方注入（与 `taskPersist` 的 `StorePort` 同一个取舍）：
 * 这一层于是**不认识 `store.ts`**，也就能在单测里被驱动到上面每一种时序。
 *
 * @param port `read` 读盘上那份（同步缓存）；`apply` 把值写进界面状态；
 *   `subscribe` 订阅界面状态里这一项的变化
 * @returns 停止函数（组件卸载时调）
 */
export function startNavCollapsedSync(port: {
  read: () => boolean;
  apply: (saved: boolean) => void;
  subscribe: (onChange: (value: boolean) => void) => () => void;
}): () => void {
  let ready = false;
  /** 正在把盘上的值灌进界面状态（那一次不该回写）。 */
  let applying = false;
  /** 载入完成之前用户按过没有。 */
  let userPressed = false;

  const applyFromDisk = (): void => {
    ready = true;
    if (userPressed) return;
    const saved = port.read();
    applying = true;
    try {
      port.apply(saved);
    } finally {
      applying = false;
    }
  };

  const unsubscribeStore = port.subscribe((value) => {
    if (!ready) {
      /* 载入还没回来时界面变了 = 用户自己按的 */
      userPressed = true;
      return;
    }
    if (applying) return;
    void useAppSettings.getState().setNavCollapsed(value);
  });

  const unsubscribeSettings = useAppSettings.subscribe((state) => {
    if (state.loaded && !ready) applyFromDisk();
  });
  /* 调用方也可能在载入**完成之后**才接上（重挂载）：那就不必等订阅回调 */
  if (useAppSettings.getState().loaded && !ready) applyFromDisk();

  return () => {
    unsubscribeStore();
    unsubscribeSettings();
  };
}
