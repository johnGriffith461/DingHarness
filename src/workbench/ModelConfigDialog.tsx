import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import type { ModelConfigPatchWire, ModelConfigSaveInput } from "@shared/modelConfigWire";
import type { ShellBridge } from "@shared/ipc";

/**
 * **「添加模型 / 编辑模型」表单**（T0）。
 *
 * ## 这一版解决什么
 *
 * 以前接一个新中转站的模型，我们没登记就只按 20k 保守默认跑 ——
 * 界面上写着「未登记」，用户却没有任何办法改。现在可以自己声明：
 * 窗口、最大输出、输入模态、能力、推理档位、参数映射。
 *
 * ## 几条刻意的取舍
 *
 * 1. **窗口必填，不预填一个数字**：填小了等于没用，填大了会打爆上游。
 *    空着 + 必填提示，比替用户猜一个"看起来合理"的值诚实。
 * 2. **参数映射不用表达式语言**：写 JSON 对象（改字段名）或规则表（按档位分支）。
 *    真实需求只有这两种，教用户一门语言来改一个键名不划算。
 * 3. **校验就地报错**：哪个字段不合法就标哪个，不弹一个笼统的"保存失败"。
 * 4. **没有"暂未支持"的控件**：勾了原生联网而协议不支持时，保存直接拒绝并说清原因 ——
 *    那是"发请求时静默不生效"的唯一拦住它的地方。
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
    inputFormat: { supportsText: boolean; supportsImage: boolean; supportsVideo: boolean; supportsAudio: boolean; supportsPdf: boolean };
    supportsToolCall: boolean;
    supportsJsonSchemaOutput: boolean;
    supportsNativeWebSearch: boolean;
    supportsMidConversationSystem: boolean;
    reasoningLevels: string[];
    reasoningMap: string;
    maxOutputMap: string;
  };
  onClose: (saved: boolean) => void;
};

const MODALITIES = [
  { key: "supportsImage", label: "图片" },
  { key: "supportsPdf", label: "PDF" },
  { key: "supportsVideo", label: "视频" },
] as const;

const CAPABILITIES = [
  { key: "supportsJsonSchemaOutput", label: "结构化输出", hint: "要求模型按给定 JSON Schema 回答" },
  { key: "supportsNativeWebSearch", label: "原生联网搜索", hint: "由 provider 服务端执行检索（OpenAI 兼容协议不支持）" },
  { key: "supportsMidConversationSystem", label: "对话中系统消息", hint: "允许在消息流中间插入 system 指令" },
] as const;

export function ModelConfigDialog({ bridge, providerId, providerLabel, protocol, editing, onClose }: Props) {
  const [modelId, setModelId] = useState(editing?.modelId ?? "");
  const [contextWindow, setContextWindow] = useState(
    editing?.contextWindow ? String(editing.contextWindow) : "",
  );
  const [maxOutput, setMaxOutput] = useState(
    editing?.maxOutputTokens ? String(editing.maxOutputTokens) : "",
  );
  const [modalities, setModalities] = useState<Record<string, boolean>>({
    supportsImage: editing?.inputFormat.supportsImage ?? false,
    supportsPdf: editing?.inputFormat.supportsPdf ?? false,
    supportsVideo: editing?.inputFormat.supportsVideo ?? false,
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /** 连通性测试的结果（null = 还没测过） */
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

  const addLevel = () => {
    const value = reasoningDraft.trim();
    if (!value) return;
    if (reasoningLevels.includes(value)) {
      setErrors((prev) => ({ ...prev, reasoning: "档位不能重复" }));
      return;
    }
    setReasoningLevels([...reasoningLevels, value]);
    setReasoningDraft("");
    setErrors((prev) => ({ ...prev, reasoning: "" }));
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
        supportsAudio: false,
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

  /**
   * **测试连通**：真发一轮最小请求。
   *
   * 为什么值得单独一个按钮：表单里填的东西全对、照样连不通的情况太常见 ——
   * 密钥错、通道拒绝、模型名拼错、输出上限比上游允许的大。
   * 只有真发一次才知道**现在**能不能用。
   */
  const testConnection = async () => {
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

  return (
    <div className="wb-setfull" data-testid="wb-modelconfig-dialog" role="dialog" aria-label="添加模型">
      <div className="wb-setfull-head">
        <strong>{editing ? "编辑模型" : "添加模型"}</strong>
        <span className="wb-card-desc">{providerLabel}</span>
      </div>

      <div className="wb-card">
        <div className="wb-card-row">
          <span className="wb-card-label">模型 ID</span>
          <span className="wb-card-desc">对方 API 里用的名字，要一字不差</span>
          <input
            className="wb-card-input"
            data-testid="wb-modelconfig-id"
            spellCheck={false}
            value={modelId}
            disabled={Boolean(editing)}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="deepseek-v4.1-flash-1017"
          />
        </div>
        {errors.modelId ? <div className="wb-card-note wb-note-bad">{errors.modelId}</div> : null}

        <div className="wb-card-row">
          <span className="wb-card-label">上下文窗口</span>
          <span className="wb-card-desc">填小了等于没用，填大了会打爆上游 —— 所以不预填</span>
          <input
            className="wb-card-input"
            data-testid="wb-modelconfig-window"
            type="number"
            value={contextWindow}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setContextWindow(event.target.value)}
            placeholder="1000000"
          />
        </div>
        {errors.contextWindow ? <div className="wb-card-note wb-note-bad">{errors.contextWindow}</div> : null}

        <div className="wb-card-row">
          <span className="wb-card-label">最大输出 Token</span>
          <span className="wb-card-desc">模型一次最多能说多少；不给就按 provider 默认</span>
          <input
            className="wb-card-input"
            data-testid="wb-modelconfig-max-output"
            type="number"
            value={maxOutput}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setMaxOutput(event.target.value)}
            placeholder="64000"
          />
        </div>
        {errors.maxOutput ? <div className="wb-card-note wb-note-bad">{errors.maxOutput}</div> : null}
      </div>

      <div className="wb-card">
        <div className="wb-card-head">高级配置</div>

        <div className="wb-card-row">
          <span className="wb-card-label">输入类型</span>
          <span className="wb-card-desc">文本恒可（纯文本是下限）；其余按模型实际能力勾</span>
          <span className="wb-modelconfig-chips">
            <em className="wb-modelconfig-chip is-on">文本</em>
            {MODALITIES.map((item) => (
              <button
                key={item.key}
                className={`wb-modelconfig-chip${modalities[item.key] ? " is-on" : ""}`}
                data-testid={`wb-modelconfig-${item.key}`}
                onClick={() => setModalities({ ...modalities, [item.key]: !modalities[item.key] })}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
        {errors.supportsVideo ? <div className="wb-card-note wb-note-bad">{errors.supportsVideo}</div> : null}

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
            JSON 对象或规则表；<code>{"{{reasoningLevel}}"}</code> 会被替换成这一轮的档位，
            结果合并进请求体
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
      </div>

      {errors.form ? <div className="wb-card-note wb-note-bad">{errors.form}</div> : null}
      {probe ? (
        <div
          className={`wb-card-note${probe.ok ? "" : " wb-note-bad"}`}
          data-testid="wb-modelconfig-test-result"
        >
          {probe.ok ? <Check size={13} /> : <X size={13} />}
          {probe.text}
        </div>
      ) : null}

      <div className="wb-setfull-foot">
        <button
          className="wb-page-btn"
          data-testid="wb-modelconfig-reset"
          onClick={() => {
            setModelId(editing?.modelId ?? "");
            setContextWindow(editing?.contextWindow ? String(editing.contextWindow) : "");
            setMaxOutput(editing?.maxOutputTokens ? String(editing.maxOutputTokens) : "");
            setReasoningLevels(editing?.reasoningLevels ?? []);
            setReasoningMap(editing?.reasoningMap ?? "");
            setMaxOutputMap(editing?.maxOutputMap ?? "");
            setErrors({});
          }}
        >
          重置表单
        </button>
        <button
          className="wb-page-btn"
          data-testid="wb-modelconfig-test"
          disabled={probing}
          onClick={() => void testConnection()}
        >
          {probing ? "测试中…" : "测试连通"}
        </button>
        <button className="wb-page-btn" data-testid="wb-modelconfig-cancel" onClick={() => onClose(false)}>
          取消
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
  );
}
