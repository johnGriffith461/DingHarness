import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, nativeImage, net, protocol } from "electron";
import { normalize } from "../../shared/imageSize";
import { humanFailure } from "../../shared/errors";
import { fetchRemote } from "../../engine/runtime/modelGate";

/**
 * 图像生成（对标原版画布的核心用途：`aiCreation_canvas_toolbar_imageGenerator`）。
 *
 * ## 为什么要自定义协议
 * 生成图是 2~3 MB 的 PNG。现有图片节点是**内联 base64** 存进文档的，
 * 照这个路子走，一张生成图会让快照膨胀到 4 MB 左右，再乘上版本历史的份数 —— 不可接受。
 * 所以生成图**落盘**，文档里只留文件名，渲染侧用 `dshasset://<文件名>` 直接引用。
 *
 * 选自定义协议而不是 `file://`：应用在开发态是从 `http://localhost` 加载的，
 * `file://` 会被 webSecurity 拦掉，只能开发/打包两套逻辑；自定义协议一次解决，
 * 而且**能在这里做路径穿越防护**（`file://` 做不到）。
 *
 * ## 通道来源
 * 走 OpenAI 兼容的 `POST {base}/images/generations`，返回 `b64_json`。
 */

export const ASSET_SCHEME = "dshasset";

export const IMAGE_CHANNEL = {
  /** 列出可用的图像模型（只列真的配了密钥的）。 */
  listModels: "image:listModels",
  /** 生成一张图，落盘后返回文件名。 */
  generate: "image:generate",
  /** 以一张已有图为输入做编辑（图生图，对标原版图片动作）。 */
  edit: "image:edit",
};

/** 图像通道定义（base 与模型名是配置，不是硬编码的可调参数）。 */
export type ImageProviderDef = {
  id: string;
  label: string;
  baseURL: string;
  /** 凭据引用名（**不是**密钥本体）。 */
  keyRef: string;
  models: string[];
  note: string;
};

/**
 * 图像通道表。
 *
 * ⚠️ 这里**不再维护尺寸白名单**。早期版本硬编码了三个尺寸，是错的 ——
 * Lunora 的尺寸是一套**离散枚举 + 确定性规整**的规则（8 个比例 × 3 个档位 + 自定义宽高，
 * 外加"宽高必为 16 倍数 / 单边 ≤3840 / 比例 ≤3:1 / 像素 655360~8294400"的规整），
 * 硬编码三个值等于把绝大部分能力关掉。完整规则实现在 `src/ai/imageSize.ts`，
 * 渲染侧算好最终 `size` 字符串再传进来，这里只做一次形态校验。
 */
export const IMAGE_PROVIDERS: ImageProviderDef[] = [
  {
    id: "lunora",
    label: "Lunora 图像",
    baseURL: "https://api.uselunora.com/v1",
    keyRef: "LUNORA_API_KEY",
    models: ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
    note: "OpenAI 兼容，返回 b64_json；单张约 30 秒",
  },
];

/** 提交前对 size 做一次形态校验：`auto` 或 `WxH`（且是 16 的倍数、在合法范围内）。 */
function sanitizeSize(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed === "auto") return "auto";
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(trimmed);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w % 16 !== 0 || h % 16 !== 0) return undefined;
  if (w > 3840 || h > 3840) return undefined;
  if (Math.max(w / h, h / w) > 3) return undefined;
  const area = w * h;
  if (area < 655_360 || area > 8_294_400) return undefined;
  return `${w}x${h}`;
}

/** 生成图与导入素材共用的落盘目录。 */
export function assetsDir(): string {
  return path.join(app.getPath("userData"), "assets");
}

/**
 * 注册自定义协议（必须在 app ready **之前**调用）。
 *
 * `standard: true` 让它按标准 URL 解析（有 host/path 语义），
 * `supportFetchAPI` 让渲染侧能用 fetch 取（导出、再编辑都要用到）。
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** 只允许访问 assets 目录下的普通文件，挡掉 `..` 穿越与子目录。 */
function resolveAsset(name: string): string | null {
  if (!name || typeof name !== "string") return null;
  // 只取最后一段，任何路径分隔符都丢掉
  const base = path.basename(name);
  if (base !== name) return null;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(base)) return null;
  const file = path.join(assetsDir(), base);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

