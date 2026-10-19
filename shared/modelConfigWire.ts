/**
 * **模型能力表单的 IPC 形状**（T0 桌面「添加模型」）。
 *
 * 结构照 `engine/runtime/modelConfig.ts`，但**不 import engine**（`shared` 不依赖内核）。
 * 两边的字段由 `src/modelConfigIpc.test.ts` 对账 —— 抄一份形状就必须有守卫盯着，
 * 否则内核加一个字段、界面永远看不到（那是"假控件"的另一种形态）。
 */

/** 输入模态。`supportsText` 恒真：纯文本模型是下限，不是选项。 */
export type ModelInputFormatWire = {
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPdf: boolean;
};

export type ModelConfigWire = {
  enabled: boolean;
  properties: {
    requiresMfjsToolSchema: boolean;
    contextWindow: number;
    inputFormat: ModelInputFormatWire;
    outputFormat: { supportsText: boolean };
    supportsToolCall: boolean;
    supportsJsonSchemaOutput: boolean;
    supportsNativeWebSearch: boolean;
    supportsMidConversationSystem: boolean;
  };
  optionSpecs: {
    reasoningLevel: { values: string[]; map: string };
    maxOutputTokens: { max: number; map: string };
  };
};

/** 一条用户声明的模型（`models.json` 里 `exact` 规则的**扁平视图**）。 */
export type DeclaredModelWire = {
  providerId: string;
  modelId: string;
  /** 完整配置（表单里显示当前值）。 */
  config: ModelConfigWire;
  /** 哪些字段是用户手动改的（界面显示 override 标记）。 */
  overrides: string[];
  /** 解析出来的来源说明（"智能配置"/"手动配置"）。 */
  source: string;
  /** 实际历史保留量（按当前档位算好的，界面直接显示，避免两处算法）。 */
  keepTokens: number;
};

/** 表单提交的补丁（只带用户改过的字段；`null` = 显式清空）。 */
export type ModelConfigPatchWire = {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputFormat?: Partial<ModelInputFormatWire> | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
  reasoningLevels?: string[] | null;
  reasoningMap?: string | null;
  maxOutputMap?: string | null;
};

export type ModelConfigSaveInput = {
  providerId: string;
  modelId: string;
  patch: ModelConfigPatchWire;
  /** `true` = 手动配置（默认）；`false` = 仅作为推荐覆盖，未改的字段仍跟随推荐。 */
  manual?: boolean;
};

export type ModelConfigSaveResult =
  | { ok: true; path: string; keepTokens: number }
  | { ok: false; error: string };

export type ModelConfigListResult = {
  models: DeclaredModelWire[];
  /** `models.json` 的解析告警（坏规则被跳过时如实报出来，不静默吞）。 */
  errors: string[];
};

/** 一次连通性测试的结果。**只报实际发生的**：没发出去就说没发出去。 */
export type ModelConfigProbeResult =
  | {
      ok: true;
      /** 模型回了什么（截断后的前若干字符）。 */
      reply: string;
      elapsedMs: number;
      /** provider 上报的用量（没上报就不给 —— 不编）。 */
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { ok: false; error: string; elapsedMs: number };

/** 桌面侧要用的那一组通道。 */
export type ModelConfigBridge = {
  /** @param contextBudget 预算档位（桌面把它存在渲染侧，所以要传进来） */
  list: (contextBudget?: string) => Promise<ModelConfigListResult>;
  save: (input: ModelConfigSaveInput) => Promise<ModelConfigSaveResult>;
  remove: (providerId: string, modelId: string) => Promise<{ ok: boolean }>;
  /** 校验一段参数映射（保存前先问一次，错误就地显示）。 */
  validateMap: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * **连通性测试**：真发一轮最小请求。
   *
   * 为什么不是"查一下配置对不对"：配置全对、照样连不通的情况太常见
   * （密钥错、通道拒绝、模型名拼错、输出上限比上游允许的大）。
   * 只有真发一次才知道这个模型**现在**能不能用。
   */
  probe: (providerId: string, modelId: string) => Promise<ModelConfigProbeResult>;
};
