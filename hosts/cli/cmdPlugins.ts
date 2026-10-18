/**
 * `ding plugins` —— 插件管理（Phase 8.2 / 8.4 / V6-3d 市场索引）。
 *
 * 从 `ding.ts` 拆出来的（结构守卫 C6-5：那个文件超了 900 行上限）。
 * 拆法按**命令**分：一个命令的实现（连同它自己的市场索引解析）聚在一处。
 *
 * ⚠️ 安装要求**显式确认**（`--yes`）：`install` 会把别人的代码装进你的机器，
 * 而"权限确认"这件事在无头环境里只能靠一个明确的旗子表达 ——
 * 没有它就把权限清单打出来并**拒绝安装**（而不是替你点了"同意"）。
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PRODUCT_VERSION } from "../../shared/product";
import {
  auditLedger,
  installFromDir,
  installFromNpm,
  makePackDir,
  packNpm,
  pluginPaths,
  readLedger,
  readManifestFromDir,
  readManifestFromTarball,
  setEnabled,
  uninstall,
} from "../../engine/adapters/pluginStore";
import {
  engineIncompatibility,
  parsePluginIndex,
  searchPluginIndex,
  type PluginIndex,
  type PluginIndexEntry,
} from "../../engine/runtime/pluginIndex";
import { checkIndexTrust, indexPinsFileOf, readIndexPins, writeIndexPins } from "../../engine/runtime/pluginIndexTrust";
import { loadEnabledPlugins, loadedPlugins, withheldCapabilities } from "../../engine/runtime/pluginHost";
import {
  DECLARATION_ONLY_PERMISSIONS,
  ENFORCED_PERMISSIONS,
  PLUGIN_PERMISSIONS,
  SANDBOXED_PERMISSIONS,
  checkManifest,
  type PluginPermission,
} from "../../engine/runtime/plugins";
import { flag, type Parsed } from "./args";

/**
 * 默认市场索引：从 cwd 往上找 `plugin-market/index.json`（V6-3d）。
 *
 * ⚠️ 仓库里那份只是**格式示例 + 本仓自带的插件**，不是线上市场。
 * 线上索引要一个稳定的 URL 与审核流程 —— 那是运营侧的事，不在这里假装已经有了。
 */
