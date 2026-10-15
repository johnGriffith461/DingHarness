import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Engine } from "../index";
import type { TurnEvent } from "../runtime/loop";
import { startFakeProvider, type EvalReply } from "./fakeProvider";
import type { EvalCase, EvalCategory } from "./types";

/**
 * 跑一条评测用例（Phase 10 的执行器）。
 *
 * ## 判据怎么算出来的
 *
 * 一条用例跑完之后，手上有四样东西，分别对着三样判据：
 *
 * | 判据 | 取自 |
 * |---|---|
 * | 事件序列 | `engine.run` 的 `onEvent` 收集到的 `TurnEvent[]`（**真代码路径吐出的事件**） |
 * | 关键文案 | 事件里的文本 + 工具结果 + 落盘记录，拼成一份大文本再找关键字 |
 * | 产物存在性 | 工作目录里真的去看（不算"模型说它写了"） |
 *
 * 另外两条（闸门待决、步数、账本）取自 `resume()` 的投影 ——
 * 也就是**状态 = fold(events)** 那条不变量本身：如果事件流不足以还原出"有审批待决"，
 * 那么界面上也还原不出来。
 *
 * ## ⚠️ 每个用例一个独立的临时工作目录 + 一个独立的假 provider
 *
 * 两者都是为了**隔离**：共用目录会让"上一个用例写下的文件"变成下一个用例的既有状态；
 * 共用假 provider 会让迟到请求串台（`loop.test.ts` 用两次红换来的教训）。
 */

/** 一条用例的失败项（空 = 通过）。 */
export type EvalFailure = { caseId: string; what: string; detail: string };

export type EvalCaseResult = {
  id: string;
  category: EvalCategory;
  title: string;
  ok: boolean;
  failures: EvalFailure[];
  /** 这一步实际吐出的事件类型序列（报告里能看到"差在哪"）。 */
  eventTypes: string[];
  steps: number;
  ms: number;
  /** 这一条的用量（把各步 `done` 事件的 usage 加起来）。矩阵拿它算花费。 */
  usage: { input: number; output: number };
};

/** 宿主提供给评测器的东西（装配方式由宿主决定：CLI 给真装配，测试给同一份）。 */
export type EvalDeps = {
  /**
   * 为**这个工作目录**建一个引擎。
   *
   * 为什么要宿主给：引擎的端口（数据放哪、工具能碰哪些目录）全是宿主决定的 ——
   * 评测器自己拼一套端口就等于**绕开了产品那条装配路**，
   * 那样测出来的"通过率"不能代表产品（SessionStore 记错地方、工具少了白名单都会漏掉）。
   */
  makeEngine: (workDir: string) => Promise<{ engine: Engine; close: () => void }>;
  /** 会话 id 前缀（方便在临时目录里认出来）。 */
  sessionPrefix?: string;
  /**
   * 用哪个 provider。默认 `strata`（那个本来指本机服务的），也就是**假 provider 那条路**。
   *
   * ⚠️ 跨 provider 质量-成本矩阵（10.7）会把它换成真 provider ——
   * 那时 `fakeProvider: false`，用例脚本里的"模型回复"就没人读了，
   * 评测变成"拿真模型跑同一批题、看通过率与花费"。**那会花钱**，所以默认不开。
   */
  provider?: string;
  /** 用哪个模型（默认 `deepseek-flash`）。矩阵那条按 provider 换。 */
  model?: string;
  /** 要不要起假 provider（默认要）。`false` = 打真端点。 */
  fakeProvider?: boolean;
};

/** 起一个一次性的临时工作目录。 */
function tempWorkDir(caseId: string): string {
  const safe = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `dh-eval-${safe}-`));
}

/** 把桩文件写进工作目录（父目录按需建）。 */
function writeFixtures(workDir: string, fixtures: Record<string, string> | undefined): void {
  for (const [rel, content] of Object.entries(fixtures ?? {})) {
    const full = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

/** 递归把一个未知值里的所有字符串拼起来（关键文案断言用）。 */
function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) flatten(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) flatten(v, out);
  return out;
}

/**
 * 跑一条用例。
 *
 * @param c 用例
 * @param deps 宿主给的装配
 * @returns 结果（含失败原因；**不抛异常** —— 一条用例炸了不该带走整批）
 */
