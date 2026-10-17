#!/usr/bin/env node
/**
 * 静态文档站生成（V6-3c）。
 *
 * ## 为什么不用 VitePress/Docusaurus
 *
 * 我们要的只是一件事：把仓库里**已经存在**的 Markdown（README、ADR、安全/隐私、
 * 基准口径）变成能托管的一组 HTML。为这个引一套前端构建链，会让"改一句文档"
 * 需要先装 200MB 依赖 —— 而文档正是最该低门槛维护的东西。
 *
 * 所以：一个零依赖的迷你 Markdown 渲染器 + 一个模板。支持的语法就是**仓库里实际用到的那些**：
 * 标题 / 段落 / 列表 / 代码块 / 表格 / 引用 / 分隔线 / 行内代码 / 粗体 / 链接。
 *
 * 输出到 `docs-site-dist/`（不入库）。托管任意静态服务器即可：
 *   python -m http.server -d docs-site-dist 8080
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs-site-dist");

/* ────────────────────── 迷你 Markdown ────────────────────── */

const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 行内：代码 → 粗体 → 斜体 → 链接（顺序保证代码里的星号不被当成粗体）。 */
function inline(text) {
  const codes = [];
  let out = String(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const url = String(href).replace(/^\.\//, "").replace(/\.md(#.*)?$/, ".html$1");
    return `<a href="${url}">${label}</a>`;
  });
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return out;
}

