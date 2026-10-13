/**
 * 对话产物（阶段 11.1，对标原版右侧「对话产物」面板）。
 *
 * 原版的任务不是只回一段话 —— 它会**产出文件**：Word、PPT、表格、画布、图片。
 * 这些产物进右侧「对话产物」列表，点开就是成品。
 *
 * 这里定两件事，都用纯逻辑做、能离线验证：
 *
 *   1. **产物怎么从模型输出里出来**：用 `<artifact type="…" title="…">…</artifact>`
 *      标记块。跟提问卡用 `<ask>` 是同一套思路 —— 为什么不用 JSON mode：
 *      一条回复里往往**既有给人看的话、又有产物**，JSON mode 表达不了这种混合。
 *
 *   2. **类型的落地口径**：每种产物写到磁盘时的扩展名与 mime。
 *      这个表是"再接一种格式只要加一行"的扩展点。
 */

/** 产物类型。 */
export type ArtifactKind =
  | "markdown"
  | "docx"
  | "pptx"
  | "xlsx"
  | "html"
  | "code"
  | "image"
  | "canvas";

/** 产物的生成状态（对齐上位的 `ArtifactStatus`）。 */
export type ArtifactStatus = "generating" | "generated" | "failed";

/** 一个产物。 */
export type Artifact = {
  id: string;
  /** 产出它的任务。 */
  taskId: string;
  /**
   * 产出它的那条消息（步骤）id。
   *
   * 上位是在**对话流里**把产物显示成卡片的（实机看到：卡片带标题与「创建时间: 10-11 14:09」，
   * 右上角有打开图标）。所以产物必须知道自己属于哪一条消息 ——
   * 只存在右侧面板里会丢掉"这句话产出了这个东西"这层对应关系。
   */
  stepId?: string;
  title: string;
  kind: ArtifactKind;
  createdAt: number;
  /** 生成状态；界面据此显示「标题生成中...」等中间态。 */
  status?: ArtifactStatus;
  /** 文本类产物的正文（markdown / html / code）。 */
  content?: string;
  /** 二进制或已落盘产物的文件名（相对产物目录）。 */
  filePath?: string;
  /** 产物的字节数（落盘后回填，界面显示用）。 */
  bytes?: number;
  /** 目标格式生成失败时的降级说明。 */
  note?: string;
};

/** 每种类型的落盘口径。加新格式只加一行。 */
export type ArtifactFormat = {
  ext: string;
  mime: string;
  /**
   * 渲染进程是不是**发文本**过来。
   *
   * ⚠️ 这不等于"文件里就是那段文本"：`docx/pptx/xlsx` 也标 true，
   * 但主进程会用 `officeWrite` **真的构造出 ZIP 格式**，不是把 Markdown 写进去。
   * 标 true 只表示"跨进程传的是字符串"，binary 走的才是 Uint8Array。
   */
  textBased: boolean;
  /** 界面上的短标签。 */
  label: string;
};

