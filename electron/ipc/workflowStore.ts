import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { validateWorkflow, type WorkflowRun, type WorkflowSpec } from "../../engine/workflow/types";
import type { WorkflowRunView, WorkflowSpecView } from "../../shared/ipc";

/**
 * 工作流的只读产品面（V6-2l）。
 *
 * 目录约定（与 CLI 同一套，所以桌面能看到 CLI 跑出来的东西）：
 * ```
 * <userData>/workflows/<名字>.json        ← 定义（界面可以存）
 * <userData>/workflows/runs/<id>.json     ← 运行检查点（CLI 写）
 * ```
 *
 * 运行本身**不在桌面进程里做**：那需要在主进程再装配一套引擎/凭据，
 * 与 CLI 那条必然漂。这里只做"列 + 存定义 + 给运行命令"。
 */

export const WORKFLOW_CHANNEL = {
  list: "workflow:list",
  saveSpec: "workflow:save-spec",
} as const;

function workflowsDir(): string {
  return path.join(app.getPath("userData"), "workflows");
}

function runsDir(): string {
  return path.join(workflowsDir(), "runs");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function asRun(raw: unknown): WorkflowRunView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowRun> & { steps?: unknown };
  if (typeof r.id !== "string" || typeof r.name !== "string" || !Array.isArray(r.steps)) return null;
  const steps = (r.steps as unknown[])
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({
      id: String(s.id ?? ""),
      agent: String(s.agent ?? ""),
      task: String(s.task ?? ""),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((x): x is string => typeof x === "string") : [],
      status: (["pending", "running", "done", "failed", "skipped"].includes(String(s.status)) ? s.status : "pending") as WorkflowRunView["steps"][number]["status"],
      ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
      ...(typeof s.error === "string" ? { error: s.error } : {}),
      ...(typeof s.startedAt === "number" ? { startedAt: s.startedAt } : {}),
      ...(typeof s.finishedAt === "number" ? { finishedAt: s.finishedAt } : {}),
    }));
  return {
    id: r.id,
    name: r.name,
    ...(typeof r.specFile === "string" ? { specFile: r.specFile } : {}),
    status: (["running", "paused", "done", "failed"].includes(String(r.status)) ? r.status : "failed") as WorkflowRunView["status"],
    createdAt: Number(r.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? 0),
    steps,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  };
}

/** 读全部定义与运行（坏文件跳过，不带走整批）。 */
export function listWorkflows(): { specs: WorkflowSpecView[]; runs: WorkflowRunView[]; dir: string } {
  const root = workflowsDir();
  const specs: WorkflowSpecView[] = [];
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(root, name);
      const raw = readJson(file) as WorkflowSpec | null;
      if (!raw || typeof raw !== "object") continue;
      const errors = validateWorkflow(raw);
      specs.push({
        file,
        name: typeof raw.name === "string" ? raw.name : name,
        steps: Array.isArray(raw.steps) ? raw.steps.length : 0,
        valid: errors.length === 0,
        ...(errors.length ? { errors } : {}),
      });
    }
  }
  const runs: WorkflowRunView[] = [];
  if (fs.existsSync(runsDir())) {
    for (const name of fs.readdirSync(runsDir())) {
      if (!name.endsWith(".json")) continue;
      const run = asRun(readJson(path.join(runsDir(), name)));
      if (run) runs.push(run);
    }
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  return { specs, runs, dir: root };
}

export function registerWorkflowIpc(): void {
  ipcMain.handle(WORKFLOW_CHANNEL.list, () => listWorkflows());
  ipcMain.handle(WORKFLOW_CHANNEL.saveSpec, (_event, name: unknown, json: unknown) => {
    const safe = String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!safe) return { ok: false, error: "名字只能用字母/数字/-_（会用来做文件名）" };
    if (typeof json !== "string" || !json.trim()) return { ok: false, error: "定义是空的" };
    let spec: WorkflowSpec;
    try {
      spec = JSON.parse(json) as WorkflowSpec;
    } catch (error) {
      return { ok: false, error: `不是合法 JSON：${String((error as Error)?.message ?? error).slice(0, 120)}` };
    }
    const errors = validateWorkflow(spec);
    if (errors.length) return { ok: false, error: errors.join("；") };
    const dir = workflowsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ ...spec, name: spec.name.trim() || safe }, null, 2)}\n`, "utf8");
    return { ok: true, file, runCommand: `ding workflow run "${file}"` };
  });
}
