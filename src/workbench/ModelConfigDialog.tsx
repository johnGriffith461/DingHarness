import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { EFFORT_LABEL, REASONING_EFFORTS, isReasoningEffort } from "@engine/runtime/protocols/reasoning";
import type { ModelConfigPatchWire, ModelConfigSaveInput } from "@shared/modelConfigWire";
import type { ShellBridge } from "@shared/ipc";
import type { EndpointModelCapsWire } from "@shared/providerWire";

import { reasoningRowVisible } from "./modelForm";
import { prefillFor } from "./modelPrefill";

/**
 * **「添加 / 编辑模型」小窗**（M-04，2026-10-21 重做）。
 *
 * ## 字段顺序（主人给的，别改）
 *
 * 模型 → 最大上下文 → 最大输出 → 输入类型 → 思考强度；高级默认收起。
 *
 * ## 与上一版的三处差别
 *
 * 1. **小窗**：`wb-modal-mask` + `wb-modal-card`（640px），不再整页覆盖；
 * 2. **模型是下拉**（数据源 = 该 provider 拉回来的清单），最后一项是「手动输入…」；
 * 3. **窗口/输出/模态自动预填**，下面一行小字写来源（目录 / 端点 / 默认 / 已手动修改）。
 *
 * ## 刻意保留的东西
 *
 * 「高级」里的能力一个都没删：结构化输出、原生联网、会话中系统消息、
 * 推理参数映射、输出参数映射、自定义推理档位。它们是既有能力，不是历史包袱。
 */

type Props = {
  bridge: ShellBridge["modelConfig"];
  providerId: string;
  providerLabel: string;
  /** 协议：用于保存前的能力校验提示。 */
  protocol: string;
  /** 编辑已有模型时传入；添加时为空。 */
  editing?: {
    modelId: string;
    contextWindow: number;
    maxOutputTokens: number;
    inputFormat: {
      supportsText: boolean;
      supportsImage: boolean;
      supportsVideo: boolean;
      supportsAudio: boolean;
      supportsPdf: boolean;
    };
    supportsToolCall: boolean;
    supportsJsonSchemaOutput: boolean;
    supportsNativeWebSearch: boolean;
    supportsMidConversationSystem: boolean;
    reasoningLevels: string[];
    reasoningMap: string;
    maxOutputMap: string;
  };
  /** 该 provider 已拉取的模型名（下拉的数据源）。 */
  models?: string[];
  /** 端点自报能力（按模型名）。 */
  fetched?: Record<string, EndpointModelCapsWire>;
  /** 未拉取时给一颗「拉取模型」；拉完返回新的清单。 */
  onPullModels?: () => Promise<string[]>;
  /** 新增态的预选模型（详情行的「声明」按钮传进来）。 */
  initialModelId?: string;
  onClose: (saved: boolean) => void;
};

const MODALITIES = [
  { key: "supportsImage", label: "图片" },
  { key: "supportsVideo", label: "视频" },
  { key: "supportsAudio", label: "音频" },
  { key: "supportsPdf", label: "PDF" },
] as const;

const CAPABILITIES = [
  { key: "supportsJsonSchemaOutput", label: "结构化输出", hint: "要求模型按给定 JSON Schema 回答" },
  { key: "supportsNativeWebSearch", label: "原生联网搜索", hint: "由 provider 服务端执行检索（OpenAI 兼容协议不支持）" },
  { key: "supportsMidConversationSystem", label: "对话中系统消息", hint: "允许在消息流中间插入 system 指令" },
] as const;

const MANUAL = "__manual__";

