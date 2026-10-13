import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9710"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9710");
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
}
