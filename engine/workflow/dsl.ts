import { AGENT_SPECS } from "../runtime/agents";
import type { WorkflowSpec, WorkflowStep } from "./types";

/**
 * **工作流 DSL**（L03，2026-10-18）。
 *
 * ## 为什么还要一层文本格式
 *
 * JSON 定义已经能用（`engine/workflow/types.ts` 的 `WorkflowSpec`），但手写一份
 * 十步的 DAG 要反复写 `id` 与 `dependsOn` —— 而人想的是"先调研、再实现、最后审阅"。
 * 这个 DSL 直接按**阶段**写，依赖由阶段顺序自动推导（同一阶段里的步骤并行）。
 *
 * ## 语法（完整示例）
 *
 * ```
 * name: 周报流水线
 * mode: 按需确认
 * desc: 收集 → 写作 → 审阅
 *
 * phase 调研
 *   agent researcher 收集本周数据与进展
 *   agent researcher 找出风险项
 *
 * phase 写作 after 调研
 *   agent writer 写成一份周报
 *
 * phase 审阅 after 写作
 *   agent reviewer 检查事实与措辞
 * ```
 *
 * - `phase <名字> [after <名字1>,<名字2>]`：开一个阶段；`after` 里的阶段**全部完成**
 *   才轮到它。省略 `after` = 它依赖**上一个阶段**（最常见的写法）。
 * - `agent <角色> <任务>`：这一阶段里的一个步骤（同一阶段内的步骤并行）。
 * - `//` 开头是注释；空行忽略。
 *
 * ## 口径
 *
 * - 不认识的专家名 → 报错（`AGENT_SPECS` 是唯一名单，不猜别名）；
 * - 重名阶段 / `after` 指向不存在的阶段 / 空阶段 → 报错；
 * - 解析失败**不产出半份定义**（宁可拒绝，也不要跑一个少了两步的工作流）。
 */

/** 解析结果。 */
export type DslParseResult = { ok: true; spec: WorkflowSpec } | { ok: false; problems: string[] };

/** 一个阶段（解析中间态）。 */
type Phase = {
  name: string;
  /** 显式声明的 after（空 = 依赖上一阶段）。 */
  after: string[];
  steps: Array<{ agent: string; task: string }>;
  line: number;
};

/**
 * 解析 DSL 文本。
 *
 * @param text 文本
 * @param opts.fallbackName 没有 `name:` 时用什么名字（通常是文件名）
 */
