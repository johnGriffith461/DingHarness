import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { SANDBOX_MEMORY_MB, SANDBOX_PROCESSES, findSandboxBinary, planSandboxed, probeSandbox } from "./sandbox";

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
 */

const binary = findSandboxBinary();
const hasBinary = binary !== "" && existsSync(binary);

describe("沙箱接线（Phase 14.1）", () => {
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

  it("② 计划里带上了上限参数，且命令**不在 argv 里**（走环境变量）", () => {
    const plan = planSandboxed("echo 你好");
    const joined = plan.args.join(" ");
    /*
     * ⚠️ 这条是踩出来的：命令同时出现在 argv 与环境变量里时，cmd 会收到两遍
     * （报错长成 `Cannot find module 'C:\…\work\"…" node …'`）。
     */
    expect(joined, "命令不该出现在 argv 里（它走 DING_SANDBOX_COMMAND）").not.toContain("echo 你好");
    if (plan.bounded) {
      expect(plan.args).toContain("--memory-mb");
      expect(plan.args).toContain(String(SANDBOX_MEMORY_MB));
      expect(plan.args).toContain("--processes");
      expect(plan.args).toContain(String(SANDBOX_PROCESSES));
      expect(plan.args).toContain("--from-env");
      expect(plan.env.DING_SANDBOX_COMMAND).toBe("echo 你好");
    } else {
      // 直通那条：命令必须在 argv 里（否则没人跑它）
      expect(joined).toContain("echo 你好");
    }
  });

  it("③ 上限可以压小（验收要它快，不该非等 2GB / 32 个进程）", () => {
    const plan = planSandboxed("echo x", { memoryMb: 64, processes: 2 });
    if (plan.bounded) {
      expect(plan.args).toContain("64");
      expect(plan.args).toContain("2");
    }
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
