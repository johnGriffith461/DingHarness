import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, pickPort } from "./harness.mjs";

/**
 * 补验：产物卡片上的协议类型编号（阶段 11.29 留下的缺口）。
 *
 * 上一轮我在文档里如实写了"卡片那个属性只过了类型检查，没单独跑端到端"。
 * 这条把它补上。
 *
 * 做法：**预置 tasks.json** 直接渲染卡片，不等模型 ——
 * 断言映射关系不该依赖一次三十秒的模型调用，那样既慢又不稳定。
 */
const DATA = "D:/DoubaoWorkClone/.verify/proto-data";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const now = Date.now();
fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t-proto",
        title: "协议类型核对",
        brief: "核对产物卡片的 data-artifact-resource-type",
        createdAt: now,
        stage: "done",
        steps: [
          { id: "s1", role: "user", text: "做三个产物", at: now },
          { id: "s2", role: "assistant", text: "做好了", at: now + 1, cost: 0.1 },
        ],
        questions: [],
        questionIndex: 0,
        artifacts: [
          { id: "a1", taskId: "t-proto", stepId: "s2", title: "周报", kind: "docx", createdAt: now, filePath: "周报.docx", bytes: 1000 },
          { id: "a2", taskId: "t-proto", stepId: "s2", title: "说明", kind: "markdown", createdAt: now, filePath: "说明.md", bytes: 10 },
          { id: "a3", taskId: "t-proto", stepId: "s2", title: "预算", kind: "xlsx", createdAt: now, filePath: "预算.xlsx", bytes: 20 },
          { id: "a4", taskId: "t-proto", stepId: "s2", title: "页面", kind: "html", createdAt: now, filePath: "页面.html", bytes: 30 },
        ],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12710]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(2000);

const report = {};
try {
  // 任务应被恢复，卡片应渲染在对话流里
  await page.locator('[data-testid="wb-recent-t-proto"]').click();
  await page.waitForTimeout(1600);

  /*
   * ⚠️ 选择器要按**属性**选，不能用 `[data-testid^="wb-artcard-"]` ——
   * `^=` 是前缀匹配，会把卡片里的 `wb-artcard-body-*` / `wb-artcard-open-*`
   * 按钮也匹配进来（它们没有 kind 属性，读出来是 null，看着像"没映射"）。
   */
  const cards = page.locator("[data-office-artifact-card-kind]");
  report.cardCount = await cards.count();
  report.cards = await page.$$eval("[data-office-artifact-card-kind]", (els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-office-artifact-card-kind"),
      resourceType: el.getAttribute("data-artifact-resource-type"),
    })),
  );
  report.expect = { docx: 10, markdown: 17, xlsx: 12, html: 2 };
  report.allMapped = report.cards.every((c) => c.resourceType !== null && c.resourceType !== "0");
  report.matchesExpectation = report.cards.every((c) => String(report.expect[c.kind]) === c.resourceType);

  // 点一个能在画布里打开的（markdown 那张），确认交互后属性还在
  const md = page.locator('[data-office-artifact-card-kind="markdown"] [data-testid^="wb-artcard-body-"]');
  if (await md.count()) {
    await md.first().click();
    await page.waitForTimeout(2500);
  }
  report.canvasOpened = await page.locator('[data-testid="wb-canvas"]').count();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();

  /*
   * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"
   * （卡片一张都没渲染、或者属性没挂上，它也照样退 0）。
   *
   * 断的是**协议编号这一处映射**：预置的 4 张卡，每张的 `data-artifact-resource-type`
   * 必须与它自己的 kind 对得上（docx=10 / markdown=17 / xlsx=12 / html=2，
   * 唯一一份映射在 `shared/artifactProto.ts` 的 `KIND_TO_TYPE`）。
   * 为什么值得断：编号对不上时卡片照样渲染、照样能点开 —— 只有读那个属性才看得出来；
   * 而这正是这条脚本存在的唯一理由（"本地叫 docx、协议里 Docx 是 10"这种关系不能散）。
   *
   * ⚠️ 卡数必须先钉死：`cards.every(...)` 在**空数组**上是**真空成立**的，
   * 所以"卡片一张都没渲染"也会算出 allMapped=true / matchesExpectation=true。
   */
  const bad = [];
  const EXPECT = { docx: 10, markdown: 17, xlsx: 12, html: 2 };
  /*
   * ⚠️ 这里**不能**按"总数 == 4"断：同一张产物卡会在**两个地方**各渲染一份
   * —— 对话流里（`ArtifactCard.tsx`）与右侧「对话产物」列表里（`SummaryPanel.tsx`），
   * 两处都带 `data-office-artifact-card-kind`。实测 4 张产物 → DOM 里 8 个节点。
   * 所以：**按"互不相同的 kind"断**（真正的不变量是"四种格式的卡都渲染出来了"），
   * 再要求总数是 4 的整数倍（防"一张都没渲染"那种真空成立）。
   */
  const kinds = new Set((report.cards ?? []).map((c) => c.kind));
  if (kinds.size !== 4) bad.push(`渲染出的产物卡种类不是 4 种：${[...kinds].join("/") || "（一张都没有）"}`);
  if (report.cardCount % 4 !== 0) bad.push(`产物卡节点数不是 4 的整数倍（渲染点 × 卡数）：${report.cardCount}`);
  if ((report.cards ?? []).length !== report.cardCount) bad.push("卡片数与读到的属性条数对不上");
  for (const c of report.cards ?? []) {
    if (c.resourceType === null || c.resourceType === "0" || c.resourceType === undefined) {
      bad.push(`卡片 ${c.kind} 没有协议编号（data-artifact-resource-type 缺失或为 0）`);
    } else if (String(EXPECT[c.kind] ?? "(未知 kind)") !== c.resourceType) {
      bad.push(`卡片 ${c.kind} 的协议编号对不上：读到 ${c.resourceType}，应为 ${EXPECT[c.kind]}`);
    }
  }
  if (bad.length) {
    console.error("✗ 产物卡的协议字段：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 四张产物卡的协议编号与 kind 一一对应（docx 10 / markdown 17 / xlsx 12 / html 2）");
  }
}
