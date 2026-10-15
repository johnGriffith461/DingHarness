import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_MEMORY_MB,
  SANDBOX_PROCESSES,
  findSandboxBinary,
  planFor,
  planSandboxed,
  probeSandbox,
  type SandboxInfo,
} from "./sandbox";

/**
 * 沙箱的**宿主侧**（Phase 14.1）。
 *
 * ## 这一层测什么、不测什么
 *
 * · 测**接线**：计划怎么拼、缺二进制时怎么退化、能力怎么问；
 * · 测**真行为**（二进制存在时）：内存上限真的会杀、子进程随沙箱一起收掉；
 * · **不测"能不能挡住恶意"** —— 它不是安全边界（见 `sandbox.ts` 头注与 SAFETY.md），
 *   拿它当边界才是错的。
 *
 * ⚠️ 二进制不在时（没跑过 `pnpm sandbox:build`）那几条**跳过并说清**，
 * 而不是假装通过 —— 不然"验过"就成了空话。
 *
 * ⚠️⚠️ **接线那几条用 `planFor` 把能力直接喂进去，不走 `probeSandbox()`**：
 * 只看真探测的话，本机（编过沙箱）永远只测到沙箱那条，**直通那条要等 CI
 * 或用户机器上才第一次执行** —— 2026-10-16 CI 第一次真跑单测，直通路的引号缺陷
 * 就是这么露头的（含引号的命令静默变成空操作）。两条路都要有常驻断言。
 */

const binary = findSandboxBinary();
const hasBinary = binary !== "" && existsSync(binary);

/** 「找到了沙箱」的能力（假的：这几条只问计划怎么拼，不 spawn）。 */
const foundInfo: SandboxInfo = {
  found: true,
  bounded: true,
  binary: "ding-sandbox",
  platform: process.platform,
  note: "命令在作业对象里跑：有内存与子进程数上限，且随沙箱一起结束（不留孤儿）",
};
/** 「没找到沙箱」的能力 —— 没编过 `pnpm sandbox:build` 的机器、CI、装出来的版本都是它。 */
const missingInfo: SandboxInfo = {
  found: false,
  bounded: false,
  binary: "",
  platform: process.platform,
  note: "没有 ding-sandbox（编它：pnpm sandbox:build）；命令将不受限地跑",
};

