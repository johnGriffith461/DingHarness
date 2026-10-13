import { acceptQuestions, type TaskOption, type TaskQuestion } from "./task";
import { ARTIFACT_CLOSE, ARTIFACT_OPEN } from "./artifact";
import { truncatedNote } from "./history";

/**
 * 任务智能体的两段式流程（阶段 10）。
 *
 * 原版实测的行为是：**先问清关键信息，再动笔**。它自己在回复里写着
 * 「在动笔前，我需要确认一两个关键信息，避免凭空编造内容～」，
 * 然后弹出最多 3 题的澄清提问卡。
 *
 * 这里把那套行为落成两段提示词 + 一个**可解析的约定**：
 *
 *   第 1 段（ask）：让模型判断"信息够不够"。不够就按约定吐一段 `<ask>` 块，
 *                   内含最多 3 个问题，每题 2~3 个选项（主文案 + 一行说明）。
 *   第 2 段（do）：把用户的回答拼回去，让它真正产出内容。
 *
 * 为什么要自己定 `<ask>` 块而不是用 JSON mode：模型一旦进 JSON mode，
 * 就没法同时输出"给用户看的那句话"了 —— 而原版是**一句话 + 一张提问卡**并存。
 * 用标记块能表达"哪一段是给人看的、哪一段是给程序看的"。
 */

/**
 * 把用户给的**资料**拼到这一轮的要求后面（2026-10-14）。
 *
 * ## 为什么要单独一个函数
 * 输入区那条占位文案是本体原话 ——「发消息或创建任务... / 使用技能 @ 添加资料」，
 * 而 `@` 在我们这里只出了常用语（那一句证据来自 **coding 聊天**：
 * `输入"@"唤起常用语`）—— 于是**界面承诺了"添加资料"，功能没做**。
 * 用户把文件交给 agent 是它的主要用法之一（"把这份资料整理成 PPT"），
 * 所以这次把资料补上：选文件 → 附着在输入区 → 发送时内容随请求过去。
 *
 * 集中在这里的理由与产物格式那一段相同：**三段提示词（问 / 干 / 接着说）都要带资料**，
 * 各写一份迟早有一处漏掉，而"模型看不见资料"从现象上很难定位。
 *
 * @param user 原本要给模型的这一轮内容
 * @param material 资料块（`fileContextBlock` 的产物）；空则原样返回
 */
export function withMaterial(user: string, material?: string): string {
  if (!material || !material.trim()) return user;
  return `${user}\n\n${material}`;
}

/** 提问块的标记。用少见标签，避免和正文里的尖括号冲突。 */
export const ASK_OPEN = "<ask>";
export const ASK_CLOSE = "</ask>";

/** 第 1 段：判断要不要提问。 */
export function buildAskPrompt(
  userMessage: string,
  background: string[] = [],
  material?: string,
): { system: string; user: string } {
  const system = [
    "你是一个任务助手。用户给你一句话，你要判断：**只凭这句话，能不能直接把活干好**。",
    "",
    "如果能（例如用户已经把关键信息都给全了），就直接干活，正常输出结果。",
    "如果不能（缺少对象、范围、格式、目标等关键信息），就在给用户的说明之后，",
    `追加一段提问块，格式严格要求如下：`,
    "",
    `${ASK_OPEN}`,
    "问题一？",
    "- 选项主文案 | 一行补充说明",
    "- 选项主文案 | 一行补充说明",
    "问题二？",
    "- 选项主文案 | 一行补充说明",
    "- 选项主文案 | 一行补充说明",
    `${ASK_CLOSE}`,
    "",
    "提问块的规则：",
    "1. 最多 3 个问题，每个问题 2~3 个选项；宁少勿多。",
    "2. 选项要**贴着用户当前这句话能推断出的场景**来给，不要给放之四海皆准的空话。",
    "3. 选项的补充说明写清「选了之后你会怎么做」，一行以内。",
    "4. 给用户的说明要自然、简短，说清你为什么要问。",
    "5. 不要把提问块放进代码块里，也不要加别的前后缀。",
  ].join("\n");

  const backgroundBlock = background.length
    ? `\n\n【已经问过并得到回答的背景】\n${background.map((b, i) => `${i + 1}. ${b}`).join("\n")}`
    : "";
  return { system, user: withMaterial(`${userMessage}${backgroundBlock}`, material) };
}

/** 第 2 段：拿着回答干活。 */
/**
 * 产物块的规则。
 *
 * **抽出来共用**：`buildDoPrompt`（首次干活）与 `buildFollowUpPrompt`（接着聊）
 * 用的是同一套产物格式 —— 各写一份的话，改了一处另一处就悄悄过期，
 * 而"模型给的产物块格式不对"这种错很难从现象上发现是哪一处漏改的。
 */
