import fs from "node:fs";
import path from "node:path";

import { BUILTIN_RECIPES, mergeRecipes, recipeToJson, resolveRecipeMode, validateRecipe, type Recipe } from "../../engine/core/recipes";
import { normalizeConfirmMode } from "../../shared/ipc";
import { flag, type Parsed } from "./args";
import { buildEngine } from "./assembly";
import { effectiveConfig } from "./config";
import { renderRecords } from "./renderRecords";

/**
 * `ding recipe` —— 任务模板（Phase 18）。
 *
 * ```
 * ding recipe list                      # 内置 + 你自己导入的
 * ding recipe show <id>                 # 看它到底会说什么、用什么工具
 * ding recipe run <id>                  # 直接跑（可加 --dir）
 * ding recipe export <id> [--out 文件]  # 导出成可分享的 JSON
 * ding recipe import <文件>             # 导入（**会校验**：工具名/档位对不上就报错）
 * ```
 *
 * ## 为什么导入要校验得这么严
 *
 * Recipe **不含可执行代码**（只是"一句话 + 一点偏好"），所以它本身不危险。
 * 危险的是**静默忽略**：工具名写错了却照跑，用户会以为"按模板跑的"，
 * 而实际工具范围根本不是模板想要的那个。所以这里宁可报错。
 */

/** 自己的 templates 存哪（`~/.ding/recipes.json`）。 */
function recipesFile(dataDir: string): string {
  return path.join(dataDir, "recipes.json");
}

/** 读用户导入的那些（磁盘不可信：坏的丢掉并说清）。 */
function readImported(dataDir: string): { recipes: Recipe[]; skipped: number } {
  const file = recipesFile(dataDir);
  if (!fs.existsSync(file)) return { recipes: [], skipped: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : [];
    const recipes: Recipe[] = [];
    let skipped = 0;
    for (const item of list) {
      const got = validateRecipe(item);
      if (got.ok) recipes.push(got.recipe);
      else skipped += 1;
    }
    return { recipes, skipped };
  } catch {
    return { recipes: [], skipped: 0 };
  }
}

function writeImported(dataDir: string, recipes: readonly Recipe[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(recipesFile(dataDir), JSON.stringify(recipes, null, 2) + "\n", "utf8");
}

export async function cmdRecipe(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";
  const id = p.args[1];
  const imported = readImported(dataDir);
  const all = mergeRecipes(imported.recipes);

  if (sub === "list") {
    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify({ recipes: all }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(`任务模板（${all.length} 份；内置 ${BUILTIN_RECIPES.length} 份）：\n\n`);
    for (const r of all) {
      const mine = imported.recipes.some((x) => x.id === r.id) ? "（你自己的）" : "";
      process.stdout.write(`  ${r.id}${mine}\n    ${r.title} —— ${r.description}\n`);
    }
    if (imported.skipped) process.stdout.write(`\n（有 ${imported.skipped} 份存在磁盘上但校验没过，已忽略）\n`);
    process.stdout.write(`\n看一份：ding recipe show <id>　　直接跑：ding recipe run <id>\n`);
    return 0;
  }

  if (sub === "show" || sub === "run" || sub === "export") {
    if (!id) {
      process.stderr.write(`用法：ding recipe ${sub} <id>\n`);
      return 2;
    }
    const recipe = all.find((r) => r.id === id);
    if (!recipe) {
      process.stderr.write(`没有这份模板：${id}（ding recipe list 看全部）\n`);
      return 2;
    }

    if (sub === "show") {
      process.stdout.write(
        [
          `${recipe.title}  [${recipe.id}]`,
          recipe.description,
          "",
          "会发出去的提示词：",
          recipe.prompt,
          "",
          `工具范围：${recipe.tools?.length ? recipe.tools.join(" / ") : "（默认全套）"}`,
          `建议档位：${recipe.mode ?? "（用你当前的）"}`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    if (sub === "export") {
      const out = flag(p, "out") ?? path.resolve(`${recipe.id}.recipe.json`);
      fs.writeFileSync(out, recipeToJson(recipe), "utf8");
      process.stdout.write(`已导出：${out}\n（它是个 JSON，可以贴进聊天或 gist 分享）\n`);
      return 0;
    }

    /* run：真的跑一轮 */
    const { config } = effectiveConfig(dataDir);
    const mode = resolveRecipeMode(normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认"), recipe);
    /*
     * ⚠️ 档位只会**更严**（`resolveRecipeMode`）：模板不能把"每步确认"降成"全部允许" ——
     * 那等于模板能替你放开权限。
     */
    if (recipe.mode && mode !== recipe.mode) {
      process.stdout.write(`（模板建议「${recipe.mode}」，但你当前是「${config.mode ?? "按需确认"}」—— 按更严的那个走）\n`);
    }
    const dirs = (flag(p, "dir") ? [flag(p, "dir")!] : recipe.dirs?.length ? recipe.dirs : (config.dirs ?? [process.cwd()]));
    const built = await buildEngine(dirs, dataDir);
    try {
      process.stdout.write(`跑「${recipe.title}」…\n\n`);
      const outcome = await built.engine.run({
        sessionId: `recipe-${Date.now().toString(36)}`,
        provider: flag(p, "provider") ?? config.provider ?? "",
        ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
        messages: [{ role: "user", content: recipe.prompt }],
        mode,
        useTools: true,
        maxSteps: 8,
      });
      if (!outcome.ok) {
        process.stderr.write(`没跑成：${outcome.error ?? "（没有错误信息）"}\n`);
        return 1;
      }
      /* 结果走宿主自己的渲染（与 `ding run` 同一份投影口径） */
      process.stdout.write(renderRecords(outcome.records));
      return 0;
    } finally {
      built.close();
    }
  }

  if (sub === "import") {
    if (!id) {
      process.stderr.write("用法：ding recipe import <文件>\n");
      return 2;
    }
    const file = path.resolve(id);
    if (!fs.existsSync(file)) {
      process.stderr.write(`找不到文件：${file}\n`);
      return 2;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      process.stderr.write(`不是合法 JSON（${(error as Error).message.slice(0, 80)}）\n`);
      return 2;
    }
    const got = validateRecipe(raw);
    if (!got.ok) {
      process.stderr.write(`这份模板不能用：${got.reason}\n`);
      return 2;
    }
    const next = [...imported.recipes.filter((r) => r.id !== got.recipe.id), got.recipe];
    writeImported(dataDir, next);
    process.stdout.write(`已导入：${got.recipe.title}（${got.recipe.id}）—— 看它：ding recipe show ${got.recipe.id}\n`);
    return 0;
  }

  process.stderr.write(`不认识：ding recipe ${sub}（可选：list / show / run / export / import）\n`);
  return 2;
}