/**
 * 把"云盘/产物/导出"里的一个文件名解析成绝对路径。
 *
 * ## 为什么要走 path 而不是 host
 * `dshasset://文件名` 这种写法靠 URL 的 host 传名字，而 **standard 协议会把 host 小写化** ——
 * 生成图的名字是小写安全字符所以没事，但云盘里的文件叫「产品周报.md」「封面图.png」，
 * 小写化之后根本取不到。所以这里走 **path**：`dshasset://file/<origin>/<名字>`，
 * host 固定是 `file`（小写无所谓），名字放在 path 里保留大小写。
 *
 * ## 边界
 * `origin` 只认三个白名单值，名字只取最后一段（挡 `..` 穿越），
 * 最终必须在对应目录之下。渲染进程给的东西一律按不可信处理。
 *
 * @param origin 来源：artifact / export / drive
 * @param rawName 文件名
 * @returns 绝对路径；任何一步不通过都返回 null
 */
function resolveOwnedFile(origin: string, rawName: string): string | null {
  const dirs: Record<string, string> = {
    artifact: path.join(app.getPath("userData"), "artifacts"),
    export: path.join(app.getPath("userData"), "exports"),
    drive: path.join(app.getPath("userData"), "drive"),
    // 生成图自己那本（§166）：加上它，生成的图才能当图生图的输入、也能被云盘引用
    asset: assetsDir(),
  };
  const dir = dirs[origin];
  if (!dir) return null;

  const name = decodeURIComponent(String(rawName ?? ""));
  if (!name || name !== path.basename(name)) return null;
  const file = path.join(dir, name);
  const rel = path.relative(dir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

/** 接上协议处理器（app ready **之后**调用）。 */
export function serveAssets(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);

    // dshasset://file/<origin>/<名字> —— 产物 / 导出 / 云盘里的文件
    if (url.hostname === "file") {
      const parts = url.pathname.replace(/^\//, "").split("/");
      const owned = resolveOwnedFile(parts[0] ?? "", parts.slice(1).join("/"));
      if (!owned) return new Response("not found", { status: 404 });
      return net.fetch(`file://${owned.replace(/\\/g, "/")}`);
    }

    // dshasset://gen-xxx.png —— 生成的图（host 是文件名，小写安全字符）
    const name = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ""));
    const file = resolveAsset(name) ?? resolveAsset(url.pathname.replace(/^\//, ""));
    if (!file) return new Response("not found", { status: 404 });
    return net.fetch(`file://${file.replace(/\\/g, "/")}`);
  });
}

/** 把一段图片字节落盘，返回文件名与字节数。 */
function saveBuffer(buf: Buffer, hint: string): { name: string; bytes: number } {
  const dir = assetsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  // 文件名只用小写安全字符：standard 协议会把 host 小写化，大小写混用会取不到
  const safeHint = hint.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28) || "gen";
  const name = `${safeHint}-${stamp}.png`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, bytes: buf.length };
}

/** 把 base64 图落盘，返回文件名。 */
function saveBase64Image(base64: string, hint: string): { name: string; bytes: number } {
  return saveBuffer(Buffer.from(base64, "base64"), hint);
}

export type GenerateImageResult =
  | { ok: true; name: string; url: string; bytes: number; ms: number; model: string; size?: string }
  | { ok: false; error: string };

/** 图生图请求。 */
export type EditImageRequest = {
  /** 输入图：`dshasset://<name>` 或 `data:image/...;base64,...`（就是节点上的 src）。 */
  source: string;
  /** 编辑指令（"把背景换成…" 这类）。 */
  prompt: string;
  model?: string;
  /** 输出尺寸；省略则沿用输入图规整后的尺寸。 */
  size?: string;
};

/** 图生图结果，比文生图多一条"输入被规整过"的信息。 */
export type EditImageResult =
  | ({
      ok: true;
    } & { name: string; url: string; bytes: number; ms: number; model: string; size: string; inputNote?: string })
  | { ok: false; error: string };

/**
 * 把输入图读成 buffer。
 *
 * @param source `dshasset://<name>` 或 data URL
 * @returns PNG 字节；读不到返回 null
 */
function readSourceImage(source: string): Buffer | null {
  const text = String(source ?? "");
  if (text.startsWith(`${ASSET_SCHEME}://`)) {
    const name = text.slice(`${ASSET_SCHEME}://`.length);
    const file = resolveAsset(name);
    if (!file) return null;
    return fs.readFileSync(file);
  }
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(text);
  if (m) return Buffer.from(m[1], "base64");
  return null;
}

