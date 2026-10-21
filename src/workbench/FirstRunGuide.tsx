import { useEffect, useState } from "react";
import type { ProviderInfo } from "@shared/ipc";
import { CONFIRM_MODES, type ConfirmMode } from "@shared/ipc";

import { useAppSettings } from "./appSettings";
import { isConfigured } from "./providerBadge";
import { NewProviderDialog } from "./NewProviderDialog";
import { saveConfirmMode } from "./confirmMode";
import { readSavedRoute } from "@/ai/route";
import type { ShellBridge } from "@shared/ipc";

/** 下拉里"添加自定义服务商"那一项的值（不是真 provider id）。 */
const CUSTOM_PROVIDER_VALUE = "__custom_provider__";

/**
 * **首跑向导**（U06，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 产品审计的第一条是"干净机器装好之后不知道该干什么"：首屏只有一句问候，
 * 而"配哪家、key 填哪、用哪个模型、工作区授权哪个目录、权限用哪档"分散在五个地方。
 * 目标：**10 分钟内能开始干活**。
 *
 * ## 五步（与方案 §6.2 U06 一一对应）
 *
 * 1. 选 provider；
 * 2. 填 key（走主进程 `secrets.set`：桌面端是 DPAPI/Keychain 加密的）；
 * 3. 选模型（用该 provider 自己的模型清单）；
 * 4. 授权工作区（系统目录选择器 —— 渲染进程注入不了路径）；
 * 5. 选权限档位（默认「按需确认」，安全默认）。
 *
 * ## 什么时候出现（而且**只**在这时候）
 *
 * `appSettings` 已载入、**没有钉住默认模型**、而且**所有 provider 都没有可用 key**。
 * 三者缺一就不弹：已经有 key 的人不该被向导挡住；用户点过「先自己配」之后
 * 本次会话也不再弹（`localStorage` 记一个标记，不是永久关闭 —— 下次启动仍会提示）。
 */

const DISMISS_KEY = "dsh-canvas.first-run-dismissed";
/**
 * F-01：**完成**配置的标记（与"跳过"分开）。
 *
 * 旧实现完成时写的是 `DISMISS_KEY` —— 那在语义上是"我不配了"，
 * 于是"配好了、后来取消了默认模型"的人也不会再看到向导（他并不需要）。
 * 现在完成写这一格：它只说"这个人配过"，不改变将来是否重新引导的判断。
 */
export const SETUP_DONE_KEY = "dsh-canvas.setup-done";
/** 用户在设置里点了「重新运行配置向导」——本次/下次启动都先弹一次。 */
const REOPEN_KEY = "dsh-canvas.setup-reopen";

/**
 * 没有 `localStorage` 时的回退（单测/隐私模式）。
 *
 * 读优先级：localStorage 里有这个键就信它；没有就落到这里的记忆值。
 * 这样单测能直接调 `reopenSetup()`，而真实应用仍然跨重启记住。
 */
const memory = { dismissed: false, done: false, reopened: false };
const listeners = new Set<() => void>();

function notifyFirstRun(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 一个订阅者坏了不该带走别的 */
    }
  }
}

function readFlag(key: string, name: keyof typeof memory): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw === "1";
  } catch {
    /* 没有 localStorage → 用内存里的那一份 */
  }
  return memory[name];
}

function writeFlag(key: string, name: keyof typeof memory, value: boolean): void {
  memory[name] = value;
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* 存不进去也先让这一次生效 */
  }
  notifyFirstRun();
}

/** 订阅"向导的开合状态变了"（完成 / 跳过 / 重开）。 */
export function subscribeFirstRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 向导完成：写 `SETUP_DONE_KEY`，并清掉"重开"的临时标记。 */
export function markSetupDone(): void {
  memory.reopened = false;
  writeFlag(SETUP_DONE_KEY, "done", true);
  try {
    localStorage.removeItem(REOPEN_KEY);
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* 同上 */
  }
}

/** 「稍后再说」：记下"这次不配"（设置里仍可重开）。 */
export function dismissFirstRun(): void {
  memory.reopened = false;
  writeFlag(DISMISS_KEY, "dismissed", true);
  try {
    localStorage.removeItem(REOPEN_KEY);
  } catch {
    /* 同上 */
  }
}

