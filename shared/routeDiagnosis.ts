/**
 * 「没有可用通道」的**诊断 + 下一步**（F-03，2026-10-20）。
 *
 * ## 它替掉的是什么
 *
 * 原来的提示只有一句：
 *
 *   还没有可用的 AI 通道（先确认至少一个 provider 配好了密钥）
 *
 * 它有两个问题：
 * 1. **没有下一步** —— 用户知道"没通道"，但不知道点哪；
 * 2. **会误诊** —— "有 key 但没模型"与"一个 key 都没有"说的是同一句，
 *    而这两种情况该去的地方不同（填 key vs 选/添加模型）。
 *
 * ## 口径
 *
 * 诊断只从**已有事实**推：provider 清单（谁有密钥、谁有模型）、钉住的默认模型、
 * 用户声明的模型（`models.json`）。不探测网络，不猜。
 *
 * 界面把 `action` 画成按钮（跳到设置·模型页）；CLI 在 `--json` 里带同一份 `diagnosis`。
 * 两边读的是这同一个函数 —— "一个行为一个家"。
 */

/** 诊断要看的 provider 事实（`shared/` 不依赖 engine 的具体类型）。 */
export type RouteProviderFact = {
  id: string;
  label?: string;
  available: boolean;
  models?: readonly string[];
};

export type RouteDiagnosisKind =
  /** 有路可走（有密钥、有模型、钉住的也可用）。 */
  | "ok"
  /** 一个 provider 的密钥都没有。 */
  | "no_key"
  /** 有密钥，但没有任何可选模型（清单空、也没声明过）。 */
  | "no_model"
  /** 有密钥有模型，但用户还没选默认模型（自动挑选仍可能成功，属于提示不是错误）。 */
  | "no_pinned"
  /** 钉住的通道/模型现在不可用（provider 掉线或被移除）。 */
  | "pinned_dead";

/** 可点的下一步。 */
export type RouteAction = {
  /** 去设置里的哪一页（今天三类都落在「模型」页：那里既有 key 也有模型清单）。 */
  page: "models";
  /** 按钮上的字。 */
  label: string;
};

export type RouteDiagnosis = {
  kind: RouteDiagnosisKind;
  /** 给人看的一句话（诊断，不是"正确的废话"）。 */
  message: string;
  /** 可点的下一步；`ok` 时没有。 */
  action?: RouteAction;
  /** 这一类是不是"走不下去"（`no_pinned` 只是提示，自动挑选仍可能成功）。 */
  blocking: boolean;
};

/** 把 `provider/model` 拆开；半个值不算。 */
function splitModel(value: string | undefined): { provider: string; model: string } | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const at = raw.indexOf("/");
  if (at <= 0 || at >= raw.length - 1) return null;
  return { provider: raw.slice(0, at), model: raw.slice(at + 1) };
}

/**
 * 诊断当前路由。
 *
 * @param state.providers provider 清单（`available` = 检测到密钥）
 * @param state.pinnedModel 钉住的默认通道（`provider/model`）
 * @param state.declaredRoutes 用户声明的模型（`provider/model`，来自 models.json）
 */
/** 磁盘上读回来的诊断（不可信）→ 干净的那一份；不认识就是 `undefined`。 */
export function normalizeRouteDiagnosis(raw: unknown): RouteDiagnosis | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "ok" && kind !== "no_key" && kind !== "no_model" && kind !== "no_pinned" && kind !== "pinned_dead") {
    return undefined;
  }
  if (typeof o.message !== "string") return undefined;
  const rawAction = o.action as Record<string, unknown> | undefined;
  const action =
    rawAction && rawAction.page === "models" && typeof rawAction.label === "string" && rawAction.label.trim()
      ? { page: "models" as const, label: rawAction.label.trim().slice(0, 40) }
      : undefined;
  return {
    kind,
    message: o.message.slice(0, 500),
    ...(action ? { action } : {}),
    blocking: kind !== "ok" && kind !== "no_pinned",
  };
}

export function diagnoseRoute(state: {
  providers: readonly RouteProviderFact[];
  pinnedModel?: string;
  declaredRoutes?: readonly string[];
}): RouteDiagnosis {
  const providers = state.providers ?? [];
  const declared = new Set((state.declaredRoutes ?? []).map((r) => r.trim()).filter(Boolean));
  const withKeys = providers.filter((p) => p.available);
  const modelsOf = (p: RouteProviderFact): string[] => [
    ...(p.models ?? []),
    ...[...declared].filter((r) => r.startsWith(`${p.id}/`)).map((r) => r.slice(p.id.length + 1)),
  ];
  const usable = withKeys.filter((p) => modelsOf(p).length > 0);

  /* ① 一个 key 都没有 —— 先填 key，这一条最没有歧义 */
  if (withKeys.length === 0) {
    return {
      kind: "no_key",
      message: "还没有配置任何 provider 的密钥。",
      action: { page: "models", label: "去填 key" },
      blocking: true,
    };
  }

  /* ② 钉住的通道现在还能不能用 */
  const pinned = splitModel(state.pinnedModel);
  if (pinned) {
    const provider = providers.find((p) => p.id === pinned.provider);
    const modelOk = provider ? modelsOf(provider).includes(pinned.model) : false;
    if (!provider || !provider.available || !modelOk) {
      const label = provider?.label ?? pinned.provider;
      return {
        kind: "pinned_dead",
        message: `钉住的通道现在不可用：${label}。`,
        action: { page: "models", label: "换一个模型" },
        blocking: true,
      };
    }
    return { kind: "ok", message: "", blocking: false };
  }

  /* ③ 有 key 但一家可选模型都没有 */
  if (usable.length === 0) {
    return {
      kind: "no_model",
      message: "有密钥，但这几家都没有可选模型。",
      action: { page: "models", label: "去添加模型" },
      blocking: true,
    };
  }

  /* ④ 有路可走、只是没钉默认 —— 提示一句，不拦路 */
  return {
    kind: "no_pinned",
    message: "还没选模型（现在会自动挑一个，想固定下来可以去设置里选）。",
    action: { page: "models", label: "去选模型" },
    blocking: false,
  };
}