export function ModelConfigDialog({
  bridge,
  providerId,
  providerLabel,
  protocol,
  editing,
  models = [],
  fetched,
  onPullModels,
  initialModelId,
  onClose,
}: Props) {
  const [modelId, setModelId] = useState(editing?.modelId ?? initialModelId ?? "");
  const [options, setOptions] = useState<string[]>(() => {
    const list = [...models];
    if (editing?.modelId && !list.includes(editing.modelId)) list.unshift(editing.modelId);
    return list;
  });
  const [manual, setManual] = useState(!editing && models.length === 0);
  const [pulling, setPulling] = useState(false);
  const [contextWindow, setContextWindow] = useState(editing?.contextWindow ? String(editing.contextWindow) : "");
  const [maxOutput, setMaxOutput] = useState(editing?.maxOutputTokens ? String(editing.maxOutputTokens) : "");
  const [sourceNote, setSourceNote] = useState(editing ? "已手动修改" : "");
  const [modalities, setModalities] = useState<Record<string, boolean>>({
    supportsImage: editing?.inputFormat.supportsImage ?? false,
    supportsVideo: editing?.inputFormat.supportsVideo ?? false,
    supportsAudio: editing?.inputFormat.supportsAudio ?? false,
    supportsPdf: editing?.inputFormat.supportsPdf ?? false,
  });
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    supportsJsonSchemaOutput: editing?.supportsJsonSchemaOutput ?? false,
    supportsNativeWebSearch: editing?.supportsNativeWebSearch ?? false,
    supportsMidConversationSystem: editing?.supportsMidConversationSystem ?? false,
  });
  const [reasoningLevels, setReasoningLevels] = useState<string[]>(editing?.reasoningLevels ?? []);
  const [reasoningDraft, setReasoningDraft] = useState("");
  const [reasoningMap, setReasoningMap] = useState(editing?.reasoningMap ?? "");
  const [maxOutputMap, setMaxOutputMap] = useState(editing?.maxOutputMap ?? "");
  const [reasoningKnown, setReasoningKnown] = useState((editing?.reasoningLevels.length ?? 0) > 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<null | { ok: boolean; text: string }>(null);
  const [probing, setProbing] = useState(false);
  const [mapCheck, setMapCheck] = useState<{ reasoning?: string; output?: string }>({});

  /* 参数映射失焦时就校验：别等到保存才一次性报一堆错 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: { reasoning?: string; output?: string } = {};
      if (reasoningMap.trim()) {
        const result = await bridge.validateMap(reasoningMap);
        if (!result.ok) next.reasoning = result.error;
      }
      if (maxOutputMap.trim()) {
        const result = await bridge.validateMap(maxOutputMap);
        if (!result.ok) next.output = result.error;
      }
      if (!cancelled) setMapCheck(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, reasoningMap, maxOutputMap]);

  /**
   * 选中模型之后**自动带出**能力（新增态才做；编辑态以已有声明为准）。
   *
   * 依赖只有 `modelId`：用户手动改完窗口/输出不会被下一次渲染覆盖回去。
   */
  useEffect(() => {
    if (editing) return;
    const id = modelId.trim();
    if (!id) {
      setSourceNote("");
      return;
    }
    const got = prefillFor(providerId, id, fetched?.[id]);
    if (!got) return;
    setContextWindow(String(got.contextWindow));
    setMaxOutput(String(got.maxOutput));
    setModalities({
      supportsImage: got.inputModalities.includes("image"),
      supportsVideo: got.inputModalities.includes("video"),
      supportsAudio: got.inputModalities.includes("audio"),
      supportsPdf: got.inputModalities.includes("pdf"),
    });
    setReasoningKnown(got.reasoning);
    setSourceNote(got.label);
    setErrors((prev) => ({ ...prev, modelId: "", contextWindow: "", maxOutput: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换模型时预填一次（手动修改要保留）
  }, [modelId]);

  const markEdited = (): void => {
    if (!editing) setSourceNote("已手动修改");
  };

  const pull = async (): Promise<void> => {
    if (!onPullModels) return;
    setPulling(true);
    setErrors((prev) => ({ ...prev, fetch: "" }));
    try {
      const list = await onPullModels();
      setOptions(list);
      setManual(list.length === 0);
      if (list.length) {
        setModelId(list[0]!);
        setManual(false);
      }
      if (!list.length) setErrors((prev) => ({ ...prev, fetch: "对方返回的模型清单是空的" }));
    } catch (error) {
      setErrors((prev) => ({ ...prev, fetch: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPulling(false);
    }
  };

  const addLevel = (): void => {
    const value = reasoningDraft.trim();
    if (!value) return;
    if (reasoningLevels.includes(value)) {
      setErrors((prev) => ({ ...prev, reasoning: "档位不能重复" }));
      return;
    }
    setReasoningLevels([...reasoningLevels, value]);
    setReasoningDraft("");
    setErrors((prev) => ({ ...prev, reasoning: "" }));
    setReasoningKnown(true);
  };

  const effort = reasoningLevels.length === 1 && isReasoningEffort(reasoningLevels[0]) ? reasoningLevels[0] : "";
  const setEffort = (next: string): void => {
    setReasoningLevels(next ? [next] : []);
    markEdited();
  };

  const save = async () => {
    const next: Record<string, string> = {};
    if (!modelId.trim()) next.modelId = "必填";
    const windowValue = Number(contextWindow);
    if (!contextWindow.trim() || !Number.isInteger(windowValue) || windowValue <= 0) {
      next.contextWindow = "必填，正整数";
    }
    const outValue = maxOutput.trim() ? Number(maxOutput) : undefined;
    if (maxOutput.trim() && (!Number.isInteger(outValue!) || outValue! <= 0)) {
      next.maxOutput = "正整数";
    }
    if (outValue !== undefined && Number.isInteger(windowValue) && outValue >= windowValue) {
      next.maxOutput = "不能大于等于窗口（那样历史就没位置了）";
    }
    if (mapCheck.reasoning) next.reasoningMap = mapCheck.reasoning;
    if (mapCheck.output) next.maxOutputMap = mapCheck.output;
    if (reasoningLevels.length === 0 && reasoningMap.trim()) {
      next.reasoning = "写了推理映射但没声明档位：映射没有输入值可用";
    }
    if (capabilities.supportsNativeWebSearch && protocol === "openai-compatible") {
      next.supportsNativeWebSearch = "OpenAI 兼容协议没有原生联网搜索（换 Anthropic / Google 原生协议）";
    }
    if (modalities.supportsVideo && protocol === "anthropic") {
      next.supportsVideo = "Anthropic 协议不接受视频输入";
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    const patch: ModelConfigPatchWire = {
      contextWindow: windowValue,
      ...(outValue === undefined ? {} : { maxOutputTokens: outValue }),
      inputFormat: {
        supportsText: true,
        supportsImage: modalities.supportsImage,
        supportsVideo: modalities.supportsVideo,
        supportsAudio: modalities.supportsAudio,
        supportsPdf: modalities.supportsPdf,
      },
      supportsToolCall: true,
      ...capabilities,
      ...(reasoningLevels.length ? { reasoningLevels } : {}),
      ...(reasoningMap.trim() ? { reasoningMap } : {}),
      ...(maxOutputMap.trim() ? { maxOutputMap } : {}),
    } as ModelConfigPatchWire;

    setBusy(true);
    const input: ModelConfigSaveInput = {
      providerId,
      modelId: modelId.trim(),
      patch,
      manual: true,
    };
    const result = await bridge.save(input);
    setBusy(false);
    if (!result.ok) {
      setErrors({ form: result.error });
      return;
    }
    onClose(true);
  };

  const testConnection = async (): Promise<void> => {
    if (!modelId.trim()) {
      setErrors((prev) => ({ ...prev, modelId: "先填模型 ID 再测" }));
      return;
    }
    setProbing(true);
    setProbe(null);
    const result = await bridge.probe(providerId, modelId.trim());
    setProbing(false);
    setProbe(
      result.ok
        ? {
            ok: true,
            text:
              `连通（${result.elapsedMs}ms）：${result.reply}` +
              (result.usage
                ? `　用量 输入 ${result.usage.inputTokens ?? "?"} / 输出 ${result.usage.outputTokens ?? "?"} token`
                : ""),
          }
        : { ok: false, text: `不通（${result.elapsedMs}ms）：${result.error}` },
    );
  };

  const showReasoning = reasoningRowVisible({ reasoning: reasoningKnown || reasoningLevels.length > 0 });

  return (
    <div className="wb-modal-mask" data-testid="wb-modelconfig-mask">
      <div
        className="wb-modal wb-modal-card wb-mset-dialog-wide"
        data-testid="wb-modelconfig-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑模型" : "添加模型"}
      >
        <div className="wb-modal-head">
          <strong>{editing ? "编辑模型" : "添加模型"}</strong>
          <span className="wb-card-desc">{providerLabel}</span>
        </div>

        {/* ① 模型 */}
        <div className="wb-mset-field" data-testid="wb-modelconfig-field-model">
          <label htmlFor="wb-modelconfig-model-select">模型 *</label>
          {editing ? (
            <input className="wb-card-input" data-testid="wb-modelconfig-id" value={modelId} disabled />
          ) : options.length > 0 && !manual ? (
            <select
              id="wb-modelconfig-model-select"
              className="wb-card-input"
              data-testid="wb-modelconfig-model-select"
              value={options.includes(modelId) ? modelId : ""}
              onChange={(event) => {
                const value = event.target.value;
                if (value === MANUAL) {
                  setManual(true);
                  setModelId("");
                  return;
                }
                setModelId(value);
              }}
            >
              <option value="">选一个模型…</option>
              {options.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              <option value={MANUAL}>手动输入…</option>
            </select>
          ) : (
            <input
              id="wb-modelconfig-model-select"
              className="wb-card-input"
              data-testid="wb-modelconfig-id"
              spellCheck={false}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="deepseek-v4.1-flash-1017"
            />
          )}
          <div className="wb-mset-rowline">
            {onPullModels ? (
              <button className="wb-page-btn" data-testid="wb-modelconfig-pull" disabled={pulling} onClick={() => void pull()}>
                {pulling ? "拉取中…" : "拉取模型"}
              </button>
            ) : null}
            {manual && options.length > 0 ? (
              <button
                className="wb-page-btn"
                data-testid="wb-modelconfig-use-list"
                onClick={() => {
                  setManual(false);
                  setModelId("");
                }}
              >
                从清单里选
              </button>
            ) : null}
          </div>
          {errors.fetch ? <div className="wb-card-note wb-note-bad">{errors.fetch}</div> : null}
          {errors.modelId ? <div className="wb-card-note wb-note-bad">{errors.modelId}</div> : null}
        </div>

        {/* ② 最大上下文 */}
        <div className="wb-mset-field" data-testid="wb-modelconfig-field-context">
          <label htmlFor="wb-modelconfig-window">最大上下文 *</label>
          <input
            id="wb-modelconfig-window"
            className="wb-card-input"
            data-testid="wb-modelconfig-window"
            type="number"
            value={contextWindow}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setContextWindow(event.target.value);
              markEdited();
            }}
            placeholder="128000"
          />
          {sourceNote ? (
            <div className="wb-card-note" data-testid="wb-modelconfig-source">
              来源：{sourceNote}
            </div>
          ) : null}
          {errors.contextWindow ? <div className="wb-card-note wb-note-bad">{errors.contextWindow}</div> : null}
        </div>

        {/* ③ 最大输出 */}
        <div className="wb-mset-field" data-testid="wb-modelconfig-field-output">
          <label htmlFor="wb-modelconfig-max-output">最大输出</label>
          <input
            id="wb-modelconfig-max-output"
            className="wb-card-input"
            data-testid="wb-modelconfig-max-output"
            type="number"
            value={maxOutput}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setMaxOutput(event.target.value);
              markEdited();
            }}
            placeholder="8192（留空 = 按 provider 默认）"
          />
          <div className="wb-card-note">留空 = 按 provider 默认。</div>
          {errors.maxOutput ? <div className="wb-card-note wb-note-bad">{errors.maxOutput}</div> : null}
        </div>

        {/* ④ 输入类型 */}
        <div className="wb-mset-field" data-testid="wb-modelconfig-field-modalities">
          <label>输入类型</label>
          <span className="wb-modelconfig-chips">
            <em className="wb-modelconfig-chip is-on">文本</em>
            {MODALITIES.map((item) => (
              <button
                key={item.key}
                className={`wb-modelconfig-chip${modalities[item.key] ? " is-on" : ""}`}
                data-testid={`wb-modelconfig-${item.key}`}
                onClick={() => {
                  setModalities({ ...modalities, [item.key]: !modalities[item.key] });
                  markEdited();
                }}
              >
                {item.label}
              </button>
            ))}
          </span>
          {errors.supportsVideo ? <div className="wb-card-note wb-note-bad">{errors.supportsVideo}</div> : null}
        </div>

        {/* ⑤ 思考强度（模型不支持时整行不出现） */}
        {showReasoning ? (
          <div className="wb-mset-field" data-testid="wb-modelconfig-field-reasoning">
            <label>思考强度</label>
            <span className="wb-modelconfig-chips">
              <button
                className={`wb-modelconfig-chip${effort === "" ? " is-on" : ""}`}
                data-testid="wb-modelconfig-effort-none"
                onClick={() => setEffort("")}
              >
                无
              </button>
              {REASONING_EFFORTS.map((level) => (
                <button
                  key={level}
                  className={`wb-modelconfig-chip${effort === level ? " is-on" : ""}`}
                  data-testid={`wb-modelconfig-effort-${level}`}
                  onClick={() => setEffort(level)}
                >
                  {EFFORT_LABEL[level]}
                </button>
              ))}
            </span>
          </div>
        ) : null}

        <details className="wb-mset-adv" data-testid="wb-modelconfig-advanced">
          <summary>高级</summary>

          {CAPABILITIES.map((item) => (
            <div className="wb-card-row" key={item.key}>
              <span className="wb-card-label">{item.label}</span>
              <span className="wb-card-desc">{item.hint}</span>
              <button
                className={`wb-modelconfig-chip${capabilities[item.key] ? " is-on" : ""}`}
                data-testid={`wb-modelconfig-${item.key}`}
                onClick={() => setCapabilities({ ...capabilities, [item.key]: !capabilities[item.key] })}
              >
                {capabilities[item.key] ? "已开启" : "关闭"}
              </button>
            </div>
          ))}
          {errors.supportsNativeWebSearch ? (
            <div className="wb-card-note wb-note-bad">{errors.supportsNativeWebSearch}</div>
          ) : null}

          <div className="wb-card-row">
            <span className="wb-card-label">推理等级</span>
            <span className="wb-card-desc">从低到高；输入区那颗选择器就按这个列表显示</span>
            <span className="wb-modelconfig-chips">
              {reasoningLevels.map((level, index) => (
                <button
                  key={`${level}-${index}`}
                  className="wb-modelconfig-chip is-on"
                  data-testid={`wb-modelconfig-level-${level}`}
                  title="点一下删掉"
                  onClick={() => setReasoningLevels(reasoningLevels.filter((_, i) => i !== index))}
                >
                  {level} ×
                </button>
              ))}
              <input
                className="wb-card-input wb-modelconfig-levelinput"
                data-testid="wb-modelconfig-level-draft"
                value={reasoningDraft}
                onChange={(event) => setReasoningDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addLevel();
                }}
                placeholder="加一档"
              />
              <button className="wb-page-btn" data-testid="wb-modelconfig-level-add" onClick={addLevel}>
                添加
              </button>
            </span>
          </div>
          {errors.reasoning ? <div className="wb-card-note wb-note-bad">{errors.reasoning}</div> : null}

          <div className="wb-card-row">
            <span className="wb-card-label">推理参数映射</span>
            <span className="wb-card-desc">
              JSON 对象或规则表；<code>{"{{reasoningLevel}}"}</code> 会被替换成这一轮的档位，结果合并进请求体
            </span>
            <textarea
              className="wb-card-input wb-modelconfig-map"
              data-testid="wb-modelconfig-reasoning-map"
              rows={3}
              value={reasoningMap}
              onChange={(event) => setReasoningMap(event.target.value)}
              placeholder={'{"reasoning": {"effort": "{{reasoningLevel}}"}}'}
            />
          </div>
          {mapCheck.reasoning ? (
            <div className="wb-card-note wb-note-bad" data-testid="wb-modelconfig-reasoning-map-error">
              {mapCheck.reasoning}
            </div>
          ) : null}

          <div className="wb-card-row">
            <span className="wb-card-label">输出参数映射</span>
            <span className="wb-card-desc">
              各家认的字段名不一样（<code>max_tokens</code> / <code>max_completion_tokens</code>），在这里改
            </span>
            <textarea
              className="wb-card-input wb-modelconfig-map"
              data-testid="wb-modelconfig-output-map"
              rows={3}
              value={maxOutputMap}
              onChange={(event) => setMaxOutputMap(event.target.value)}
              placeholder={'{"max_completion_tokens": "{{maxOutputTokens}}"}'}
            />
          </div>
          {mapCheck.output ? (
            <div className="wb-card-note wb-note-bad" data-testid="wb-modelconfig-output-map-error">
              {mapCheck.output}
            </div>
          ) : null}
        </details>

        {errors.form ? <div className="wb-card-note wb-note-bad">{errors.form}</div> : null}
        {probe ? (
          <div className={`wb-card-note${probe.ok ? "" : " wb-note-bad"}`} data-testid="wb-modelconfig-test-result">
            {probe.ok ? <Check size={13} /> : <X size={13} />}
            {probe.text}
          </div>
        ) : null}

        <div className="wb-modal-foot">
          <button className="wb-page-btn" data-testid="wb-modelconfig-cancel" onClick={() => onClose(false)}>
            取消
          </button>
          <button
            className="wb-page-btn"
            data-testid="wb-modelconfig-test"
            disabled={probing}
            onClick={() => void testConnection()}
          >
            {probing ? "测试中…" : "测试连通"}
          </button>
          <button
            className="wb-page-btn wb-page-btn-primary"
            data-testid="wb-modelconfig-save"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