const slug = (text) =>
  String(text)
    .replace(/`/g, "")
    .replace(/[^\w\u4e00-\u9fff\- ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase() || "section";

/** 表格：`| a | b |` + `|---|---|`。 */
function table(lines) {
  const rows = lines.filter((line) => !/^\|?\s*:?-{3,}/.test(line));
  const cells = (line) =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  const head = cells(rows[0] ?? "");
  const body = rows.slice(1).map(cells);
  return `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\|/.test(line) && /^\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const buf = [];
      while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]);
      out.push(table(buf));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push("<hr />");
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\./.test(line);
      const buf = [];
      while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))) {
        buf.push({ text: lines[i].replace(/^([-*]|\d+\.)\s+/, ""), nested: /^\s{2,}/.test(lines[i]) });
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${buf.map((item) => `<li>${inline(item.text.trim())}</li>`).join("")}</${tag}>`);
      continue;
    }
    /* 段落：连续非空行合并 */
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>\s?|[-*]\s|\d+\.\s|\|)/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    if (!buf.length) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

/* ────────────────────── 页面与导航 ────────────────────── */

const ZH_NAV = [
  ["index.html", "首页 / README"],
  ["getting-started.html", "十分钟跑通"],
  ["knowledge.html", "本地知识库"],
  ["honesty.html", "诚实边界"],
  ["safety.html", "安全边界（SAFETY）"],
  ["architecture.html", "架构与协作"],
  ["benchmarks.html", "评测与基准"],
  ["security.html", "安全政策"],
  ["privacy.html", "隐私政策"],
  ["governance.html", "治理"],
  ["support.html", "支持"],
  ["contributing.html", "贡献"],
  ["adr.html", "ADR"],
];

/**
 * 源文件 basename（小写）→ 站内输出页。
 *
 * 渲染器会把 `SECURITY.md` 转成 `SECURITY.html`，而站内文件名是小写的 ——
 * 没有这张表，文档站里会留下一批 404（链接"看起来对"，点了才知道）。
 */
const PAGE_MAP = {
  "readme.md": "index.html",
  "agents.md": "architecture.html",
  "benchmarks.md": "benchmarks.html",
  "security.md": "security.html",
  "privacy.md": "privacy.html",
  "governance.md": "governance.html",
  "support.md": "support.html",
  "contributing.md": "contributing.html",
  "safety.md": "safety.html",
};
const EN_NAV = [
  ["en/index.html", "Home"],
  ["en/architecture.html", "Architecture"],
];

const CSS = `
:root { --bg:#ffffff; --fg:#1b1f24; --muted:#57606a; --line:#d0d7de; --code:#f6f8fa; --accent:#0969da; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d; --code:#161b22; --accent:#58a6ff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.7 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif; }
.layout { display:grid; grid-template-columns:250px minmax(0,1fr); min-height:100vh; }
nav { border-right:1px solid var(--line); padding:20px 14px; position:sticky; top:0; height:100vh; overflow:auto; }
nav .brand { font-weight:700; font-size:16px; margin-bottom:4px; }
nav .sub { color:var(--muted); font-size:12px; margin-bottom:16px; }
nav a { display:block; padding:5px 8px; border-radius:6px; color:var(--fg); text-decoration:none; font-size:13.5px; }
nav a:hover { background:var(--code); }
nav .group { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin:14px 8px 4px; }
main { padding:36px 48px 80px; max-width:900px; }
h1,h2,h3,h4 { line-height:1.25; margin:28px 0 12px; }
h1 { font-size:30px; margin-top:0; }
h2 { font-size:22px; border-bottom:1px solid var(--line); padding-bottom:6px; }
h3 { font-size:17px; }
p { margin:10px 0; }
a { color:var(--accent); }
code { background:var(--code); padding:2px 5px; border-radius:5px; font:12.5px ui-monospace,SFMono-Regular,Consolas,monospace; }
pre { background:var(--code); padding:14px 16px; border-radius:8px; overflow:auto; border:1px solid var(--line); }
pre code { background:none; padding:0; }
table { border-collapse:collapse; width:100%; margin:14px 0; font-size:13.5px; }
th,td { border:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; }
th { background:var(--code); }
blockquote { margin:14px 0; padding:8px 14px; border-left:3px solid var(--accent); color:var(--muted); }
hr { border:0; border-top:1px solid var(--line); margin:24px 0; }
.lang { float:right; font-size:13px; }
.meta { color:var(--muted); font-size:12.5px; margin-top:40px; }
@media (max-width:760px){ .layout{grid-template-columns:1fr} nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)} main{padding:20px} }
`;

const GITHUB_BLOB = "https://github.com/johnGriffith461/DingHarness/blob/master";

/** 把站内没生成的链接指到 GitHub（宁可能点开，也不要 404）。 */
function rewriteLinks(html, prefix) {
  return html.replace(/href="([^"]+)"/g, (match, raw) => {
    if (/^(https?:|#|mailto:|\/)/.test(raw)) return match;
    const [targetRaw, anchor] = raw.split("#");
    const target = targetRaw.replace(/^\.\//, "");
    const suffix = anchor ? `#${anchor}` : "";
    if (target === "ADR/" || target === "ADR") return `href="${prefix}adr.html${suffix}"`;
    if (/^adr-[\w.-]+\.html$/.test(target)) return `href="${prefix}${target}${suffix}"`;
    if (target.endsWith(".html")) {
      const mapped = PAGE_MAP[target.toLowerCase()];
      if (mapped) return `href="${prefix}${mapped}${suffix}"`;
      return `href="${GITHUB_BLOB}/${target.replace(/\.html$/, ".md")}${suffix}"`;
    }
    /* 源码引用（`../../engine/...`、`LICENSE`、`CHANGELOG.md`）：指到 GitHub 对应路径 */
    if (target.includes("/") || /(^|\/)(LICENSE|CHANGELOG\.md|PLUGIN\.md|RELEASE\.md)$/.test(target)) {
      const clean = target.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
      return `href="${GITHUB_BLOB}/${clean}${suffix}"`;
    }
    return match;
  });
}

function page({ title, body, nav, lang, file }) {
  /* en/ 子目录里的页面：所有站点内链都要先回上一级（否则会拼成 en/en/…） */
  const prefix = file.startsWith("docs-site/en/") ? "../" : "";
  body = rewriteLinks(body, prefix);
  const links = nav
    .map(([href, label]) => `<a href="${prefix}${href}">${label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Ding Harness</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<nav>
  <div class="brand">Ding Harness</div>
  <div class="sub">本地优先的桌面 Agent 工作台</div>
  <a href="${lang === "en" ? `${prefix}index.html` : `${prefix}en/index.html`}">${lang === "en" ? "← 中文" : "English →"}</a>
  <div class="group">文档</div>
  ${links}
</nav>
<main>
${body}
<div class="meta">生成时间：${new Date().toISOString().slice(0, 10)} · 源文件：${escapeHtml(file)} · 本页由 scripts/build-docs-site.mjs 生成，改文档请改源文件</div>
</main>
</div>
</body>
</html>`;
}

/* ────────────────────── 组装 ────────────────────── */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "en"), { recursive: true });

