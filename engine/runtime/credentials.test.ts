import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  credentialsPath,
  credentialsPaths,
  invalidateCredentialCache,
  keySourceOf,
  legacyCredentialsPath,
  primaryCredentialsPath,
  readCredentialRefs,
  resolveSecret,
} from "./credentials";

/**
 * 凭据目录从 `~/.dsh` 搬到 `~/.ding`（2026-10-19）。
 *
 * 为什么这件事值得单开一个测试文件：搬目录最容易造成的不是"路径写错"，
 * 而是**老用户的 key 悄悄失效**——他们会看到"明明配过，却说没密钥"，
 * 然后怀疑是自己忘了。所以这里逐条钉住四件事：
 *
 * 1. 写新文件（不再往旧目录写）；
 * 2. 读的时候**两边合并**，老文件里的 key 照旧能解出来；
 * 3. 同一个键两边都有时，**新的赢**（用户的当前意愿优先于历史文件）；
 * 4. 覆盖变量仍然只读那一个文件（换机器/测试要能完全脱离用户目录）。
 *
 * 控制家目录的办法：`os.homedir()` 在 Windows 上读 `USERPROFILE`、在 POSIX 上读 `HOME`，
 * 所以临时改这两个变量就能把"两个文件都在"这种情形造出来，不必去碰真实用户文件。
 */

const tmpDirs: string[] = [];
const HOME_KEYS = ["USERPROFILE", "HOME"] as const;
let savedHome: Record<string, string | undefined> = {};
let savedOverride: Record<string, string | undefined> = {};

beforeEach(() => {
  savedOverride = {
    DING_CREDENTIALS_FILE: process.env.DING_CREDENTIALS_FILE,
    DSH_CREDENTIALS_FILE: process.env.DSH_CREDENTIALS_FILE,
  };
  savedHome = Object.fromEntries(HOME_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.DING_CREDENTIALS_FILE;
  delete process.env.DSH_CREDENTIALS_FILE;
  invalidateCredentialCache();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedOverride)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateCredentialCache();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-cred-"));
  tmpDirs.push(dir);
  return dir;
}

/** 把家目录指到一个临时目录（两个变量都设，跨平台一致）。 */
function useHome(dir: string): void {
  for (const key of HOME_KEYS) process.env[key] = dir;
  invalidateCredentialCache();
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

describe("凭据位置（改名后）", () => {
  it("主位置是 ~/.ding，旧位置是 ~/.dsh；写入永远是主位置", () => {
    const home = freshDir();
    useHome(home);
    expect(primaryCredentialsPath()).toBe(path.join(home, ".ding", ".credentials.yaml"));
    expect(legacyCredentialsPath()).toBe(path.join(home, ".dsh", ".credentials.yaml"));
    expect(credentialsPath()).toBe(primaryCredentialsPath());
  });

  it("给覆盖变量时只读那一个文件；DING_ 优先于旧名 DSH_", () => {
    const dir = freshDir();
    const a = path.join(dir, "a.yaml");
    const b = path.join(dir, "b.yaml");
    process.env.DING_CREDENTIALS_FILE = a;
    expect(credentialsPaths()).toEqual([a]);

    process.env.DSH_CREDENTIALS_FILE = b;
    expect(credentialsPaths()).toEqual([a]);

    delete process.env.DING_CREDENTIALS_FILE;
    expect(credentialsPaths()).toEqual([b]);
  });
});

describe("两个文件合并读（老用户不会失效）", () => {
  it("只有旧文件时，里面的 key 仍然解得出来", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".dsh", ".credentials.yaml"), "refs:\n  OLD_KEY: from-legacy\n");
    expect(resolveSecret("OLD_KEY")).toBe("from-legacy");
  });

  it("只有新文件时也能读（新用户只会有这一个）", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  NEW_KEY: from-primary\n");
    expect(resolveSecret("NEW_KEY")).toBe("from-primary");
  });

  it("两边都有不同的键时，两边的键**都在**", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".dsh", ".credentials.yaml"), "refs:\n  OLD_ONLY: old\n  SHARED: legacy-value\n");
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  NEW_ONLY: new\n");
    const refs = readCredentialRefs();
    expect(refs.OLD_ONLY).toBe("old");
    expect(refs.NEW_ONLY).toBe("new");
  });

  it("同一个键两边都有时，**新的赢**（并写成一条能读懂的用例）", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".dsh", ".credentials.yaml"), "refs:\n  A_API_KEY: stale-from-legacy\n");
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  A_API_KEY: fresh-from-primary\n");
    expect(resolveSecret("A_API_KEY")).toBe("fresh-from-primary");
  });

  it("旧文件坏了不影响新文件里的 key（坏文件只丢自己那份）", () => {
    const home = freshDir();
    useHome(home);
    // 极端情形：旧文件是二进制垃圾 —— 读它不该把整条读路径炸掉
    fs.mkdirSync(path.join(home, ".dsh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".dsh", ".credentials.yaml"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  GOOD: ok\n");
    expect(resolveSecret("GOOD")).toBe("ok");
  });

  it("缓存会随内容变化失效（写完立刻能读到新的）", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  K: v1\n");
    expect(resolveSecret("K")).toBe("v1");
    write(path.join(home, ".ding", ".credentials.yaml"), "refs:\n  K: v2\n");
    invalidateCredentialCache();
    expect(resolveSecret("K")).toBe("v2");
  });
});

/**
 * M-02：**来源诚实**。
 *
 * 主人报的第 1 条是"供应商默认有密钥"：旧的 `~/.dsh` 文件里躺着别的程序写的 key，
 * 我们却把它显示成"用户配过了"。这里逐条钉住四种来源，重点是
 * **`~/.dsh` 命中必须是 `legacy`，不能是 `app`**。
 */
describe("密钥来源（keySourceOf）", () => {
  const REF = "M02_SOURCE_TEST_KEY";

  it("环境变量优先（与 resolveSecret 的顺序一致）", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".ding", ".credentials.yaml"), `refs:\n  ${REF}: from-app\n`);
    process.env[REF] = "from-env";
    try {
      expect(keySourceOf(REF)).toBe("env");
    } finally {
      delete process.env[REF];
    }
  });

  it("本应用的凭据文件 → app", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".ding", ".credentials.yaml"), `refs:\n  ${REF}: from-app\n`);
    expect(keySourceOf(REF)).toBe("app");
  });

  it("⭐ 旧目录（~/.dsh）→ legacy（不是 app —— 这就是那条 bug）", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".dsh", ".credentials.yaml"), `refs:\n  ${REF}: from-legacy\n`);
    expect(keySourceOf(REF)).toBe("legacy");
    /* 可用性说的是"能读到"，来源说的是"谁配的" —— 两件事分开 */
    expect(resolveSecret(REF)).toBe("from-legacy");
  });

  it("两处都有时新的赢（app），不会退化成 legacy", () => {
    const home = freshDir();
    useHome(home);
    write(path.join(home, ".dsh", ".credentials.yaml"), `refs:\n  ${REF}: old\n`);
    write(path.join(home, ".ding", ".credentials.yaml"), `refs:\n  ${REF}: new\n`);
    expect(keySourceOf(REF)).toBe("app");
  });

  it("哪都没有 → none；空引用名也是 none", () => {
    const home = freshDir();
    useHome(home);
    expect(keySourceOf(REF)).toBe("none");
    expect(keySourceOf("   ")).toBe("none");
  });
});
