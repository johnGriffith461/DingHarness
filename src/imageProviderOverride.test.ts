import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**图像通道必须留着 baseURL 的环境变量覆盖口**（2026-10-16，审计 A20）。
 *
 * ## 这条要挡住的是什么
 *
 * 图像通道那张表（`electron/ipc/imageGen.ts` 的 `IMAGE_PROVIDERS`）原来只有写死的
 * `baseURL`（远程域名），没有覆盖口 —— 于是有两层后果：
 *
 * ① **用户侧**：自建 / 中转（反代、企业网关、本地推理）的 OpenAI 兼容图像服务
 *    **指不进来**。文本那张表（`engine/runtime/providers.ts`）早就有 `baseURLEnv`，
 *    图像侧缺这一格属于"同一件事两套口径"。
 * ② **验收侧**：批跑自带本地假通道（`scripts/verify-acceptances.mjs` 的
 *    `startLocalFakeModel`），而零出网那道闸只放行 `127.0.0.1`。没有覆盖口，
 *    图像链那四条验收就只能真调远程模型（烧钱、受上游波动）——
 *    它们因此长期挂着 `needs-model` 不进批跑（「不进批跑 = 没人跑」）。
 *
 * ## 判据（两层，缺一层就红）
 *
 * 1. **每个条目都要声明** `baseURLEnv`，而且解析处**真的读它**
 *    （只声明不读，等于签了个名不办事）；
 * 2. **装置侧跟得上**：批跑器必须为每个声明的变量名设好 `env.<名字>` ——
 *    否则"产品开了口子、装置没接上"会表现成图像那几条**悄悄退回真模型**，
 *    那是最贵的一种静默失效。
 *
 * ⚠️ 这里扫的是**源码形状**（不 import `imageGen.ts`）：那个模块 import 了 `electron`，
 * 在 node 环境里根本加载不了。仓里同类的源码守卫（`engine/runtime/modelGate.test.ts`
 * 扫 `imageGen.ts` 不许裸 `fetch(`）用的是同一套办法。
 *
 * 变异实证过：把 `lunora` 那条的 `baseURLEnv` 删掉，这条立刻红（判词指名道姓说缺什么）。
 */

const ROOT = path.resolve(__dirname, "..");
const IMAGE_GEN = path.join(ROOT, "electron/ipc/imageGen.ts");
const RUNNER = path.join(ROOT, "scripts/verify-acceptances.mjs");

const imageGenSource = () => readFileSync(IMAGE_GEN, "utf8");
const runnerSource = () => readFileSync(RUNNER, "utf8");

/** 把 `IMAGE_PROVIDERS` 那张表的每个条目切出来（值只有字符串与字符串数组，没有嵌套对象）。 */
function providerEntries(source: string): { id: string; block: string }[] {
  const start = source.indexOf("export const IMAGE_PROVIDERS");
  expect(start, "imageGen.ts 里找不到 IMAGE_PROVIDERS（表被改名/搬走了？）").toBeGreaterThan(-1);
  const end = source.indexOf("\n];", start);
  expect(end, "IMAGE_PROVIDERS 那张表没有正常收尾").toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/\{[^{}]*id:\s*"([^"]+)"[^{}]*\}/g)].map((m) => ({ id: m[1]!, block: m[0]! }));
}

describe("图像通道的 baseURL 覆盖口（产品侧与装置侧都要在）", () => {
  it("① 类型上留了这格（`baseURLEnv?: string`）", () => {
    expect(
      /baseURLEnv\?:\s*string/.test(imageGenSource()),
      "ImageProviderDef 少了 `baseURLEnv?: string` —— 图像通道就又只有写死的远程域名了",
    ).toBe(true);
  });

  it("② 每个图像 provider 都声明了 baseURLEnv，且解析处真的读它", () => {
    const entries = providerEntries(imageGenSource());
    expect(entries.length, "一个图像 provider 都没解析出来（这条守卫自己失效了）").toBeGreaterThan(0);

    const missing = entries.filter((e) => !/baseURLEnv:\s*"[A-Z][A-Z0-9_]*"/.test(e.block)).map((e) => e.id);
    expect(
      missing,
      [
        "这些图像 provider 没声明 baseURLEnv —— 自建/中转指不进来，批跑的假通道也指不进来：",
        ...missing.map((id) => `  ${id}`),
        "照 `lunora` 那条写：`baseURLEnv: \"LUNORA_BASE_URL\",`（口径与 engine/runtime/providers.ts 一致）。",
      ].join("\n"),
    ).toEqual([]);

    const source = imageGenSource();
    expect(
      /process\.env\[p\.baseURLEnv\]/.test(source),
      "声明了 baseURLEnv 却没人读它（解析处没按 `env 覆盖 || 表里的默认值` 取）—— 那这格等于装饰",
    ).toBe(true);
    expect(
      !/\$\{provider\.baseURL\}/.test(source),
      "还有请求直接拼 `provider.baseURL` —— 绕过了覆盖口（该走 imageBaseURL(provider)）",
    ).toBe(true);
  });

  it("③ 装置侧接得上：批跑器为每个声明的变量名设了 env", () => {
    const entries = providerEntries(imageGenSource());
    const names = entries
      .map((e) => /baseURLEnv:\s*"([A-Z][A-Z0-9_]*)"/.exec(e.block)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(names.length, "一个变量名都没读出来").toBeGreaterThan(0);

    const runner = runnerSource();
    const unwired = names.filter((name) => !new RegExp(`env\\.${name}\\s*=`).test(runner));
    expect(
      unwired,
      [
        "产品声明了这些覆盖口，但批跑器没有把它们指向本地假通道 —— 图像那几条会**悄悄退回真模型**：",
        ...unwired.map((n) => `  ${n}`),
        `在 scripts/verify-acceptances.mjs 的 run() 里补上 \`env.${unwired[0] ?? "X"} = localModel.url;\`。`,
      ].join("\n"),
    ).toEqual([]);
  });
});
