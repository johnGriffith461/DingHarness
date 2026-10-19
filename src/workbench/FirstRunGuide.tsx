import { useEffect, useState } from "react";
import type { ProviderInfo } from "@engine/runtime/providers";
import { CONFIRM_MODES, type ConfirmMode } from "@shared/ipc";

import { useAppSettings } from "./appSettings";
import { saveConfirmMode } from "./confirmMode";
import { readSavedRoute } from "@/ai/route";

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
 * 该不该弹首跑向导。
 *
 * @param loaded 设置载入了没有
 * @param pinnedModel 钉住的默认通道
 * @param providers provider 清单（还没读到时给 `null`）
 */
export function shouldShowFirstRun(
  loaded: boolean,
  pinnedModel: string,
  providers: readonly ProviderInfo[] | null,
  opts: { savedRoute?: string } = {},
): boolean {
  if (!loaded || !providers) return false;
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
  try {
    return localStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return true;
  }
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

  const shell = (globalThis as unknown as { shell?: import("@shared/ipc").ShellBridge }).shell;

  const refresh = async (): Promise<void> => {
    try {
      const list = await shell?.ai?.listProviders();
      if (list) {
        const mapped = list.map((p) => ({ ...p }));
        setProviders(mapped);
        /* 有 key → 跳过第 1 步，直接选模型（只自动跳一次） */
        if (autoAdvanced === false && mapped.some((p) => p.available)) {
          setProvider((prev) => prev || (mapped.find((p) => p.available)?.id ?? ""));
          setStep((prev) => (prev === 0 ? 2 : prev));
          setAutoAdvanced(true);
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
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* 存不进去就只关这一次 */
    }
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

  const addWorkspace = async (): Promise<void> => {
    if (busy) return;
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
      dismiss();
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
            先自己配
          </button>
        </header>
        <ol className="wb-firstrun-steps">
          <li data-active={step === 0} data-done={step > 0}>
            <div className="wb-firstrun-title">① 选一家模型服务</div>
            {step === 0 ? (
              <div className="wb-firstrun-body">
                <select
                  data-testid="wb-firstrun-provider"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setModel("");
                  }}
                >
                  <option value="">选一家…</option>
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.available ? "（已有 key）" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="wb-firstrun-provider-next"
                  disabled={!provider}
                  onClick={() => setStep(chosen?.available ? 2 : 1)}
                >
                  下一步
                </button>
              </div>
            ) : null}
          </li>

          <li data-active={step === 1} data-done={step > 1}>
            <div className="wb-firstrun-title">② 填 key</div>
            {step === 1 && chosen ? (
              <div className="wb-firstrun-body">
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
                      setProvider(e.target.value);
                      setModel("");
                    }}
                  >
                    {(providers ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}{p.available ? "（已有 key）" : ""}
                      </option>
                    ))}
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
                <div className="wb-firstrun-hint">工作目录可以跳过，之后在设置里加。</div>
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
    </div>
  );
}
