import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { streamChat, type ChatRequest } from "../ai/aiClient";

/**
 * 守卫：**悬浮助手的停止键必须真的停下**（2026-10-16，审计 P79/P80）。
 *
 * ## P79 是什么
 *
 * 浮窗那颗按钮在流式中是「停止」，而它调的原来是 `abortStream(id)` —— 那条路只让**主进程**断开，
 * 渲染层这条 `handle.done` **永远不会 resolve**。于是 `await handle.done` 卡住、
 * `finally` 里的 `setStreaming(false)` 不执行：浮窗**永久卡在「生成中」**，输入框与发送键一起锁死。
 * 工作台那边早改成 `handle.abort()` 了（`taskRuntime.ts` 的注释逐字写着），浮窗把同一个 bug 又抄了一遍。
 *
 * ## P80 是什么
 *
 * 同一颗按钮空闲时的标题一直承诺「朗读」，而函数体里**没有任何朗读调用** —— 点了没反应。
 *
 * ## 这条守卫怎么判
 *
 * 一半是**行为**（`handle.abort()` 必须 settle `done` —— 那是浮窗赖以解锁的性质），
 * 一半是**源码**（浮窗里不许再出现 `abortStream(`；那颗按钮的两条分支要各自真的做事，且有稳定 testid）。
 * 源码那一半是刻意的：这类 bug 的形状就是"同一个决定长成第二份实现"，光测 aiClient 挡不住它。
 */

/** 浮窗源码（去注释之后的，免得注释里提到的旧写法把守卫自己骗了）。 */
function floatSource(): string {
  const text = readFileSync(path.resolve(__dirname, "FloatingAssistant.tsx"), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 一个**假的主进程桥**：`chat` 立刻回 requestId，之后不发任何事件（模拟"还在生成"）。
 *
 * @returns 桥 + 记录（发出的事件、有没有退订）
 */
function fakeShell() {
  const events: Array<{ type?: string; message?: string; requestId?: string }> = [];
  let unsubscribeCalls = 0;
  const shell = {
    ai: {
      chat: async () => ({ ok: true, requestId: "r1" }),
      abort: async () => undefined,
      onStream: () => () => {
        unsubscribeCalls += 1;
      },
      probe: async () => [],
      listProviders: async () => [],
      fetchModels: async () => ({ ok: true, models: [] }),
    },
  };
  return {
    shell,
    events,
    unsubscribeCalls: () => unsubscribeCalls,
    push: (e: unknown) => events.push(e as never),
  };
}

const REQUEST: ChatRequest = { provider: "strata", model: "m", messages: [{ role: "user", content: "在吗" }] };

describe("浮窗停止键（P79）：abort 必须 settle done", () => {
  it("⭐ `handle.abort()` 之后 `done` 必须 resolve，且本地收到一条「已中止」", async () => {
    const fake = fakeShell();
    (globalThis as unknown as { shell?: unknown }).shell = fake.shell;
    try {
      const seen: string[] = [];
      const handle = await streamChat(REQUEST, (event) => seen.push(String((event as { message?: string }).message ?? event.type)));
      /* 这一轮"还在生成"：不喂 done/error */
      handle.abort();
      const outcome = await handle.done;
      expect(outcome.aborted, "abort 之后 done 必须带着 aborted:true 收场（浮窗就是靠它解锁的）").toBe(true);
      expect(seen, "本地要收到「已中止」（界面据此把那一步收尾成「已中止」）").toContain("已中止");
      expect(fake.unsubscribeCalls(), "中止之后要退订，别继续吃事件").toBe(1);
    } finally {
      delete (globalThis as unknown as { shell?: unknown }).shell;
    }
  });

  it("⚠️ 浮窗源码里不许再出现 `abortStream(`（那正是把浮窗锁死的那条路）", () => {
    const src = floatSource();
    expect(
      src.includes("abortStream("),
      "浮窗的停止又走回 abortStream 了 —— 那条路只断主进程，handle.done 永不 resolve，浮窗会永久卡在生成中",
    ).toBe(false);
    expect(src, "停止必须是调句柄的 abort()").toContain("handleRef.current?.abort()");
  });

  it("⭐ 预填问题记的是**文本**不是布尔（P89：浮窗开着再点一次「问问助手」不许被吞）", () => {
    const src = floatSource();
    expect(
      /const seeded = useRef\(false\)/.test(src),
      "`seeded` 又变回布尔了 —— 浮窗开着时换一个新问题会被静默吞掉（既不填也不发）",
    ).toBe(false);
    expect(src, "要记住上一次吃掉的那一个问题文本").toContain('const seeded = useRef("")');
    expect(src, "判据要按文本比：同一个问题不重复发，换了新的就照发").toContain("seed === seeded.current");
  });

  it("题意与行为分开：那颗按钮要有稳定 testid，且两种语义各自真的做事（P79/P80）", () => {
    const src = floatSource();
    expect(src, "那颗按钮要有 testid（验收才驱动得了它）").toContain('data-testid="wb-float-action"');
    expect(src, "testid 上要标明当前语义（stop / speak），免得「标题说朗读、点了停止」这种事再发生").toContain(
      'data-mode={streaming ? "stop" : "speak"}',
    );
    /* P80：空闲分支必须真的调 speechSynthesis.speak —— 标题承诺了朗读 */
    expect(src, "空闲态点了要真的念（标题承诺的是朗读，不能是空操作）").toContain("synth.speak(utterance)");
    /* 流式分支必须只做停止，不许顺手念起来 */
    const stopBranch = src.slice(src.indexOf("if (streaming) {"), src.indexOf("const synth ="));
    expect(stopBranch, "流式中点它是停止，不该同时触发朗读").not.toContain("speak(");
  });
});