/** 「设置 → 通用 → 重新运行配置向导」：清掉完成/跳过标记，显式要求再走一遍。 */
export function reopenSetup(): void {
  memory.done = false;
  memory.dismissed = false;
  writeFlag(REOPEN_KEY, "reopened", true);
  try {
    localStorage.removeItem(SETUP_DONE_KEY);
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* 同上 */
  }
}

/** 单测用：把内存里的三个标记清回初始值（真实数据在 localStorage，不受影响）。 */
export function __resetFirstRunFlagsForTest(): void {
  memory.dismissed = false;
  memory.done = false;
  memory.reopened = false;
}

/**
 * 该不该弹首跑向导。
 *
 * @param loaded 设置载入了没有
 * @param pinnedModel 钉住的默认通道
 * @param providers provider 清单（还没读到时给 `null`）
 * @param opts 测试/调用方显式覆盖（省略 = 读 localStorage）
 */
export function shouldShowFirstRun(
  loaded: boolean,
  pinnedModel: string,
  providers: readonly ProviderInfo[] | null,
  opts: { savedRoute?: string; setupDone?: boolean; dismissed?: boolean; reopened?: boolean } = {},
): boolean {
  if (!loaded || !providers) return false;
  /*
   * F-01：用户显式从设置里点了「重新运行配置向导」—— 优先级最高。
   * 他要的就是"把向导拿回来"，不该被"你已经有模型了"挡回去。
   */
  if (opts.reopened ?? readFlag(REOPEN_KEY, "reopened")) return true;
  /*
   * 配完过一次就不再打扰：即使后来取消了钉住的模型。
   * （pinnedModel 那一关仍然保留：用户自己选了模型、但没走完向导的情况。）
   */
  if (opts.setupDone ?? readFlag(SETUP_DONE_KEY, "done")) return false;
  /*
   * P0-08：判据只看**有没有钉住模型**。
   *
   * 原来"任何一家有 key → 不弹"，于是"有 key、没选模型"的用户永远落不到
   * "选模型"这一步 —— 向导整块消失，首页显示自动选择，用户不知道自己在用哪个模型。
   * 现在有 key 的会从第 2 步开始（跳过填 key），仍要求选完模型。
   */
  if (pinnedModel) return false;
  /*
   * 2026-10-19（主人实测）：他已经在输入区选过模型（路由存在 localStorage），
   * 但没走完向导 —— 于是每次开应用都弹这张卡。"正在用某个模型的人"不该被反复要求再选一次。
   * 路由形如 `provider/model`，半个值不算（与 `normalizePinnedModel` 同一口径）。
   */
  const saved = String(opts.savedRoute ?? "").trim();
  const [savedProvider, ...rest] = saved.split("/");
  if (savedProvider && rest.join("/")) return false;
  return !(opts.dismissed ?? readFlag(DISMISS_KEY, "dismissed"));
}

/**
 * 首屏要不要**只显示向导**（F-01）。
 *
 * 返回三态：
 * - `ready:false` —— 设置/通道清单还没读完（先别画首页，避免"首页闪一下又被盖住"）；
 * - `visible:true` —— 只渲染向导；
 * - `visible:false` —— 渲染首页。
 *
 * 已经钉住模型的人**立即** ready（不必等 provider 清单）：任何情况下向导都不会出现。
 */
