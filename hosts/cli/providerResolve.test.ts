import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { firstAvailableProvider, allProviders } from "../../engine/runtime/providers";
import { resolveSecret } from "../../engine/runtime/credentials";

/**
 * P0-09：CLI 的 provider 预检必须用**与引擎同一个凭据源**。
 *
 * 缺陷形状：`firstAvailableProvider()` 不带参数时默认只读环境变量；
 * 用户把 key 存在 `~/.ding/.credentials.yaml` 里时，`ding run` 会说"没有可用的 provider"，
 * 而引擎那条路（装配时注入了 `resolveSecret`）其实读得到。
 *
 * 判据：环境变量为空、凭据文件里有 key → 带 `resolveSecret` 能选中；不带则选不中。
 */
let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ding-cli-cred-"));
  file = path.join(dir, ".credentials.yaml");
  const anyProvider = allProviders()[0];
  if (!anyProvider) throw new Error("没有内置 provider，测试前提不成立");
  fs.writeFileSync(file, `refs:\n  ${anyProvider.keyRef}: test-key-from-file\n`, "utf8");
  process.env.DING_CREDENTIALS_FILE = file;
  /* 环境变量必须为空 —— 否则测的就不是"凭据文件能不能读" */
  for (const p of allProviders()) delete process.env[p.keyRef];
});

afterEach(() => {
  delete process.env.DING_CREDENTIALS_FILE;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
  vi.restoreAllMocks();
});

describe("P0-09 · CLI 预检的凭据源", () => {
  it("环境变量为空、凭据文件有 key → resolveSecret 读得到", () => {
    const provider = allProviders()[0]!;
    expect(resolveSecret(provider.keyRef)).toBe("test-key-from-file");
  });

  it("不传 resolveSecret 的 firstAvailableProvider 读不到（这就是原来的缺陷）", () => {
    expect(firstAvailableProvider()).toBeUndefined();
  });

  it("传入 resolveSecret 后能选中 provider（修好之后 CLI 走这条）", () => {
    const got = firstAvailableProvider(resolveSecret);
    expect(got?.id).toBe(allProviders()[0]?.id);
  });

  it("CLI 的调用点都传了 resolveSecret（不再有裸调用）", () => {
    const files = ["hosts/cli/main.ts", "hosts/cli/repl.ts", "hosts/cli/cmdServe.ts", "hosts/cli/cmdSchedule.ts", "hosts/cli/cmdResume.ts", "hosts/cli/cmdRecipe.ts", "hosts/cli/cmdWorkflow.ts"];
    for (const file of files) {
      const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      /* 只看代码，不看注释：把 // 与 /* … *\/ 都剥掉 */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
      expect(code, `${file} 还在用只读环境变量的 firstAvailableProvider()`).not.toMatch(
        /firstAvailableProvider\(\)\s*[?.!;)]/,
      );
    }
  });
});
