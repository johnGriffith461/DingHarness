import { app } from "electron";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { videoExtensionFor } from "../../shared/mediaType";
import { resolveSecret } from "../../engine/runtime/credentials";
import { IMAGE_PROVIDERS } from "./imageGen";
import { blockedReason, fetchRemote, realModelBlocked } from "../../engine/runtime/modelGate";

/**
 * 视频生成通道（阶段 11.12）。
 *
 * ## 为什么要接
 * 上位画布底部工具条上「视频生成」是与「图片生成」并列的一项。我之前只做了图片，
 * 视频这块的结论是"这把 Key 下一个视频模型都没有" —— 那是事实，但**不能因此不接**：
 * 换个有视频模型的 Key 就应该能用。
 *
 * ## 接口口径（离线文档读到）
 * Lunora 提供两组：
 *   · `POST /v1/videos`（OpenAI/Omni 风格）→ 返回 task_id，再 `GET /v1/videos/{id}`
 *     查状态、`GET /v1/videos/{id}/content` 取成品；
 *   · `POST /v1/video/generations`（Grok 风格）。
 * 生成是**异步**的（视频不可能一次请求返回），所以这里是"提交 + 轮询"。
 *
 * ## 模型清单为什么单独列
 * 图像与视频的模型名不重叠，`/v1/models` 返回的是一张大表。用名字特征筛出视频模型，
 * 而不是硬编码一串名字 —— 上游加一个模型不用改代码。
 */

/** 通道名。 */
export const VIDEO_CHANNEL = {
  /** 列出可用的视频模型（只列真的有的）。 */
  listModels: "video:listModels",
  /** 提交一次生成并等到成品落盘。 */
  generate: "video:generate",
} as const;

/** 视频模型名里会出现的特征词（各家命名不一，宁可宽一点）。 */
const VIDEO_MODEL_HINTS = ["veo", "sora", "kling", "runway", "pika", "luma", "video", "wan", "hailuo"];

/** 判定一个模型名是不是视频模型。 */
export function isVideoModel(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return VIDEO_MODEL_HINTS.some((hint) => lower.includes(hint));
}

/** 取通道定义（与图片共用同一家与同一把密钥）。 */
function provider() {
  return IMAGE_PROVIDERS[0];
}

/** 视频与图片落在同一个目录（都是"生成出来的素材"）。 */
function assetsDir(): string {
  return path.join(app.getPath("userData"), "assets");
}

/**
 * 列出可用的视频模型。
 *
 * @returns 模型 id 数组；通道不可用或缺密钥时返回空数组（**不编**）
 */
export async function listVideoModels(): Promise<string[]> {
  const def = provider();
  if (!def) return [];
  const key = resolveSecret(def.keyRef);
  if (!key) return [];
  /*
   * ⭐ 闸（2026-10-16，审计 P53）：开着 `DSH_NO_REAL_MODEL` 时连模型清单都不去拉 ——
   * `GET /models` 也是真出网。这里只能回空数组（函数的约定就是"没有可用模型"）；
   * **真正的原因**由 `generateVideo` 在那条有地方装人话的路上说清。
   */
  if (realModelBlocked(def.baseURL)) return [];
  try {
    const response = await fetchRemote(`${def.baseURL}/models`, "列出视频模型", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && isVideoModel(id));
  } catch {
    return [];
  }
}

/** 生成结果。 */
export type GenerateVideoResult =
  | { ok: true; name: string; url: string; bytes: number; ms: number; model: string; note?: string }
  | { ok: false; error: string };

/**
 * 提交一次视频生成并等成品。
 *
 * @param prompt 提示词
 * @param model 指定模型（省略则用列出来的第一个）
 * @returns 结果；没有可用模型时给出**明确**的说明而不是含糊的失败
 */
/** 成品字节上限（防上游/异常端点返回超大 body 把磁盘写满）。 */
const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