export function useFirstRunVisibility(): { ready: boolean; visible: boolean } {
  const loaded = useAppSettings((s) => s.loaded);
  const pinnedModel = useAppSettings((s) => s.pinnedModel);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [, force] = useState(0);

  useEffect(() => subscribeFirstRun(() => force((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell?.ai?.listProviders) {
      setProviders([]);
      return;
    }
    void shell.ai
      .listProviders()
      .then((list) => {
        if (alive) setProviders(list);
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const saved = readSavedRoute();
  const savedRoute = saved.provider && saved.model ? `${saved.provider}/${saved.model}` : "";
  if (!loaded) return { ready: false, visible: false };
  /* 重开意图优先于"已经配好"（F-01） */
  if (readFlag(REOPEN_KEY, "reopened")) return { ready: true, visible: true };
  if (pinnedModel || savedRoute) return { ready: true, visible: false };
  if (providers === null) return { ready: false, visible: false };
  return { ready: true, visible: shouldShowFirstRun(loaded, pinnedModel, providers, { savedRoute }) };
}

export function FirstRunGuide() {
  const loaded = useAppSettings((s) => s.loaded);
  const pinnedModel = useAppSettings((s) => s.pinnedModel);
  const setPinned = useAppSettings((s) => s.setPinned);

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  /* T-05x：用户自己声明的模型（models.json）也要能在这里选到 —— 否则下拉里只有内置清单 */
  const [declared, setDeclared] = useState<Array<{ providerId: string; modelId: string }>>([]);
  const [step, setStep] = useState(0);
  /* P0-08：有可用 key 时直接从"选模型"开始（不要求重新填 key） */
  const [autoAdvanced, setAutoAdvanced] = useState(false);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [mode, setMode] = useState<ConfirmMode>("按需确认");
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  /*
   * 设置里点了「重新运行配置向导」→ 立刻把这张卡放回来（包括"刚点过稍后再说"的情况）。
   * 事件来自 `reopenSetup()`，同一份模块级订阅也负责完成/跳过的重渲染。
   */
  useEffect(
    () =>
      subscribeFirstRun(() => {
        setHidden(false);
      }),
    [],
  );

  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
  /*
   * ⭐ 2026-10-21（主人实测）：**跳步必须说清为什么，而且能退回去改**。
   *
   * 原来的行为是"只要有一家 configured 就直接 setStep(2)"，界面上第 1、2 步
   * 变成灰色删除线 —— 用户第一眼看到的是"这两步我没做过，怎么就打勾了"，
   * 而且**没有任何入口**能回到前两步（"重新运行向导"也会再被跳一次）。
   * 现在：跳步时记下原因（哪几家 / 来源），卡片顶部说清并给「重新配一遍」；
   * 前两步也允许点回去（`manual` 为 true 后不再自动跳）。
   */
  const [manual, setManual] = useState(false);
  const [skipped, setSkipped] = useState<{ labels: string[]; count: number } | null>(null);
  /** 出厂只有一家时：记下它的预填信息，填 key 那一步要如实展示"只差一条 key"。 */
  const [prefilled, setPrefilled] = useState<{ label: string; baseURL: string; models: string[] } | null>(null);
  /** 「＋ 添加自定义服务商…」开着没有（复用设置页那个小窗，形状与行为同一份）。 */
  const [addingProvider, setAddingProvider] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const list = await shell?.ai?.listProviders();
      if (list) {
        const mapped = list.map((p) => ({ ...p }));
        setProviders(mapped);
        /*
         * 有 key → 跳过第 1 步，直接选模型（只自动跳一次）。
         * ⚠️ M-02：判据从 `available` 改成 `configured` —— `~/.dsh` 里别人的 key
         * 不能再让向导以为"你已经配过了"。
         * ⚠️ 用户点过「重新配一遍」之后（`manual`）**不再自动跳**。
         */
        const configuredList = mapped.filter((p) => isConfigured(p));
        if (!manual && autoAdvanced === false && configuredList.length > 0) {
          setProvider((prev) => prev || (configuredList[0]?.id ?? ""));
          setStep((prev) => (prev === 0 ? 2 : prev));
          setAutoAdvanced(true);
          setSkipped({ labels: configuredList.map((p) => p.label), count: configuredList.length });
        } else if (!manual && autoAdvanced === false && mapped.length === 1 && mapped[0]) {
          /*
           * **出厂只有一家**（2026-10-21，主人要求"只留 DeepSeek、信息都填好、只输 key"）：
           * 没有可选的，就别让用户在一个只有一项的下拉里点一次 —— 直接预选并落到「填 key」。
           * 这一步仍在向导里（第 1 步会显示 ✓ + 预填信息），不是"偷偷跳过"。
           */
          const only = mapped[0];
          setProvider((prev) => prev || only.id);
          setStep((prev) => (prev === 0 ? 1 : prev));
          setAutoAdvanced(true);
          setPrefilled({ label: only.label, baseURL: only.baseURL ?? "", models: only.models ?? [] });
        }
      }
    } catch {
      /* 读不到就当成还没有（向导仍可用，只是清单空） */
    }
  };

  useEffect(() => {
    void refresh();
    void Promise.resolve(
      (globalThis as unknown as {
        shell?: { modelConfig?: { list?: () => Promise<{ models?: Array<{ providerId: string; modelId: string }> }> } };
      }).shell?.modelConfig?.list?.(),
    )
      .then((got) => {
        if (got?.models) setDeclared(got.models.map((m) => ({ providerId: m.providerId, modelId: m.modelId })));
      })
      .catch(() => undefined);
    void shell?.secrets
      ?.status()
      .then((s) => setEncrypted(s.encrypted))
      .catch(() => setEncrypted(null));
  }, []);

  /* 输入区已经选过的模型也算"配置好了" —— 不再反复弹这张卡（2026-10-19 主人实测） */
  const saved = readSavedRoute();
  const savedRoute = saved.provider && saved.model ? `${saved.provider}/${saved.model}` : "";
  if (hidden || !shouldShowFirstRun(loaded, pinnedModel, providers, { savedRoute })) return null;

  const chosen = providers?.find((p) => p.id === provider);
  /*
   * 可选项 = 该 provider 的内置模型 + 用户声明过的模型（去重）。
   * 只列内置的话，声明型模型（例如中转上的新模型）在这里根本选不到 ——
   * 下拉看起来是空的，下一步永远点不动。
   */
  const modelChoices = chosen
    ? [...new Set([...chosen.models, ...declared.filter((d) => d.providerId === chosen.id).map((d) => d.modelId)])]
    : [];
  const dismiss = (): void => {
    dismissFirstRun();
    setHidden(true);
  };

  const saveKey = async (): Promise<void> => {
    if (!chosen || !key.trim() || busy) return;
    setBusy(true);
    setNote("");
    try {
      const got = await shell?.secrets?.set(chosen.keyRef, key.trim());
      if (got && !got.ok) {
        setNote(got.reason ?? "没能保存这个 key");
        return;
      }
      setKey("");
      await refresh();
      setStep(2);
    } catch (error) {
      setNote(`没能保存这个 key：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * M-02：「检测到环境变量里有 X 的密钥，要用它吗？」→ 存一份到本应用。
   *
   * 主进程读环境变量、写加密库，**明文不进渲染层**。
   * 保存后环境变量仍然优先（读取顺序没变），所以提示里要如实说清。
   */
  const adoptEnv = async (refName: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const got = await shell?.secrets?.adoptEnv(refName);
      if (got && !got.ok) {
        setNote(got.reason ?? "没能存下来");
        return;
      }
      setNote("已存一份到本应用（环境变量仍在时优先用环境变量；两者都不可用时才轮到这条）");
      await refresh();
      setStep(2);
    } catch (error) {
      setNote(`没能存下来：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addWorkspace = async (): Promise<void> => {    if (busy) return;
    setBusy(true);
    try {
      const got = await shell?.workspace?.add();
      if (got?.dir) setWorkspace(got.dir);
      else setNote("没有选择目录（可以在设置里随时加）");
    } catch (error) {
      setNote(`打开目录选择器失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    if (!chosen || !model) return;
    setBusy(true);
    setNote("");
    try {
      await setPinned(`${chosen.id}/${model}`);
      saveConfirmMode(mode);
      /* F-01：完成 ≠ 跳过。写 `SETUP_DONE_KEY`，以后不再用"没配完"的理由打扰。 */
      markSetupDone();
      setHidden(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-firstrun" data-testid="wb-firstrun">
      <div className="wb-firstrun-card">
        <header>
          <b>先把环境配起来（大约 1 分钟）</b>
          <button type="button" className="wb-firstrun-skip" data-testid="wb-firstrun-skip" onClick={dismiss}>
            稍后再说
          </button>
        </header>

        {/*
          跳步必须**说清为什么**（2026-10-21 主人实测）：
          他看到第 1、2 步被划掉，却完全不记得自己配过 —— 因为那条 key 是
          以前用 CLI/桌面配的、留在 ~/.ding 里，重装软件不会删它。
          这里把来源说出来，并给一个明确的「重新配一遍」。
        */}
        {skipped && !manual && step > 1 ? (
          <div className="wb-firstrun-notice" data-testid="wb-firstrun-skipped">
            <span>
              已跳过前两步：本机已有 {skipped.count} 家的密钥（本应用已保存，来自 <code>~/.ding</code>）——
              {skipped.labels.slice(0, 3).join(" / ")}
              {skipped.count > 3 ? ` 等 ${skipped.count} 家` : ""}。
            </span>
            <button
              type="button"
              data-testid="wb-firstrun-restart"
              onClick={() => {
                setManual(true);
                setSkipped(null);
                setStep(0);
                setModel("");
              }}
            >
              我要重新配一遍
            </button>
          </div>
        ) : null}

        <ol className="wb-firstrun-steps">
          <li data-active={step === 0} data-done={step > 0}>
            <div className="wb-firstrun-title">
              ① 选一家模型服务
              {step > 0 && provider ? (
                <button
                  type="button"
                  className="wb-firstrun-back"
                  data-testid="wb-firstrun-back-provider"
                  onClick={() => {
                    setManual(true);
                    setSkipped(null);
                    setStep(0);
                  }}
                >
                  换一家
                </button>
              ) : null}
            </div>
            {step > 0 && provider ? (
              <div className="wb-firstrun-hint" data-testid="wb-firstrun-picked">
                已选：{providers?.find((p) => p.id === provider)?.label ?? provider}
                {prefilled ? "（地址与模型已预填）" : ""}
              </div>
            ) : null}
            {step === 0 ? (
              <div className="wb-firstrun-body">
                <select
                  data-testid="wb-firstrun-provider"
                  value={provider}
                  onChange={(e) => {
                    /*
                     * 「＋ 添加自定义服务商…」：第一次配置时用户最需要它，却没入口
                     * （2026-10-22 主人问"没法自定义服务商吗"）。选它**不改变已选值**，
                     * 只把添加小窗打开；加完自动选中新那家并跳到"选模型"。
                     */
                    if (e.target.value === CUSTOM_PROVIDER_VALUE) {
                      setAddingProvider(true);
                      return;
                    }
                    setProvider(e.target.value);
                    setModel("");
                  }}
                >
                  <option value="">选一家…</option>
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {isConfigured(p) ? "（已有 key）" : p.keySource === "env" ? "（环境变量里有 key）" : ""}
                    </option>
                  ))}
                  <option value={CUSTOM_PROVIDER_VALUE}>＋ 添加自定义服务商…</option>
                </select>
                <button
                  type="button"
                  data-testid="wb-firstrun-provider-next"
                  disabled={!provider}
                  onClick={() => setStep(isConfigured(chosen) ? 2 : 1)}
                >
                  下一步
                </button>
              </div>
            ) : null}
          </li>

          <li data-active={step === 1} data-done={step > 1}>
            <div className="wb-firstrun-title">
              ② 填 key
              {step > 1 && chosen ? (
                <button
                  type="button"
                  className="wb-firstrun-back"
                  data-testid="wb-firstrun-back-key"
                  onClick={() => {
                    setManual(true);
                    setSkipped(null);
                    setStep(1);
                  }}
                >
                  重新填一条
                </button>
              ) : null}
            </div>
            {step > 1 && chosen ? (
              <div className="wb-firstrun-hint" data-testid="wb-firstrun-key-skipped">
                已跳过：这一家已有本应用保存的密钥（<code>{chosen.keyRef}</code>）—— 不想用它就点上面的「重新填一条」。
              </div>
            ) : null}
            {step === 1 && chosen ? (
              <div className="wb-firstrun-body">
                {/*
                  出厂只有一家时，第 1 步已经把 provider 预选好了 —— 这里如实说清
                  "地址与模型都填好了，只差一条 key"（主人 2026-10-21 的要求）。
                */}
                {prefilled && prefilled.label === chosen.label ? (
                  <div className="wb-firstrun-hint" data-testid="wb-firstrun-prefilled">
                    渠道信息已填好：<code>{prefilled.baseURL}</code>
                    {prefilled.models.length ? `　模型：${prefilled.models.slice(0, 4).join(" / ")}` : ""}
                    　—— 你只需要下面这一条 key。
                  </div>
                ) : null}
                {/*
                  M-02：环境变量里已经有这条 key 时，给一条**明确的快捷路径**。
                  值不经过渲染层（主进程自己读、自己写加密库），界面上永远看不到明文。
                */}
                {chosen.keySource === "env" ? (
                  <div className="wb-firstrun-hint" data-testid="wb-firstrun-env-hint">
                    检测到环境变量 <code>{chosen.keyRef}</code> 里有密钥 —— 要用它吗？
                    <button
                      type="button"
                      data-testid="wb-firstrun-env-adopt"
                      disabled={busy}
                      onClick={() => void adoptEnv(chosen.keyRef)}
                    >
                      存一份到本应用
                    </button>
                  </div>
                ) : null}
                {chosen.keySource === "legacy" ? (
                  <div className="wb-firstrun-hint" data-testid="wb-firstrun-legacy-hint">
                    这条密钥来自旧目录 <code>~/.dsh</code>（别的程序也在用）—— 建议在这里另存一条，
                    以后关掉旧文件也不受影响。
                  </div>
                ) : null}
                <input
                  data-testid="wb-firstrun-key"
                  type="password"
                  autoComplete="off"
                  placeholder={`${chosen.keyRef}（只保存在本机）`}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button type="button" data-testid="wb-firstrun-key-save" disabled={!key.trim() || busy} onClick={() => void saveKey()}>
                  {busy ? "保存中…" : "保存 key"}
                </button>
                <div className="wb-firstrun-hint">
                  {encrypted === true
                    ? "会经系统密钥保护加密后落盘（DPAPI / Keychain / libsecret）。"
                    : encrypted === false
                      ? "这台机器上系统密钥保护不可用 —— 保存会被拒绝；可以先设环境变量再用。"
                      : "正在确认这台机器的密钥保护能力…"}
                </div>
              </div>
            ) : null}
          </li>

          <li data-active={step === 2} data-done={step > 2}>
            <div className="wb-firstrun-title">③ 选模型 + 工作区</div>
            {step === 2 && chosen ? (
              <div className="wb-firstrun-body">
                {/*
                  这家没有可选模型时，必须能**换一家**；否则用户卡在这一步，
                  卡片每次启动都回来（2026-10-19 主人实测的那种"一直都有"）。
                */}
                {modelChoices.length === 0 ? (
                  <select
                    data-testid="wb-firstrun-provider-switch"
                    value={provider}
                    onChange={(e) => {
                      if (e.target.value === CUSTOM_PROVIDER_VALUE) {
                        setAddingProvider(true);
                        return;
                      }
                      setProvider(e.target.value);
                      setModel("");
                    }}
                  >
                    {(providers ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}{isConfigured(p) ? "（已有 key）" : p.keySource === "env" ? "（环境变量里有 key）" : ""}
                      </option>
                    ))}
                    <option value={CUSTOM_PROVIDER_VALUE}>＋ 添加自定义服务商…</option>
                  </select>
                ) : null}
                <select data-testid="wb-firstrun-model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">选一个模型…</option>
                  {modelChoices.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                {modelChoices.length === 0 ? (
                  <div className="wb-firstrun-hint" data-testid="wb-firstrun-no-models">
                    这家没有可选模型 —— 上面换一家，或去「设置 → 模型」里添加。
                  </div>
                ) : null}
                <button type="button" data-testid="wb-firstrun-workspace" disabled={busy} onClick={() => void addWorkspace()}>
                  {workspace ? "换一个目录" : "选工作目录"}
                </button>
                {workspace ? <code className="wb-firstrun-path">{workspace}</code> : null}
                <button type="button" data-testid="wb-firstrun-model-next" disabled={!model} onClick={() => setStep(3)}>
                  下一步
                </button>
                <div className="wb-firstrun-hint">
                  工作目录可以跳过 —— 之后在 设置 → 通用 → 工作目录 里加（点「稍后再说」也能从这里重新打开向导）。
                </div>
              </div>
            ) : null}
          </li>

          <li data-active={step === 3} data-done={false}>
            <div className="wb-firstrun-title">④ 选权限档位</div>
            {step === 3 ? (
              <div className="wb-firstrun-body">
                <select
                  data-testid="wb-firstrun-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ConfirmMode)}
                >
                  {CONFIRM_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button type="button" data-testid="wb-firstrun-finish" disabled={busy} onClick={() => void finish()}>
                  {busy ? "保存中…" : "开始使用"}
                </button>
                <div className="wb-firstrun-hint">
                  默认「按需确认」：读放行，写文件/跑命令/外部连接器先问你。
                </div>
              </div>
            ) : null}
          </li>
        </ol>
        {note ? (
          <div className="wb-firstrun-note" data-testid="wb-firstrun-note">
            {note}
          </div>
        ) : null}
      </div>

      {/*
        自定义服务商（2026-10-22 主人问"没法自定义服务商吗"）：
        复用设置页那个小窗（URL → Key → 模型），**形状与行为同一份**。
        加完自动选中新那家并跳到「③ 选模型」—— 那条路已经有 key 了，不必再填。
      */}
      {addingProvider ? (
        <NewProviderDialog
          bridge={(shell?.providers ?? {}) as ShellBridge["providers"]}
          onDone={(added, providerId) => {
            setAddingProvider(false);
            if (!added) return;
            /* 手动加过之后不再自动跳步（用户是主动选的这家） */
            setManual(true);
            setSkipped(null);
            void refresh().then(() => {
              if (providerId) setProvider(providerId);
              setStep(2);
            });
          }}
        />
      ) : null}
    </div>
  );
}
