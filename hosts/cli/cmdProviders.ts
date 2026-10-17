/**
 * `ding providers` —— 自定义 provider（V6-2j）。
 *
 * ```
 * ding providers list
 * ding providers add my-gw --label "公司网关" --base-url https://gw.example/v1 \
 *   --protocol openai-compatible --key-ref MY_GW_KEY --model gpt-4o-mini,qwen-max
 * ding providers remove my-gw
 * ```
 *
 * 自定义只进 `config.json` 的 `providers` 数组；**密钥不写进配置**，写 keyRef
 * （环境变量名或凭据文件里的键）。内置 provider 不能被同名覆盖。
 */
import { customProviders, setCustomProviders } from "../../engine/runtime/providers";
import { configPaths, readConfig, writeConfig } from "./config";
import { flag, flagAll, type Parsed } from "./args";

function fail(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}

export async function cmdProviders(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";
  const id = p.args[1];
  const config = readConfig(dataDir).config;

  if (sub === "list") {
    const custom = new Set(customProviders().map((p) => p.id));
    /* 内置那批用"静态表"的文字，不在这里重复实现 */
    const { allProviders } = await import("../../engine/runtime/providers");
    const list = allProviders();
    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify(list.map((x) => ({ ...x, custom: custom.has(x.id) })), null, 2) + "\n");
      return 0;
    }
    for (const item of list) {
      process.stdout.write(
        `${custom.has(item.id) ? "＋" : "·"} ${item.id}　${item.label}　[${item.protocol}]\n` +
          `    ${item.baseURL}　密钥：${item.keyRef}　模型：${item.models.join(" / ")}\n`,
      );
    }
    process.stdout.write(`\n＋ = 自定义（${custom.size} 个）。配置：${configPaths(dataDir).primary}\n`);
    return 0;
  }

  if (sub === "add") {
    if (!id) return fail("用法：ding providers add <id> --label <名> --base-url <URL> --protocol openai-compatible|anthropic|google --key-ref <KEY> --model m1[,m2]");
    const baseURL = flag(p, "base-url");
    const protocol = flag(p, "protocol") ?? "openai-compatible";
    const keyRef = flag(p, "key-ref");
    const label = flag(p, "label");
    const models = flagAll(p, "model")
      .flatMap((m) => m.split(","))
      .map((m) => m.trim())
      .filter(Boolean);
    if (!baseURL || !keyRef || !models.length) {
      return fail("缺字段：--base-url / --key-ref / --model 都是必填（模型可以逗号分隔或重复给 --model）");
    }
    if (protocol !== "openai-compatible" && protocol !== "anthropic" && protocol !== "google") {
      return fail(`--protocol 只能是 openai-compatible / anthropic / google（给了「${protocol}」）`);
    }

    const builtin = (await import("../../engine/runtime/providers")).getProvider(id);
    const isCustom = customProviders().some((p) => p.id === id);
    if (builtin && !isCustom) return fail(`「${id}」是内置 provider，不能被覆盖（换个 id）`);

    const next = {
      id,
      label: label ?? id,
      baseURL,
      protocol: protocol as "openai-compatible" | "anthropic" | "google",
      keyRef,
      models,
    };
    const providers = [...(config.providers ?? []).filter((x) => x.id !== id), next];
    /* 先用内核的校验过一遍（同名/字段问题在那里有一份实现） */
    const { rejected } = setCustomProviders(providers);
    if (rejected.length) return fail(rejected.map((r) => `${r.id}：${r.why}`).join("\n"));
    const file = writeConfig(dataDir, { ...config, providers });
    process.stdout.write(
      `✓ 已保存：${id}（${label ?? id}）\n` +
        `  配置：${file}\n` +
        `  密钥：把值放到环境变量 ${keyRef}，或写进凭据文件的 refs.${keyRef}\n` +
        `  用它：ding run "…" --provider ${id} --model ${models[0]}\n`,
    );
    return 0;
  }

  if (sub === "remove") {
    if (!id) return fail("用法：ding providers remove <id>");
    const providers = (config.providers ?? []).filter((x) => x.id !== id);
    if (providers.length === (config.providers ?? []).length) return fail(`没有这个自定义 provider：${id}`);
    const file = writeConfig(dataDir, { ...config, providers });
    setCustomProviders(providers);
    process.stdout.write(`✓ 删掉了 ${id}（配置：${file}；内置 provider 不受影响）\n`);
    return 0;
  }

  return fail("用法：ding providers list|add|remove …");
}