export async function generateVideo(prompt: string, model?: string): Promise<GenerateVideoResult> {
  const def = provider();
  if (!def) return { ok: false, error: "没有配置视频通道" };
  const key = resolveSecret(def.keyRef);
  if (!key) return { ok: false, error: `缺少密钥 ${def.keyRef}` };

  /*
   * ⭐ 闸（审计 P53）：先给一句真原因。不这么写的话，下面 `listVideoModels()` 会回空数组，
   * 用户看到的是"当前 Key 下没有可用的视频模型" —— 与真因（你自己的开关拦下了它）无关。
   */
  if (realModelBlocked(def.baseURL)) {
    return { ok: false, error: blockedReason("生成视频", def.baseURL) };
  }

  const models = await listVideoModels();
  const chosen = model && models.includes(model) ? model : models[0];
  if (!chosen) {
    /*
     * 这条文案是刻意写具体的：用户看到"失败"会反复重试，
     * 看到"这把 Key 下没有视频模型"才知道该换密钥 —— 而不是以为功能坏了。
     */
    return {
      ok: false,
      error: `当前 Key 下没有可用的视频模型（已检查 ${def.baseURL}/models）。视频接口是通的，换一把带视频模型的密钥即可。`,
    };
  }

  const started = Date.now();
  try {
    const submit = await fetchRemote(`${def.baseURL}/videos`, "提交视频生成", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: chosen, prompt }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!submit.ok) {
      return { ok: false, error: `提交失败：HTTP ${submit.status} ${await submit.text().catch(() => "")}`.slice(0, 300) };
    }
    const created = (await submit.json()) as { id?: string; task_id?: string };
    const taskId = created.id ?? created.task_id;
    if (!taskId) return { ok: false, error: "提交成功但没拿到任务 id" };

    /*
     * 轮询：视频通常几十秒到几分钟，给 5 分钟上限。
     *
     * ⚠️ 三件事与原来不同（审计 P229）：
     *   1. **不再把每一次 HTTP 失败都吞成"还在跑"** —— 401/403/404 这类
     *      "再等也不会变"的（密钥吊销 / 任务被上游清掉 / 地址不对）立刻如实报错；
     *   2. 429/5xx/网络抖动算可重试，但**连续失败有上限**（否则 5 分钟白打 60 次，
     *      最后只说一句与真因无关的"等待超时"）；
     *   3. 超时时把**最后一次看到的状态/错误**带出来。
     */
    const deadline = Date.now() + 5 * 60_000;
    let consecutiveFailures = 0;
    let lastNote = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      let poll: Response;
      try {
        poll = await fetchRemote(`${def.baseURL}/videos/${taskId}`, "轮询视频任务", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        consecutiveFailures += 1;
        lastNote = `网络错误：${error instanceof Error ? error.message : String(error)}`;
        if (consecutiveFailures >= 5) return { ok: false, error: `连续 ${consecutiveFailures} 次轮询失败：${lastNote}` };
        continue;
      }
      if (!poll.ok) {
        lastNote = `HTTP ${poll.status} ${(await poll.text().catch(() => "")).slice(0, 120)}`;
        /* 再也不会变的那几种：立刻报，别等到超时 */
        if (poll.status === 400 || poll.status === 401 || poll.status === 403 || poll.status === 404 || poll.status === 410) {
          return { ok: false, error: `轮询失败：${lastNote}` };
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) return { ok: false, error: `连续 ${consecutiveFailures} 次轮询失败：${lastNote}` };
        continue;
      }
      consecutiveFailures = 0;
      const state = (await poll.json()) as { status?: string; error?: { message?: string } };
      const status = String(state.status ?? "").toLowerCase();
      if (status === "failed" || status === "error") {
        return { ok: false, error: `生成失败：${state.error?.message ?? "上游未给出原因"}` };
      }
      if (status === "succeeded" || status === "completed" || status === "done") {
        const content = await fetchRemote(`${def.baseURL}/videos/${taskId}/content`, "取视频成品", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(120_000),
        });
        if (!content.ok) {
          return { ok: false, error: `取成品失败：HTTP ${content.status} ${(await content.text().catch(() => "")).slice(0, 120)}` };
        }

        /*
         * ⭐ 容器按**真实字节**说话（审计 P228），并且**流式落盘**（P230）：
         * 原来一律写 `.mp4`、还把整个 body `arrayBuffer()` 一次性读进主进程内存
         * （几十上百 MB 的成品 = 峰值两倍以上）。现在先记下头几个字节判容器，
         * 再管道写盘、顺带记字节数并封顶，最后按判出来的扩展名改名。
         */
        const dir = assetsDir();
        await fs.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
        const target = path.join(dir, `video-${stamp}.tmp`);
        let bytes = 0;
        let head = Buffer.alloc(0);
        const keeper = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            if (bytes > VIDEO_MAX_BYTES) {
              cb(new Error(`成品超过上限（${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)}MB）—— 拒绝落盘`));
              return;
            }
            if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
            cb(null, chunk);
          },
        });
        try {
          if (content.body) {
            await pipeline(Readable.fromWeb(content.body as never), keeper, createWriteStream(target));
          } else {
            const buf = Buffer.from(await content.arrayBuffer());
            await pipeline(Readable.from([buf]), keeper, createWriteStream(target));
          }
        } catch (error) {
          await fs.rm(target, { force: true });
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const { ext, isKnown } = videoExtensionFor(content.headers.get("content-type"), head);
        const name = `video-${stamp}${ext}`;
        await fs.rename(target, path.join(dir, name));
        return {
          ok: true,
          name,
          url: `dshasset://${name}`,
          bytes,
          ms: Date.now() - started,
          model: chosen,
          ...(isKnown ? {} : { note: "上游没给容器信息，按 .mp4 存 —— 若播不出来，八成是容器没认对" }),
        };
      }
    }
    return { ok: false, error: `等待超时（5 分钟）${lastNote ? `；最后看到：${lastNote}` : ""}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 注册视频 IPC。
 * @param ipcMain Electron 的 ipcMain
 */
export function registerVideoIpc(ipcMainInstance: Electron.IpcMain): void {
  ipcMainInstance.handle(VIDEO_CHANNEL.listModels, (): Promise<string[]> => listVideoModels());
  ipcMainInstance.handle(VIDEO_CHANNEL.generate, (_event, prompt: string, model?: string) =>
    generateVideo(String(prompt ?? ""), model),
  );
}