export const ARTIFACT_FORMATS: Record<ArtifactKind, ArtifactFormat> = {
  markdown: { ext: "md", mime: "text/markdown", textBased: true, label: "文档" },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", textBased: true, label: "Word" },
  pptx: { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", textBased: true, label: "PPT" },
  xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", textBased: true, label: "表格" },
  html: { ext: "html", mime: "text/html", textBased: true, label: "网页" },
  code: { ext: "txt", mime: "text/plain", textBased: true, label: "代码" },
  image: { ext: "png", mime: "image/png", textBased: false, label: "图片" },
  canvas: { ext: "json", mime: "application/json", textBased: true, label: "画布" },
};

/** 产物块的标记。 */
export const ARTIFACT_OPEN = "<artifact";
export const ARTIFACT_CLOSE = "</artifact>";

/**
 * 把模型写的类型名归一成我们的枚举。
 * 模型不一定听话，常见别名都要认。
 */
const KIND_ALIASES: Record<string, ArtifactKind> = {
  md: "markdown",
  markdown: "markdown",
  doc: "docx",
  docx: "docx",
  word: "docx",
  ppt: "pptx",
  pptx: "pptx",
  slides: "pptx",
  excel: "xlsx",
  xls: "xlsx",
  xlsx: "xlsx",
  sheet: "xlsx",
  csv: "xlsx",
  html: "html",
  web: "html",
  code: "code",
  py: "code",
  js: "code",
  ts: "code",
  sh: "code",
  text: "code",
  txt: "code",
  image: "image",
  png: "image",
  jpg: "image",
  canvas: "canvas",
  json: "canvas",
};

/** 归一类型名；认不出来按 markdown 处理（最通用）。 */
export function normalizeKind(raw: string | undefined): ArtifactKind {
  const key = String(raw ?? "").trim().toLowerCase();
  return KIND_ALIASES[key] ?? "markdown";
}

/** 从一段标签属性串里取属性的值（`type="docx"` / `title='周报'`）。 */
function attr(source: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(source);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** 产物正文里若把整段包在围栏里，去掉围栏（模型常这么干）。 */
function unwrapFence(body: string): string {
  const trimmed = body.trim();
  const m = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

/**
 * 语言标记 → 产物类型（模型没用 `<artifact>` 标签时的兜底）。
 *
 * 只列**明确是"一整份产物"**的语言：`html`/`python` 这种多半是一整段独立东西；
 * 而 `bash`/`sh`/`json` 更常是解释里的一小段，不该变成文件。
 */
const FENCE_KIND: Record<string, ArtifactKind> = {
  html: "html",
  htm: "html",
  svg: "html",
  markdown: "markdown",
  md: "markdown",
};

/** 兜底提取的门槛：少于这么多字符就当是解释里的片段，不动它。 */
const FENCE_MIN_CHARS = 400;

/**
 * 兜底提取：模型没用 `<artifact>` 标签时，把**唯一的那个大代码块**当产物。
 *
 * ## 为什么需要
 * 系统提示词要求模型用 `<artifact type="…">` 包起来，但**模型不总是照做** ——
 * 实测里让它「输出一个单文件页面」，它直接给了一段 ```` ```html ```` 代码块。
 * 上位那边产物是服务端决定的，不管模型怎么写都会落成卡片；
 * 我们只认标签的话，同样一次生成就变成"什么都没有"，用户得自己去正文里复制。
 *
 * ## 为什么门槛定得这么高
 * 一个解释里可能夹好几段小代码。**只认"恰好一段、且足够长"**的情况：
 * 这样只会误判"这明显是一整份东西"，而不会把解释里的片段都变成文件。
 *
 * @param source 正文
 * @returns 提取到的产物与去掉代码块后的正文
 */
export function extractFencedArtifact(
  source: string,
): { text: string; artifact: { kind: ArtifactKind; content: string } | null } {
  const fences = [...source.matchAll(/```([A-Za-z0-9+#-]*)\n([\s\S]*?)```/g)];
  if (fences.length !== 1) return { text: source, artifact: null };

  const [match] = fences;
  const lang = (match[1] ?? "").toLowerCase();
  const kind = FENCE_KIND[lang];
  const content = match[2] ?? "";
  if (!kind || content.trim().length < FENCE_MIN_CHARS) return { text: source, artifact: null };

  const text = `${source.slice(0, match.index)}${source.slice((match.index ?? 0) + match[0].length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, artifact: { kind, content: content.replace(/^\n+|\n+$/g, "") } };
}

/**
 * 从模型输出里提取产物，并返回去掉产物块后的正文。
 *
 * @param raw 模型原始输出
 * @param taskId 归属的任务
 * @param now 生成时间（调用方传入，便于测试）
 * @param nextId 生成 id 的函数（避免这里依赖随机数）
 * @param stepId 产出它们的消息 id（界面据此在对话流里显示卡片）
 * @returns `text` = 给用户看的正文；`artifacts` = 提取到的产物
 */
export function extractArtifacts(
  raw: string,
  taskId: string,
  now: number,
  nextId: (index: number) => string,
  stepId?: string,
): { text: string; artifacts: Artifact[] } {
  const source = String(raw ?? "");
  const artifacts: Artifact[] = [];
  let text = "";
  let cursor = 0;

  while (true) {
    const start = source.indexOf(ARTIFACT_OPEN, cursor);
    if (start === -1) break;
    const tagEnd = source.indexOf(">", start);
    if (tagEnd === -1) break;
    const close = source.indexOf(ARTIFACT_CLOSE, tagEnd);
    if (close === -1) break;

    text += source.slice(cursor, start);

    const tag = source.slice(start, tagEnd);
    const body = unwrapFence(source.slice(tagEnd + 1, close));
    const kind = normalizeKind(attr(tag, "type"));
    const title = (attr(tag, "title") ?? attr(tag, "name") ?? "").trim();

    // 空产物不记（模型偶尔会先写个空壳）
    if (body.trim()) {
      artifacts.push({
        id: nextId(artifacts.length),
        taskId,
        ...(stepId ? { stepId } : {}),
        title: title || defaultTitle(kind, artifacts.length + 1),
        kind,
        createdAt: now,
        content: body,
      });
    }

    cursor = close + ARTIFACT_CLOSE.length;
  }

  text += source.slice(cursor);
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // 一段标签产物都没有 → 走兜底：唯一的大代码块当产物
  if (artifacts.length === 0) {
    const fallback = extractFencedArtifact(text);
    if (fallback.artifact) {
      const { kind, content } = fallback.artifact;
      /*
       * 标题尽量从内容里取，而不是一律叫「网页1」。
       * HTML 的标题在 `<title>` 里、Markdown 在 `# ` 里 —— 取不到再退到泛化名字。
       */
      const fromHtml = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(content)?.[1];
      const title = (fromHtml ?? titleFromContent(content)).trim() || defaultTitle(kind, 1);
      artifacts.push({
        id: nextId(0),
        taskId,
        ...(stepId ? { stepId } : {}),
        title,
        kind,
        createdAt: now,
        content,
      });
      text = fallback.text;
    }
  }

  return { text, artifacts };
}

/** 没给标题时按类型起一个。 */
function defaultTitle(kind: ArtifactKind, index: number): string {
  return `${ARTIFACT_FORMATS[kind].label}${index}`;
}

/**
 * 产物的落盘文件名。
 *
 * 落盘前要做安全处理：标题直接当文件名会带 `/`、`\`、`:` 这些字符，
 * 或者干脆叫 `.` / `..`。这里统一替换成 `-` 并限长。
 *
 * @param artifact 产物
 * @returns 形如 `产品周报.docx`；同名冲突由调用方加序号
 */
export function artifactFileName(artifact: Pick<Artifact, "title" | "kind">): string {
  const ext = ARTIFACT_FORMATS[artifact.kind].ext;
  const safe = artifact.title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${safe || "产物"}.${ext}`;
}

/**
 * 从 markdown 正文里推一个像样的标题（模型忘了给 title 时兜底）。
 * 取正文第一个标题行，没有就取第一行。
 */
export function titleFromContent(content: string): string {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (heading) return heading[1].slice(0, 60);
  }
  const first = lines.find((l) => l.trim());
  return (first ?? "").trim().replace(/^[-*·•]\s*/, "").slice(0, 60);
}