export function parseWorkflowDsl(text: string, opts: { fallbackName?: string } = {}): DslParseResult {
  const problems: string[] = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let name = "";
  let desc = "";
  let mode: string | undefined;
  const phases: Phase[] = [];
  let current: Phase | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    const lineNo = i + 1;
    if (!line || line.startsWith("//")) continue;

    const nameMatch = /^name\s*[:：]\s*(.+)$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!.trim();
      continue;
    }
    const descMatch = /^(?:desc|description)\s*[:：]\s*(.+)$/.exec(line);
    if (descMatch) {
      desc = descMatch[1]!.trim();
      continue;
    }
    const modeMatch = /^mode\s*[:：]\s*(.+)$/.exec(line);
    if (modeMatch) {
      mode = modeMatch[1]!.trim();
      continue;
    }

    const phaseMatch = /^phase\s+(\S+)(?:\s+after\s+(.+))?$/i.exec(line);
    if (phaseMatch) {
      const phaseName = phaseMatch[1]!;
      if (phases.some((p) => p.name === phaseName)) {
        problems.push(`第 ${lineNo} 行：阶段「${phaseName}」重复了`);
        current = null;
        continue;
      }
      const after = phaseMatch[2]
        ? phaseMatch[2]
            .split(/[,，\s]+/)
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
      current = { name: phaseName, after, steps: [], line: lineNo };
      phases.push(current);
      continue;
    }

    const agentMatch = /^(?:-|agent)\s+(\S+)\s+(.+)$/i.exec(line);
    if (agentMatch) {
      if (!current) {
        problems.push(`第 ${lineNo} 行：这个 agent 不属于任何阶段（先在它上面写一行 \`phase <名字>\`）`);
        continue;
      }
      current.steps.push({ agent: agentMatch[1]!, task: agentMatch[2]!.trim() });
      continue;
    }

    problems.push(`第 ${lineNo} 行不认识：${line.slice(0, 40)}（支持 name:/desc:/mode:/phase/agent）`);
  }

  if (!phases.length) problems.push("没有解析到任何阶段（至少要有一个 `phase` 与它的 `agent`）");
  for (const phase of phases) {
    if (!phase.steps.length) problems.push(`阶段「${phase.name}」里没有 agent（空阶段没有意义）`);
  }

  /* after 指向不存在的阶段 */
  const names = new Set(phases.map((p) => p.name));
  for (const phase of phases) {
    for (const dep of phase.after) {
      if (!names.has(dep)) problems.push(`阶段「${phase.name}」的 after 指向不存在的阶段「${dep}」`);
    }
    if (phase.after.includes(phase.name)) problems.push(`阶段「${phase.name}」依赖了自己`);
  }

  /* 专家名必须在名单里（不猜别名） */
  const known = new Set(AGENT_SPECS.map((a) => a.name));
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (!known.has(step.agent)) {
        problems.push(`阶段「${phase.name}」用了不认识的专家「${step.agent}」（可用：${[...known].join(" / ")}）`);
      }
    }
  }

  if (problems.length) return { ok: false, problems };

  /*
   * 阶段 → 步骤：同阶段的步骤共用依赖（= 并行层）；
   * 没写 after 的阶段依赖**上一个阶段**（最常见的写法）。
   */
  const steps: WorkflowStep[] = [];
  const phaseStepIds = new Map<string, string[]>();
  phases.forEach((phase, index) => {
    const after = phase.after.length ? phase.after : index > 0 ? [phases[index - 1]!.name] : [];
    const dependsOn = after.flatMap((dep) => phaseStepIds.get(dep) ?? []);
    const ids: string[] = [];
    phase.steps.forEach((step, stepIndex) => {
      const id = `${phase.name}#${stepIndex + 1}`;
      ids.push(id);
      steps.push({
        id,
        agent: step.agent,
        task: step.task,
        ...(dependsOn.length ? { dependsOn: [...new Set(dependsOn)] } : {}),
      });
    });
    phaseStepIds.set(phase.name, ids);
  });

  const spec: WorkflowSpec = {
    name: name || opts.fallbackName?.trim() || "未命名工作流",
    ...(desc ? { description: desc } : {}),
    ...(mode === "全部允许" || mode === "按需确认" || mode === "每步确认" ? { mode } : {}),
    steps,
  };
  return { ok: true, spec };
}

/** 把一份 spec 反写成 DSL（导出一份可读的定义；往返可测）。 */
export function workflowToDsl(spec: WorkflowSpec): string {
  const lines: string[] = [`name: ${spec.name}`];
  if (spec.description) lines.push(`desc: ${spec.description}`);
  if (spec.mode) lines.push(`mode: ${spec.mode}`);
  lines.push("");

  /* 按 dependsOn 反推阶段：同一 dependsOn 集合归为一组（组名用第一段任务里的 id 前缀） */
  const byDeps = new Map<string, WorkflowStep[]>();
  const order: string[] = [];
  for (const step of spec.steps) {
    const key = [...(step.dependsOn ?? [])].sort().join(",");
    if (!byDeps.has(key)) {
      byDeps.set(key, []);
      order.push(key);
    }
    byDeps.get(key)!.push(step);
  }
  for (const key of order) {
    const group = byDeps.get(key)!;
    /* 阶段名取第一步 id 的 `#` 前缀；没有就用序号 */
    const phaseName = group[0]!.id.includes("#") ? group[0]!.id.split("#")[0]! : `阶段${order.indexOf(key) + 1}`;
    const after = key
      ? [...new Set(
          key
            .split(",")
            .map((depId) => spec.steps.find((s) => s.id === depId))
            .filter((s): s is WorkflowStep => Boolean(s))
            .map((s) => (s.id.includes("#") ? s.id.split("#")[0]! : "")),
        )].filter(Boolean)
      : [];
    lines.push(`phase ${phaseName}${after.length ? ` after ${after.join(",")}` : ""}`);
    for (const step of group) lines.push(`  agent ${step.agent} ${step.task}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