function defaultPluginIndex(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "plugin-market", "index.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 读一份索引（本地文件或 http(s) URL），并做信任判定（L04）。 */
async function loadPluginIndex(
  source: string | undefined,
  dataDir: string,
  acceptChange: boolean,
): Promise<
  { index: PluginIndex; problems: string[]; from: string; baseDir: string; remote: boolean; trustNote: string } | { error: string }
> {
  const target = source ?? defaultPluginIndex();
  if (!target) return { error: "没有市场索引：用 --index <文件|URL> 指一份，或在仓库根放 plugin-market/index.json" };
  try {
    let text: string;
    const remote = /^https?:\/\//i.test(target);
    if (remote) {
      const response = await fetch(target, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { error: `索引下载失败：HTTP ${response.status}（${target}）` };
      text = await response.text();
    } else {
      text = await fs.readFile(path.resolve(target), "utf8");
    }
    const raw = JSON.parse(text) as unknown;

    /*
     * 信任门（L04）：签名索引验签；未签名索引**钉住摘要**，内容变了就拒。
     * 钉按来源区分 —— 同一个内容放在两个路径下是两份索引。
     */
    const pinsFile = indexPinsFileOf(pluginPaths(dataDir).root);
    const verdict = checkIndexTrust({
      source: remote ? target : path.resolve(target),
      raw,
      pins: readIndexPins(pinsFile),
      acceptChange,
    });
    if (!verdict.verdict.ok) return { error: verdict.verdict.message };
    writeIndexPins(pinsFile, verdict.pins);

    const parsed = parsePluginIndex(raw);
    if (!parsed.ok) return { error: `索引不合法：${parsed.errors.join("；")}` };
    return {
      index: parsed.index,
      problems: parsed.problems,
      from: target,
      baseDir: remote ? "" : path.dirname(path.resolve(target)),
      remote,
      trustNote: verdict.verdict.note,
    };
  } catch (error) {
    return { error: `读索引失败：${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
}

export async function cmdPlugins(p: Parsed, dataDir: string): Promise<number> {
  const paths = pluginPaths(dataDir);
  const sub = p.args[0] ?? "list";
  const name = p.args[1];
  const ledger = () => readLedger(paths).ledger.installed;

  /*
   * 先装载一遍开着的那批 —— 因为"哪些能力被扣下了"与"装载时发现了什么问题"
   * **只有装载才知道**（不装载的话 doctor 永远说"没问题"，那正是"检查在空转"）。
   */
  await loadEnabledPlugins(ledger());
  const problems = loadedPlugins().flatMap((pl) => pl.problems.map((x) => `${pl.name}：${x}`));

  if (sub === "list") {
    const list = ledger();
    if (p.flags.has("json")) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      console.log(`还没有装任何插件（目录：${paths.root}）`);
      console.log("装一个：ding plugins install <目录> --yes");
      return 0;
    }
    for (const item of list) {
      const granted = item.granted.length ? item.granted.join(" / ") : "无";
      console.log(`${item.name}@${item.version}　${item.enabled ? "开着" : "关着"}　权限：${granted}`);
      console.log(`    ${item.description}`);
      /*
       * 签名/信任与依赖要能一眼看到（L04）：
       * `unsigned` 不是错误（v1 插件照样能用），但用户有权知道"没人担保"。
       */
      const sig =
        item.signature.trust === "unsigned"
          ? "未签名"
          : `已签名（${item.signature.publisher.id}，${item.signature.trust === "trusted" ? "同一把钥匙" : "首次见到"}）`;
      console.log(`    签名：${sig}`);
      /*
       * 隔离档位（G18）：插件跑在独立进程里。宿主 Node 不支持权限模型时会降级成
       * 只隔离崩溃 —— 这一行必须如实说，别让用户以为文件边界也生效了。
       */
      const iso = loadedPlugins().find((p) => p.name === item.name)?.isolation;
      if (iso) {
        console.log(
          `    隔离：${iso === "worker-permission" ? "独立进程（文件/命令按批准项受控）" : "独立进程（只隔离崩溃；文件/命令边界未强制）"}`,
        );
      }
      const deps = item.manifest.dependencies ?? {};
      const depText = Object.entries(deps)
        .map(([dep, range]) => `${dep} ${range}`)
        .join(" / ");
      if (depText) console.log(`    依赖：${depText}`);
    }
    const { missing } = auditLedger(paths);
    if (missing.length) console.error(`⚠️ 这些插件的目录不在了：${missing.join(" / ")}`);
    for (const w of withheldCapabilities()) {
      console.log(`（${w.plugin} 申请了但你没批：${w.permissions.join(" / ")}）`);
    }
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    return 0;
  }

  /*
   * 市场索引搜索（V6-3d）。
   *
   * 这是"发现"这一步：搜索 → 看到兼容性/权限/来源 → `install index:<id>`。
   * 兼容性在这里**就标出来**（不兼容的也列，但沉下去）——
   * 让用户先知道"装上跑不起来"，而不是装完才发现。
   */
  if (sub === "search") {
    const query = p.args.slice(1).join(" ");
    const loaded = await loadPluginIndex(flag(p, "index"), dataDir, p.flags.has("accept-index-change"));
    if ("error" in loaded) {
      console.error(loaded.error);
      return 1;
    }
    if (loaded.problems.length) {
      console.error(`⚠️ 索引里有 ${loaded.problems.length} 条读不了（已跳过）：${loaded.problems.slice(0, 3).join("；")}`);
    }
    const hits = searchPluginIndex(loaded.index, query, PRODUCT_VERSION);
    if (p.flags.has("json")) {
      console.log(JSON.stringify({ from: loaded.from, trust: loaded.trustNote, hits }, null, 2));
      return 0;
    }
    if (!hits.length) {
      console.log(`「${query || "(全部)"}」没有命中（索引：${loaded.from}，共 ${loaded.index.plugins.length} 条）`);
      console.log(`索引信任：${loaded.trustNote}`);
      return 0;
    }
    for (const hit of hits) {
      const tags = hit.tags?.length ? `　#${hit.tags.join(" #")}` : "";
      console.log(
        `${hit.compatible ? "✓" : "⚠️"} ${hit.id}@${hit.version}　${hit.name}` +
          (hit.publisher ? `　by ${hit.publisher}` : "") +
          `　[ding ${hit.enginesDing}]${tags}`,
      );
      if (hit.description) console.log(`    ${hit.description}`);
      if (!hit.compatible) console.log(`    ${hit.incompatibility}`);
    }
    console.log("");
    console.log(`索引信任：${loaded.trustNote}`);
    console.log(`装一个：ding plugins install index:<id> --yes`);
    return 0;
  }

  if (sub === "install") {
    if (!name) {
      console.error(
        "用法：ding plugins install <目录|npm:包名|index:id> [--yes] [--grant tools:register,hooks:register] " +
          "[--index <文件|URL>] [--accept-index-change] [--allow-missing-deps]",
      );
      return 2;
    }
    /*
     * `index:<id>`（V6-3d）：从市场索引解析出安装来源。
     * 索引只是**发现**层 —— 装的时候照样走 npm 取包 + 清单 + 验签 + 权限确认。
     */
    let installName = name;
    let fromIndex: PluginIndexEntry | undefined;
    if (name.startsWith("index:")) {
      const id = name.slice("index:".length).trim();
      const loaded = await loadPluginIndex(flag(p, "index"), dataDir, p.flags.has("accept-index-change"));
      if ("error" in loaded) {
        console.error(loaded.error);
        return 1;
      }
      fromIndex = loaded.index.plugins.find((entry) => entry.id === id);
      if (!fromIndex) {
        console.error(`索引里没有「${id}」（索引：${loaded.from}）。用 ding plugins search 看看有哪些。`);
        return 1;
      }
      const incompatible = engineIncompatibility(fromIndex.enginesDing, PRODUCT_VERSION);
      if (incompatible) {
        console.error(incompatible);
        return 1;
      }
      if (fromIndex.npm) installName = `npm:${fromIndex.npm}`;
      else if (fromIndex.local && !loaded.remote) installName = path.resolve(loaded.baseDir, fromIndex.local);
      else {
        console.error(
          loaded.remote && fromIndex.local
            ? `「${id}」只给了本地路径 —— 远程索引里的 local 会被忽略（那会在你的机器上装任意路径的代码）`
            : `「${id}」没有可用的安装来源`,
        );
        return 1;
      }
    }
    /*
     * 两个渠道（Phase 8.2）：本地目录 `install <目录>`，npm 包 `install npm:<包名>`。
     *
     * ⚠️ npm 那条走**两段式**：先取包（`npm pack`）、读出清单给用户看，
     * 用户加 `--yes` 之后才真装。合成一步的话，"权限确认"就只能发生在
     * **已经下载并解开之后** —— 那不叫确认，那叫通知。
     */
    const isNpm = installName.startsWith("npm:");
    const packDir = isNpm ? makePackDir() : "";
    const probe = isNpm
      ? (() => {
          const packed = packNpm(installName.slice(4), packDir);
          if (!packed.ok) return { note: packed.errors.join("；") };
          return readManifestFromTarball(packed.tgz);
        })()
      : readManifestFromDir(path.resolve(installName));
    if (!probe.raw) {
      console.error(`读不到清单：${probe.note ?? "未知原因"}`);
      return 1;
    }
    const checked = checkManifest(probe.raw);
    if (!checked.ok) {
      console.error("清单不合法：");
      for (const e of checked.errors) console.error(`  · ${e}`);
      return 1;
    }
    const m = checked.manifest;
    console.log(`插件 ${m.name}@${m.version}${fromIndex ? `（来自市场索引：${fromIndex.id}）` : ""}`);
    console.log(`  ${m.description}`);
    console.log(`  它申请的权限：${m.permissions.length ? m.permissions.join(" / ") : "（无）"}`);
    const enforced = m.permissions.filter((x) => ENFORCED_PERMISSIONS.includes(x));
    const sandboxed = m.permissions.filter((x) => SANDBOXED_PERMISSIONS.includes(x));
    const declaredOnly = m.permissions.filter((x) => DECLARATION_ONLY_PERMISSIONS.includes(x));
    if (enforced.length) console.log(`  · 这几项**会真的生效**（不批就不接那根线）：${enforced.join(" / ")}`);
    if (sandboxed.length) {
      console.log(
        `  · 这几项在**隔离进程**里强制（只能碰插件目录；写/起子进程要单独批准）：${sandboxed.join(" / ")}` +
          "（宿主 Node 不支持权限模型时降级为只隔离崩溃）",
      );
    }
    if (declaredOnly.length) {
      console.log(`  · 这几项**拦不住**（Node 没有网络权限那一格）—— 是"知情"不是"限制"：${declaredOnly.join(" / ")}`);
    }
    const deps = m.dependencies ?? {};
    if (Object.keys(deps).length) {
      console.log(`  它依赖：${Object.entries(deps).map(([dep, range]) => `${dep} ${range}`).join(" / ")}`);
    }
    if (m.publisher) console.log(`  签名：${m.publisher.id}（安装时会验签，换钥匙一律拒）`);

    if (!p.flags.has("yes")) {
      console.error("");
      console.error("确认之后再加 `--yes` 重跑（这一步就是权限确认：不替你点同意）。");
      return 3;
    }

    const grantArg = flag(p, "grant");
    const granted = grantArg
      ? grantArg
          .split(",")
          .map((x) => x.trim())
          .filter((x): x is PluginPermission => PLUGIN_PERMISSIONS.includes(x as PluginPermission))
      : undefined;
    const allowMissingDeps = p.flags.has("allow-missing-deps");
    const got = isNpm
      ? installFromNpm({
          paths,
          spec: installName.slice(4),
          ...(granted ? { granted } : {}),
          ...(allowMissingDeps ? { allowMissingDeps: true } : {}),
        })
      : installFromDir({
          paths,
          from: path.resolve(installName),
          ...(granted ? { granted } : {}),
          ...(allowMissingDeps ? { allowMissingDeps: true } : {}),
        });
    if (!got.ok) {
      console.error("装不上：");
      for (const e of got.errors) console.error(`  · ${e}`);
      return 1;
    }
    console.log("");
    console.log(`✓ 装好了：${got.plugin.name}@${got.plugin.version} → ${got.plugin.dir}`);
    console.log(
      got.plugin.signature.trust === "unsigned"
        ? "  签名：未签名（v1 插件照样能跑 —— 但没人担保这份代码）"
        : `  签名：有效（发布者 ${got.plugin.signature.publisher.id}，${got.plugin.signature.trust === "trusted" ? "与上次同一把钥匙" : "首次见到，已钉住公钥"}）`,
    );
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    if (!name) {
      console.error(`用法：ding plugins ${sub} <名字>`);
      return 2;
    }
    const got = setEnabled(paths, name, sub === "enable");
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ ${name} 已${sub === "enable" ? "打开" : "关掉"}（下次运行生效）`);
    return 0;
  }

  if (sub === "remove") {
    if (!name) {
      console.error("用法：ding plugins remove <名字>");
      return 2;
    }
    const got = uninstall(paths, name);
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ 卸载了 ${name}（台账与它拷贝进来的那份内容都清了；你给它的源目录没动）`);
    return 0;
  }

  if (sub === "doctor") {
    const { missing } = auditLedger(paths);
    const withheld = withheldCapabilities();
    console.log(`插件目录：${paths.root}`);
    console.log(`台账：${paths.ledger}${existsSync(paths.ledger) ? "" : "（还没有）"}`);
    console.log(`装载了 ${loadedPlugins().length} 个（开着的那批）`);
    if (missing.length) console.log(`⚠️ 目录不在了：${missing.join(" / ")}`);
    for (const w of withheld) console.log(`⚠️ ${w.plugin} 申请的这几项没被批准：${w.permissions.join(" / ")}`);
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    if (!missing.length && !withheld.length && !problems.length) console.log("没有发现问题。");
    return 0;
  }

  console.error(`不认识的子命令：${sub}（可用：list / install / enable / disable / remove / doctor）`);
  return 2;
}