const ARTIFACT_RULES = [
  "## 产物要怎么给",
  "如果这个任务该给出一份**成品文件**（文档、PPT、表格、网页、代码、画布），",
  "就把它放进产物块里，格式严格要求如下：",
  "",
  `${ARTIFACT_OPEN} type="类型" title="标题">`,
  "（成品内容，用 Markdown 写）",
  `${ARTIFACT_CLOSE}`,
  "",
  "类型只能从这些里选（选最贴切的）：",
  "- `docx` Word 文档 ｜ `pptx` 演示文稿 ｜ `xlsx` 表格",
  "- `markdown` 普通文档 ｜ `html` 网页 ｜ `code` 代码 ｜ `canvas` 画布",
  "",
  "产物块的规则：",
  "1. 标题要具体（例如「产品周报（拼多多家纺店）」），不要写「文档」这种空标题。",
  "2. 块里就是**成品的完整内容**，不要写「以下是内容」这类废话。",
  "3. 正文里可以用一两句话说明你给了什么，但**不要把成品的正文再抄一遍**。",
  "4. 一条回复可以给多个产物块（例如同时给一份文档和一张表格）。",
  "5. 不需要成品的任务（例如只是回答问题）就不要产物块，正常回答即可。",
].join("\n");

export function buildDoPrompt(
  userMessage: string,
  answers: string[],
  material?: string,
): { system: string; user: string } {
  const system = [
    "你是一个任务助手。用户此前提出了一个任务，你已经问清了关键信息，现在开始干活。",
    "不要再反问、不要解释你会怎么做，直接给成品。",
    "",
    ARTIFACT_RULES,
  ].join("\n");
  const answerBlock = answers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return { system, user: withMaterial(`任务：${userMessage}\n\n我提供的关键信息：\n${answerBlock}`, material) };
}

/**
 * 「在同一段对话里接着聊」的提示词（§147）。
 *
 * 与 `buildDoPrompt` 的关键区别：**这里不再把"任务"复述一遍** ——
 * 前因后果都在 `messages` 的历史里，复述反而会让模型以为用户又提了一次同样的要求。
 * 所以 `user` 就是用户这一句原话。
 *
 * @param userMessage 用户这一句
 * @param truncated 历史是否被截断（截断时要把"你看不到全部"告诉模型）
 */
export function buildFollowUpPrompt(
  userMessage: string,
  truncated = false,
  material?: string,
): { system: string; user: string } {
  const system = [
    "你是一个任务助手。用户在与你的**同一段对话**里继续说了一句，请接着上文回应。",
    "前面已经问过、答过、给过的内容不要重复问；不确定的事直接说不确定，不要猜。",
    "",
    ARTIFACT_RULES,
    ...(truncated ? ["", truncatedNote()] : []),
  ].join("\n");
  return { system, user: withMaterial(userMessage, material) };
}

/**
 * 把"选项主文案 | 说明"解析出来。
 * 分隔符允许 `|` / `｜` / ` - `（模型不一定听话）。
 */
function parseOption(line: string): TaskOption | null {
  const cleaned = line.replace(/^[-*·•]\s*/, "").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s*[|｜]\s*|\s+[-–—]\s+/);
  const label = (parts[0] ?? "").trim();
  if (!label) return null;
  const hint = (parts.slice(1).join(" ").trim() || "").slice(0, 60);
  return { label: label.slice(0, 40), hint };
}

/**
 * 从模型输出里解析出"给人看的正文"与"提问卡"。
 *
 * @param raw 模型原始输出
 * @returns `text` = 去掉提问块后的正文；`questions` = 提问卡（最多 3 题，可能为空）
 */
export function parseAskReply(raw: string): { text: string; questions: TaskQuestion[] } {
  const source = String(raw ?? "");
  const start = source.indexOf(ASK_OPEN);
  const end = source.indexOf(ASK_CLOSE);

  // 没有完整标记块 → 全是正文（模型选择直接干活）
  if (start === -1 || end === -1 || end < start) {
    return { text: stripMarkers(source).trim(), questions: [] };
  }

  const text = stripMarkers(source.slice(0, start)).trim();
  const block = source.slice(start + ASK_OPEN.length, end);

  const questions: TaskQuestion[] = [];
  let current: TaskQuestion | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const isOption = /^[-*·•]\s+/.test(line);
    if (isOption) {
      if (!current) continue;
      const option = parseOption(line);
      // 每题最多 3 个选项（原版实测就是这个量级）
      if (option && current.options.length < 3) current.options.push(option);
      continue;
    }

    // 既不是选项、又已经有当前问题 → 判定为新问题的问句
    if (current) questions.push(current);
    current = { id: `q${questions.length + 1}`, text: line.replace(/^\d+[.、)]\s*/, "").slice(0, 120), options: [] };
  }
  if (current) questions.push(current);

  // 只有"有问句且至少两个选项"的问题才留（一个选项的问句还不如让用户自己写）
  const usable = questions.filter((q) => q.text && q.options.length >= 2);
  return { text, questions: acceptQuestions(usable) };
}

/** 去掉可能残留的标记（模型偶尔会把结束标记拆两行写）。 */
function stripMarkers(s: string): string {
  return s.replace(new RegExp(ASK_OPEN, "g"), "").replace(new RegExp(ASK_CLOSE, "g"), "");
}

/**
 * 把一条回答说成一行背景（喂给第二段提示词，也显示在对话流里）。
 * @param question 被回答的问题
 * @param option 用户选的选项（自己写的话为 undefined）
 * @param custom 用户自己写的描述
 */
export function describeAnswer(
  question: TaskQuestion,
  option: TaskOption | undefined,
  custom?: string,
): string {
  const answer = option ? option.label : (custom ?? "").trim();
  return `${question.text} → ${answer}`;
}