describe("沙箱接线（Phase 14.1）", () => {
  it("①a 打包态：resources/ 下那份找得到（2026-10-16 主人逮到的那条）", () => {
    /*
     * 主人发现的问题：README 写着 ✅「作业对象」，可**安装包里根本没有 ding-sandbox**，
     * 而且 `findSandboxBinary` 只看 `process.cwd()` —— 装出来的应用 cwd 是"用户从哪儿启的"，
     * 于是就算打了包也找不到。这条钉的就是那个查找顺序。
     */
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-packaged-"));
    const name = process.platform === "win32" ? "ding-sandbox.exe" : "ding-sandbox";
    writeFileSync(path.join(dir, name), "x");
    const before = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: dir, configurable: true, writable: true });
    try {
      expect(findSandboxBinary(), "resources/ 下那份应当被找到").toBe(path.join(dir, name));
    } finally {
      if (before) Object.defineProperty(process, "resourcesPath", before);
      else Reflect.deleteProperty(process, "resourcesPath");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("① 找不到二进制时：直通 + **明说没有隔离**（不静默降级）", () => {
    const info = probeSandbox();
    if (info.found) {
      // 本机有二进制：这条就不适用于"找不到"，但**形状**仍要成立
      expect(info.binary.length).toBeGreaterThan(0);
      expect(typeof info.bounded).toBe("boolean");
      expect(info.note.length).toBeGreaterThan(0);
      return;
    }
    expect(info.bounded).toBe(false);
    expect(info.note).toContain("不受限");
  });

  it("② 走沙箱那条：上限参数在，命令**不在 argv 里**（走环境变量）", () => {
    const plan = planFor("echo 你好", foundInfo);
    const joined = plan.args.join(" ");
    /*
     * ⚠️ 这条是踩出来的：命令同时出现在 argv 与环境变量里时，cmd 会收到两遍
     * （报错长成 `Cannot find module 'C:\…\work\"…" node …'`）。
     */
    expect(joined, "命令不该出现在 argv 里（它走 DING_SANDBOX_COMMAND）").not.toContain("echo 你好");
    expect(plan.args).toContain("--memory-mb");
    expect(plan.args).toContain(String(SANDBOX_MEMORY_MB));
    expect(plan.args).toContain("--processes");
    expect(plan.args).toContain(String(SANDBOX_PROCESSES));
    expect(plan.args).toContain("--from-env");
    expect(plan.env.DING_SANDBOX_COMMAND).toBe("echo 你好");
    /* 这条路的参数是给沙箱自己解析的，照常让 Node 转义 */
    expect(plan.verbatimArgv).toBe(false);
  });

  it("②b 直通那条：命令在 argv 里，且**原样**交给 cmd（关掉 Node 的 CRT 转义）", () => {
    const plan = planFor("echo 你好", missingInfo);
    expect(plan.bounded).toBe(false);
    expect(plan.env.DING_SANDBOX_COMMAND).toBeUndefined();
    const last = plan.args[plan.args.length - 1];
    if (process.platform === "win32") {
      /* 外面套的那层引号由 cmd 的 `/s` 剥掉，里层引号原样留下 */
      expect(last).toBe('"echo 你好"');
      expect(plan.verbatimArgv).toBe(true);
    } else {
      expect(last).toBe("echo 你好");
      expect(plan.verbatimArgv).toBe(false);
    }
  });

  it("②c 直通那条**真的能跑含引号的命令**（2026-10-16 CI 逮到的静默失效）", () => {
    /*
     * 判据就是当年的故障现象：含引号的命令**退出码 0 但没有输出**。
     * 这里真跑一次 —— 拼对了才拿得到那句 marker。
     * ⚠️ 别把这条改成"断言 args 长什么样"：这正是它当年躲过所有断言的原因。
     */
    const plan = planFor(`node -e "console.error('straight-through-marker')"`, missingInfo);
    const got = spawnSync(plan.file, plan.args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatimArgv,
      timeout: 60_000,
    });
    expect(got.status).toBe(0);
    expect(`${got.stdout ?? ""}${got.stderr ?? ""}`).toContain("straight-through-marker");
  });

  it("③ 上限可以压小（验收要它快，不该非等 2GB / 32 个进程）", () => {
    const plan = planFor("echo x", foundInfo, { memoryMb: 64, processes: 2 });
    expect(plan.args).toContain("64");
    expect(plan.args).toContain("2");
  });

  it.runIf(hasBinary)("④ 真的能跑：命令经沙箱执行，输出一字不差", () => {
    const plan = planSandboxed("echo sandbox-roundtrip");
    const got = spawnSync(plan.file, plan.args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...plan.env },
      timeout: 60_000,
    });
    expect(got.status).toBe(0);
    expect(got.stdout ?? "").toContain("sandbox-roundtrip");
  });

  it.runIf(hasBinary)(
    "⑤ 内存上限真的生效：要 1GB 的命令在 128MB 上限下被杀",
    () => {
      const plan = planSandboxed(
        `node -e "const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(16*1024*1024))"`,
        { memoryMb: 128, processes: 8 },
      );
      const got = spawnSync(plan.file, plan.args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...plan.env },
        timeout: 120_000,
      });
      /*
       * 判据是"**没成功分配完**"：Node 在作业的内存上限处抛分配失败（退出码非 0）。
       * 不断言具体错误文案 —— 那是 Node 的措辞，不是我们的契约。
       */
      expect(got.status, "128MB 上限下竟然跑完了 1GB 的分配").not.toBe(0);
    },
    150_000,
  );

  it.runIf(hasBinary)(
    "⑥ 子进程数上限 + 不留孤儿：命令起的那堆子进程随沙箱一起收掉",
    () => {
      const plan = planSandboxed(
        [
          "node -e \"const {spawn}=require('child_process');",
          "for(let i=0;i<40;i++){try{const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)']);c.on('error',()=>{});}catch(e){break}}",
          "setTimeout(()=>process.exit(0),1200);\"",
        ].join(""),
        { memoryMb: 512, processes: 4 },
      );
      const got = spawnSync(plan.file, plan.args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...plan.env },
        timeout: 120_000,
      });
      expect(got.status).toBe(0);

      /*
       * 沙箱退出后不该留下刚才那堆 `node -e setTimeout(…,60000)` 孤儿 ——
       * 这是 KILL_ON_JOB_CLOSE 那条在起作用（也是这个沙箱对用户最实在的好处）。
       * 「不留孤儿」的判据只能从**外面**看：数一下还有几个 node 是刚才这几秒起的。
       */
      /*
       * ⚠️ 判据必须**只数我们起的那批**：第一版按"最近 20 秒起的 node"数，
       * 结果把 vitest 自己的 worker 也算进去了（报了 5 个"孤儿"，其实一个都不是）——
       * 空的判据比没有判据更容易骗人。这里按**命令行里的特征串**认。
       */
      const probe = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.CommandLine -like '*setTimeout(()=>{},60000)*' }).Count",
        ],
        { encoding: "utf8" },
      );
      const left = Number((probe.stdout ?? "0").trim() || "0");
      expect(left, `沙箱退出后还留着 ${left} 个我们起的孤儿 node`).toBe(0);
    },
    150_000,
  );
});