const pages = [
  /* [输出文件, 标题, 源文件, 语言] */
  ["index.html", "Ding Harness", "README.md", "zh"],
  ["getting-started.html", "十分钟跑通", "docs-site/zh/getting-started.md", "zh"],
  ["knowledge.html", "本地知识库", "docs-site/zh/knowledge.md", "zh"],
  ["honesty.html", "诚实边界", "docs-site/zh/honesty.md", "zh"],
  ["safety.html", "安全边界（SAFETY）", "SAFETY.md", "zh"],
  ["architecture.html", "架构与协作", "AGENTS.md", "zh"],
  ["benchmarks.html", "评测与基准", "BENCHMARKS.md", "zh"],
  ["security.html", "安全政策", "SECURITY.md", "zh"],
  ["privacy.html", "隐私政策", "PRIVACY.md", "zh"],
  ["governance.html", "治理", "GOVERNANCE.md", "zh"],
  ["support.html", "支持渠道", "SUPPORT.md", "zh"],
  ["contributing.html", "贡献指南", "CONTRIBUTING.md", "zh"],
  ["en/index.html", "Ding Harness", "docs-site/en/index.md", "en"],
  ["en/architecture.html", "Architecture", "docs-site/en/architecture.md", "en"],
];

let built = 0;
for (const [outFile, title, source, lang] of pages) {
  const full = path.join(ROOT, source);
  if (!existsSync(full)) {
    console.warn(`跳过（源文件不存在）：${source}`);
    continue;
  }
  const html = page({
    title,
    body: renderMarkdown(readFileSync(full, "utf8")),
    nav: lang === "en" ? EN_NAV : ZH_NAV,
    lang,
    file: source,
  });
  writeFileSync(path.join(OUT, outFile), html, "utf8");
  built += 1;
}

/* ADR：索引页 + 每篇一页（公开仓里 ADR/ 本来就在） */
const adrDir = path.join(ROOT, "ADR");
const adrFiles = existsSync(adrDir) ? readdirSync(adrDir).filter((name) => name.endsWith(".md")).sort() : [];
const adrItems = adrFiles
  .map((name) => {
    const stem = name.replace(/\.md$/, "");
    const title = (readFileSync(path.join(adrDir, name), "utf8").split("\n").find((line) => line.startsWith("# ")) ?? `# ${stem}`).slice(2);
    return `<li><a href="adr-${stem}.html">${escapeHtml(title)}</a></li>`;
  })
  .join("");
for (const name of adrFiles) {
  const stem = name.replace(/\.md$/, "");
  writeFileSync(
    path.join(OUT, `adr-${stem}.html`),
    page({
      title: stem,
      body: renderMarkdown(readFileSync(path.join(adrDir, name), "utf8")),
      nav: ZH_NAV,
      lang: "zh",
      file: `ADR/${name}`,
    }),
    "utf8",
  );
}
writeFileSync(
  path.join(OUT, "adr.html"),
  page({
    title: "ADR",
    body: `<h1>架构决策记录（ADR）</h1>\n<p>只增不改；被推翻就写新 ADR 标注取代。共 ${adrFiles.length} 篇。</p>\n<ul>${adrItems}</ul>`,
    nav: ZH_NAV,
    lang: "zh",
    file: "ADR/",
  }),
  "utf8",
);

console.log(`✓ docs-site-dist/：${built + adrFiles.length + 1} 个页面（含 ${adrFiles.length} 篇 ADR）`);
console.log("  本地预览：python -m http.server -d docs-site-dist 8080");
