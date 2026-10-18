#!/usr/bin/env node
/**
 * **CHANGELOG 草稿生成**（D09：从提交生成，人工定稿）。
 *
 * ```bash
 * node scripts/changelog-draft.mjs                        # 自上个 tag 起
 * node scripts/changelog-draft.mjs --since v0.5.0
 * node scripts/changelog-draft.mjs --since HEAD~20 --out /tmp/draft.md
 * ```
 *
 * ⚠️ **不写 CHANGELOG.md**：草稿是"提交标题按任务号分组"，没有经过
 * "用户可见差异"的改写；直接写进发布记录等于把过程日志当产品说明。
 * 发版时按 `RELEASE.md` 第四条人工过一遍再粘。
 *
 * 分组规则在 `shared/release.ts`（有单测）：认 `G12` / `L06` / `U03` / `E02` /
 * `V6-2n` / `Phase 0` 这类前缀，认不出归「其他」，不猜。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

let groupCommits;
let changelogDraft;
try {
  ({ groupCommits, changelogDraft } = await import(pathToFileURL(path.join(ROOT, "shared", "release.ts")).href));
} catch (error) {
  if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token/i.test(String(error?.message ?? error))) {
    console.error(`这个脚本要用 Node 22.6+（类型剥离）；当前是 ${process.version}。改用：pnpm tsx scripts/changelog-draft.mjs`);
    process.exit(1);
  }
  throw error;
}

/** 最近的 tag（没有就退回全部历史 —— 但会提示）。 */
function lastTag() {
  const got = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: ROOT, encoding: "utf8" });
  return got.status === 0 ? got.stdout.trim() : "";
}

const since = flag("since", lastTag());
const range = since ? `${since}..HEAD` : "HEAD";
const got = spawnSync("git", ["log", range, "--pretty=format:%H%x09%s"], { cwd: ROOT, encoding: "utf8" });
if (got.status !== 0) {
  console.error(`读 git 历史失败：${(got.stderr ?? "").trim().slice(0, 200)}`);
  process.exit(1);
}

const commits = (got.stdout ?? "")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [sha, subject] = line.split("\t");
    return { sha: sha ?? "", subject: subject ?? "" };
  })
  .filter((c) => c.sha && c.subject);

const version = flag("version", "");
const date = flag("date", new Date().toISOString().slice(0, 10));
const draft = changelogDraft(groupCommits(commits), { ...(version ? { version } : {}), date });

const out = flag("out");
if (out) {
  writeFileSync(path.resolve(out), draft, "utf8");
  console.log(`草稿写到 ${out}（${commits.length} 条提交，${since ? `自 ${since}` : "全部历史"}）`);
} else {
  process.stdout.write(draft);
}

if (!since) {
  console.error("（没有找到 tag，草稿包含全部历史；用 --since <ref> 缩范围。）");
}
if (!version) {
  console.error("（没给 --version：标题写成「未发布」；发版时改成版本号 + 日期。）");
}