/**
 * 把输入图规整成上游接受的尺寸。
 *
 * **这是图生图能不能成的关键**：实测拿一张 64×64 的小图去调 `/images/edits`，
 * 上游回的是 `502 Upstream service temporarily unavailable`（一个毫无指向性的通用错误）；
 * 换成规格内的 1024×1024 立刻 200。也就是说**输入尺寸不合规会被伪装成"上游挂了"**，
 * 排查时极容易被误导。所以这里在读图之后、发请求之前先把尺寸规整好。
 *
 * 缩放用 Electron 自带的 `nativeImage.resize`，不引图像库。
 */
function normalizeInputImage(raw: Buffer): { buffer: Buffer; note?: string; size: string } | null {
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) return null;

  const { width, height } = image.getSize();
  const [w, h] = normalize(width, height);

  if (w === width && h === height) {
    // 已经合规：原样送，避免一次无意义的重编码（会掉画质）
    return { buffer: raw, size: `${width}x${height}` };
  }

  const resized = image.resize({ width: w, height: h, quality: "best" });
  return {
    buffer: resized.toPNG(),
    note: `输入图 ${width}×${height} 不符合模型限制，已规整为 ${w}×${h}`,
    size: `${w}x${h}`,
  };
}

export function registerImageIpc(): void {
  ipcMain.handle(IMAGE_CHANNEL.listModels, async () => {
    const { resolveSecret } = await import("../../engine/runtime/credentials");
    return IMAGE_PROVIDERS.filter((p) => Boolean(resolveSecret(p.keyRef))).map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      note: p.note,
    }));
  });

  ipcMain.handle(
    IMAGE_CHANNEL.generate,
    async (_event, request: { prompt: string; model?: string; size?: string }) => {
      const { resolveSecret } = await import("../../engine/runtime/credentials");
      const provider = IMAGE_PROVIDERS.find((p) => Boolean(resolveSecret(p.keyRef)));
      if (!provider) {
        return {
          ok: false,
          error: `没有可用的图像通道（需要 ${IMAGE_PROVIDERS.map((p) => p.keyRef).join(" 或 ")}）`,
        } satisfies GenerateImageResult;
      }

      const prompt = String(request?.prompt ?? "").trim();
      if (!prompt) return { ok: false, error: "提示词是空的" } satisfies GenerateImageResult;

      const model = provider.models.includes(String(request?.model)) ? String(request.model) : provider.models[0];
      const size = sanitizeSize(request?.size);

      const started = Date.now();
      try {
        const body: Record<string, unknown> = { model, prompt, n: 1 };
        // auto 模式**不发 size 参数**（规格 §5：由模型自行决定）；
        // 其它情况传规整好的 WxH
        if (size && size !== "auto") body.size = size;

        const res = await fetchRemote(`${provider.baseURL}/images/generations`, "生成图片", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resolveSecret(provider.keyRef)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          // 实测单张约 30 秒；给 3 分钟余量，超时就把真实原因报出去，不要静静挂着
          signal: AbortSignal.timeout(180_000),
        });

        const text = await res.text();
        if (!res.ok) {
          /*
           * ⚠️ 先**说人话**再附原文（Phase 13.1）：原来是 `上游 429：{...}` ——
           * 裸状态码对用户没有信息量。现在统一走 `humanFailure`：
           * 它把原因翻成"限流/欠费/审核没过…"，并把上游原文附在后面（查账要用）。
           * 判定要看**状态码 + 原文**一起：单看原文会漏掉那些只回码不回话的上游。
           */
          return { ok: false, error: humanFailure(`上游 ${res.status} ${text.slice(0, 300)}`, { keepDetail: true }) } satisfies GenerateImageResult;
        }

      let json: { data?: Array<{ b64_json?: string; url?: string }> } = {};
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: `上游返回的不是 JSON：${text.slice(0, 200)}` } satisfies GenerateImageResult;
      }

      const item = json.data?.[0];
      if (item?.b64_json) {
        const { name, bytes } = saveBase64Image(item.b64_json, model);
        return {
          ok: true,
          name,
          url: `${ASSET_SCHEME}://${name}`,
          bytes,
          ms: Date.now() - started,
          model,
          size,
        } satisfies GenerateImageResult;
      }
      if (item?.url) {
        const imgRes = await fetchRemote(item.url, "下载生成的图片", { signal: AbortSignal.timeout(120_000) });
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const dir = assetsDir();
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
        const name = `${model.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24)}-${stamp}.png`;
        fs.writeFileSync(path.join(dir, name), buf);
        return {
          ok: true,
          name,
          url: `${ASSET_SCHEME}://${name}`,
          bytes: buf.length,
          ms: Date.now() - started,
          model,
          size,
        } satisfies GenerateImageResult;
      }
      return { ok: false, error: "上游没有返回图片数据" } satisfies GenerateImageResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `生成失败：${message}` } satisfies GenerateImageResult;
    }
  });

  ipcMain.handle(IMAGE_CHANNEL.edit, async (_event, request: EditImageRequest) => {
    const { resolveSecret } = await import("../../engine/runtime/credentials");
    const provider = IMAGE_PROVIDERS.find((p) => Boolean(resolveSecret(p.keyRef)));
    if (!provider) {
      return { ok: false, error: "没有可用的图像通道" } satisfies EditImageResult;
    }

    const prompt = String(request?.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "编辑指令是空的" } satisfies EditImageResult;

    const raw = readSourceImage(String(request?.source ?? ""));
    if (!raw) return { ok: false, error: "读不到输入图（节点上没有可用的图片数据）" } satisfies EditImageResult;

    const prepared = normalizeInputImage(raw);
    if (!prepared) return { ok: false, error: "输入图解不开（不是有效的图片）" } satisfies EditImageResult;

    const model = provider.models.includes(String(request?.model)) ? String(request.model) : provider.models[0];
    const wantSize = sanitizeSize(request?.size);
    const size = wantSize && wantSize !== "auto" ? wantSize : prepared.size;

    const started = Date.now();
    try {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      /**
       * Buffer → Blob 要显式拷成 `Uint8Array`。
       * Node 的 Buffer 底层是 `ArrayBufferLike`（可能是 SharedArrayBuffer），
       * 而 BlobPart 要的是 `ArrayBufferView<ArrayBuffer>`，直接传过不了类型检查。
       * 这点拷贝相对于一张几 MB 的图可以忽略。
       */
      form.append("image", new Blob([new Uint8Array(prepared.buffer)], { type: "image/png" }), "input.png");
      form.append("size", size);

      const res = await fetchRemote(`${provider.baseURL}/images/edits`, "编辑图片", {
        method: "POST",
        // multipart：**不要**手写 Content-Type，让 fetch 自己带 boundary，否则上游解析不了
        headers: { Authorization: `Bearer ${resolveSecret(provider.keyRef)}` },
        body: form,
        signal: AbortSignal.timeout(240_000),
      });

      const text = await res.text();
      if (!res.ok) {
        // 同上面那张：先说人话，再附原文（口径见 Phase 13.1 的 shared/errors.ts）
        return {
          ok: false,
          error: humanFailure(`上游 ${res.status} ${text.slice(0, 300)}`, { keepDetail: true }),
        } satisfies EditImageResult;
      }

      let json: { data?: Array<{ b64_json?: string; url?: string }> } = {};
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: `上游返回的不是 JSON：${text.slice(0, 200)}` } satisfies EditImageResult;
      }

      const item = json.data?.[0];
      if (!item) return { ok: false, error: "上游没有返回图片数据" } satisfies EditImageResult;

      let buffer: Buffer;
      if (item.b64_json) {
        buffer = Buffer.from(item.b64_json, "base64");
      } else if (item.url) {
        const imgRes = await fetchRemote(item.url, "下载生成的图片", { signal: AbortSignal.timeout(120_000) });
        buffer = Buffer.from(await imgRes.arrayBuffer());
      } else {
        return { ok: false, error: "上游没有返回图片数据" } satisfies EditImageResult;
      }

      const { name } = saveBuffer(buffer, `${model}-edit`);
      return {
        ok: true,
        name,
        url: `${ASSET_SCHEME}://${name}`,
        bytes: buffer.length,
        ms: Date.now() - started,
        model,
        size,
        ...(prepared.note ? { inputNote: prepared.note } : {}),
      } satisfies EditImageResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `编辑失败：${message}` } satisfies EditImageResult;
    }
  });
}