export async function runCase(c: EvalCase, deps: EvalDeps): Promise<EvalCaseResult> {
  const started = Date.now();
  const failures: EvalFailure[] = [];
  const events: TurnEvent[] = [];
  const workDir = tempWorkDir(c.id);
  const fail = (what: string, detail: string) => failures.push({ caseId: c.id, what, detail });

  /*
   * 纯函数格子（`kind: "core"`）：不起 provider、不跑回合 —— 直接问核心里那把尺子。
   * 它照样走同一套结果形状（成功/失败/耗时），所以报告与基线不必分两种。
   */
  if (c.kind === "core") {
    try {
      const detail = c.coreCheck?.();
      if (detail) fail("核心判据", detail);
    } catch (error) {
      fail("异常", String((error as Error)?.message ?? error).slice(0, 200));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    return {
      id: c.id,
      category: c.category,
      title: c.title,
      ok: failures.length === 0,
      failures,
      eventTypes: [],
      steps: 0,
      ms: Date.now() - started,
      usage: { input: 0, output: 0 },
    };
  }

  /*
   * `{{dir}}` 占位先替换掉：用例是**静态数据**，而工作目录是运行时才建的。
   * 写死绝对路径会让用例跟着临时目录漂（一次一换），所以统一在这里换一次 ——
   * 必须在**起假 provider 之前**换，否则 provider 脚本里还是占位符。
   */
  const substituted: EvalReply[][] = (c.replies ?? []).map((turnReplies) =>
    turnReplies.map((reply) => {
      if (!("call" in reply) || !reply.call) return reply;
      return {
        ...reply,
        call: reply.call.map((call) => ({
          name: call.name,
          args: JSON.parse(JSON.stringify(call.args).replaceAll("{{dir}}", JSON.stringify(workDir).slice(1, -1))) as Record<string, unknown>,
        })),
      };
    }),
  );

  const useFake = deps.fakeProvider !== false;
  const provider = useFake ? await startFakeProvider(substituted.flat(), c.turns ?? []) : null;
  const prevBase = process.env.STRATA_BASE_URL;
  const prevKey = process.env.STRATA_API_KEY;
  if (provider) {
    process.env.STRATA_BASE_URL = provider.url;
    process.env.STRATA_API_KEY = "eval-key";
  }

  let close: (() => void) | null = null;
  try {
    writeFixtures(workDir, c.fixtures);
    const built = await deps.makeEngine(workDir);
    close = built.close;
    const sessionId = `${deps.sessionPrefix ?? "eval"}-${c.id}`;

    const turns = c.turns ?? [];
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i] ?? "";
      await built.engine.run({
        sessionId,
        provider: deps.provider ?? "strata",
        model: deps.model ?? "deepseek-flash",
        messages: [{ role: "user", content: turn }],
        mode: c.mode ?? "按需确认",
        ...(c.useTools === false ? { useTools: false } : { useTools: true }),
        maxSteps: c.maxSteps ?? 4,
        onEvent: (e) => events.push(e),
      });
    }

    /* ---------- 判据一：事件序列（子序列） ---------- */
    const types: string[] = events.map((e) => e.type);
    const expect = c.expect ?? {};
    if (expect.events?.length) {
      let at = 0;
      for (const want of expect.events) {
        const found = types.indexOf(want, at);
        if (found < 0) {
          fail("事件序列", `期望按顺序出现 ${expect.events.join(" → ")}，但第 ${at + 1} 个「${want}」没出现（实际：${types.join(" → ")}）`);
          break;
        }
        at = found + 1;
      }
    }

    /* ---------- 判据二：关键文案 ---------- */
    if (expect.copy?.length) {
      const resumed = await built.engine.resume(sessionId);
      const haystack = [...flatten(events), ...flatten(resumed)].join("\n");
      for (const needle of expect.copy) {
        if (!haystack.includes(needle)) {
          fail("关键文案", `回注里没有「${needle}」`);
        }
      }
    }

    /* ---------- 判据三：产物存在性 ---------- */
    for (const rel of expect.files ?? []) {
      if (!fs.existsSync(path.join(workDir, rel))) fail("产物", `期望落盘的「${rel}」不存在`);
    }
    for (const rel of expect.filesAbsent ?? []) {
      if (fs.existsSync(path.join(workDir, rel))) fail("产物", `不该存在的「${rel}」却在`);
    }

    /* ---------- 闸门 / 步数 / 账本（都取自投影） ---------- */
    if (expect.gate) {
      const resumed = await built.engine.resume(sessionId);
      const pending = (resumed.pending ?? []).length;
      if (expect.gate === "pending" && pending === 0) fail("闸门", "期望有待决审批，实际没有");
      if (expect.gate === "none" && pending > 0) fail("闸门", `期望没有待决审批，实际有 ${pending} 条`);
    }
    if (expect.eventsAbsent?.length) {
      for (const banned of expect.eventsAbsent) {
        if (types.includes(banned)) fail("事件序列", `不该出现的「${banned}」出现了（实际：${types.join(" → ")}）`);
      }
    }
    if (expect.delegations !== undefined) {
      const n = types.filter((t) => t === "delegation").length;
      if (n < expect.delegations) fail("委派", `至少 ${expect.delegations} 次委派，实际 ${n} 次`);
    }
    if (expect.toolErrors?.length) {
      for (const name of expect.toolErrors) {
        const hit = events.some((e) => e.type === "tool-result" && e.toolName === name && Boolean(e.error));
        if (!hit) fail("工具报错", `期望「${name}」以失败收场，但没见到它失败`);
      }
    }
    const steps = types.filter((t) => t === "step-finish").length;
    if (expect.minSteps !== undefined && steps < expect.minSteps) {
      fail("步数", `至少 ${expect.minSteps} 步，实际 ${steps} 步`);
    }
    if (expect.usage) {
      /*
       * ⚠️ 判据要落在**数字**上：第一版是在投影里找 `tokens|usage` 这个**字符串**，
       * 而投影里那些是字段名/数值 —— 于是它永远匹配不到，**用例红得毫无意义**
       * （假判据比没有判据更糟：它让人以为"账本验过了"）。
       */
      const withUsage = events.some(
        (e) => e.type === "done" && e.usage && (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0) > 0,
      );
      if (!withUsage) fail("账本", "这一轮没有任何带数字的用量（done 事件的 usage 是空的）");
    }
  } catch (error) {
    fail("异常", String((error as Error)?.message ?? error).split("\n")[0]?.slice(0, 200) ?? "未知异常");
  } finally {
    try {
      close?.();
    } catch {
      /* 收尾失败不影响判定 */
    }
    if (provider) await provider.close();
    if (prevBase === undefined) delete process.env.STRATA_BASE_URL;
    else process.env.STRATA_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.STRATA_API_KEY;
    else process.env.STRATA_API_KEY = prevKey;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const eventTypes = events.map((e) => e.type);
  const usage = events.reduce(
    (acc, e) => {
      if (e.type !== "done" || !e.usage) return acc;
      acc.input += e.usage.inputTokens ?? 0;
      acc.output += e.usage.outputTokens ?? 0;
      return acc;
    },
    { input: 0, output: 0 },
  );
  return {
    id: c.id,
    category: c.category,
    title: c.title,
    ok: failures.length === 0,
    failures,
    eventTypes,
    steps: eventTypes.filter((t) => t === "step-finish").length,
    ms: Date.now() - started,
    usage,
  };
}

/** 一批用例的总账（`ding eval` 与基线都吃这个形状）。 */
export type EvalReport = {
  total: number;
  passed: number;
  failed: number;
  /** 通过率（0–100，保留一位小数）。 */
  rate: number;
  byCategory: Record<string, { total: number; passed: number }>;
  results: EvalCaseResult[];
};

/**
 * 跑一批用例。
 *
 * @param cases 用例
 * @param deps 装配
 * @param onProgress 每条跑完回调一次（命令行里打进度）
 * @returns 总账
 */
export async function runSuite(
  cases: readonly EvalCase[],
  deps: EvalDeps,
  onProgress?: (r: EvalCaseResult, index: number, total: number) => void,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const r = await runCase(cases[i]!, deps);
    results.push(r);
    onProgress?.(r, i + 1, cases.length);
  }

  const byCategory: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const slot = (byCategory[r.category] ??= { total: 0, passed: 0 });
    slot.total += 1;
    if (r.ok) slot.passed += 1;
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    rate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
    byCategory,
    results,
  };
}
