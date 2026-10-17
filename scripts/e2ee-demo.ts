/**
 * E2EE 现场演示（V6-4c）：**中继只见密文**。
 *
 * ## 它证明什么
 *
 * 起一个真服务（真中继 + 真 token + 真 HTTP 路由），把一段带唯一标记的会话推上去，
 * 然后把**中继上实际躺着的那批字节**抓下来：
 *
 *   ① 抓到的 JSON 里搜不到明文标记（中继看不到内容）；
 *   ② 没有房间密钥时 `openFrame` **明确报错**（第三方解不开）；
 *   ③ 另一台设备带同一把密钥同步 → 内容一致（该看到的人看得到）。
 *
 * ## 它不是抓包
 *
 * 抓的是**中继自己的出站数据**（`/v1/streams/<id>/pull`，与另一台设备拉的是同一份）。
 * 这比抓 TCP 包更能说明问题：加密发生在应用层，TLS 只是额外一层 ——
 * 即使中继运营方把日志全打开，看到的也只有密文。
 *
 * 用法：
 *   pnpm tsx scripts/e2ee-demo.ts
 *   pnpm tsx scripts/e2ee-demo.ts --keep   # 保留临时目录与抓包文件，便于人工翻看
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSqliteSessionStore } from "../engine/adapters/sqliteStore";
import type { LogInput } from "../engine/core/events";
import { createSyncRelay } from "../engine/sync/relay";
import { openFrame } from "../engine/sync/sealed";
import { syncSession } from "../hosts/cli/cmdSync";
import { startAgentServer } from "../hosts/server/agentServer";

const keep = process.argv.includes("--keep");

/** 服务只要求"有个引擎"，这一条演示不跑回合 —— 给一个不干活的。 */
const fakeEngine = {
  run: async () => ({ ok: true, aborted: false, provider: "fake", model: "fake" }),
  resume: async () => ({ turns: [], pending: [], runningDelegations: [], denied: undefined }),
  replay: async () => ({ ok: true, diffs: [] }),
  record: async () => null,
  tools: {},
};

function ok(text: string): void {
  process.stdout.write(`✓ ${text}\n`);
}
function bad(text: string): never {
  process.stderr.write(`✗ ${text}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dh-e2ee-demo-"));
  const dirA = path.join(root, "device-A");
  const dirB = path.join(root, "device-B");
  const captureFile = path.join(root, "relay-capture.jsonl");

  const relay = createSyncRelay();
  const server = await startAgentServer({
    port: 0,
    makeEngine: (async () => ({ engine: fakeEngine, close: () => undefined })) as never,
    mode: "按需确认",
    provider: "fake",
    cwd: process.cwd(),
    relay,
    log: () => undefined,
  });

  try {
    const marker = `E2EE-DEMO-${randomUUID()}`;
    const sid = `chat-e2ee-demo-${randomUUID().slice(0, 8)}`;
    const key = randomBytes(32).toString("base64url"); // 32 字节；只在 URL fragment 里出现过
    const base = server.url;

    /* ① 设备 A 写一段带唯一标记的会话 */
    const storeA = createSqliteSessionStore(dirA);
    await storeA.append(sid, [
      { requestId: "r1", type: "request", provider: "demo", model: "demo", messages: [{ role: "user", content: `请记住这个标记：${marker}` }] },
      { requestId: "r1", type: "text", text: `记下了：${marker}` },
    ] as LogInput[]);
    storeA.close();

    const pushed = await syncSession({ dataDir: dirA, sessionId: sid, to: base, token: server.token, producerId: "device-A", roomKey: key });
    ok(`设备 A 推送了 ${pushed.pushed} 条（房间密钥只在本地）`);

    /* ② 抓中继出站数据（与另一台设备拉到的是同一份） */
    const response = await fetch(`${base}/v1/streams/${encodeURIComponent(sid)}/pull?from=0&limit=100`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    if (!response.ok) bad(`拉取中继数据失败：HTTP ${response.status}`);
    const pulled = (await response.json()) as { events?: { id?: string; type?: string; payload?: unknown }[] };
    const events = pulled.events ?? [];
    if (!events.length) bad("中继上没有数据（推送没成功？）");

    fs.writeFileSync(captureFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    const capture = fs.readFileSync(captureFile, "utf8");
    ok(`抓到中继数据 ${events.length} 条 → ${captureFile}`);

    /* ③ 判据一：抓到的字节里没有明文 */
    if (capture.includes(marker)) bad("抓包里出现了明文标记 —— 内容层加密没生效");
    if (capture.includes("请记住这个标记")) bad("抓包里出现了提示词原文 —— 内容层加密没生效");
    ok("中继数据里搜不到明文标记，也搜不到提示词原文");

    /* ④ 判据二：没有密钥解不开 */
    const sealedFrames = events.filter((event) => {
      const payload = event.payload as { sealed?: unknown } | undefined;
      return Boolean(payload && typeof payload === "object" && "sealed" in payload);
    });
    if (!sealedFrames.length) bad("没有任何一条是密文帧（这个房间是不是没带密钥？）");
    let refused = false;
    try {
      await openFrame(sealedFrames[0] as never, undefined);
    } catch (error) {
      refused = /密钥/.test(String((error as Error)?.message ?? ""));
    }
    if (!refused) bad("没有密钥也能解开 —— 加密是假的");
    ok(`没有房间密钥时拒绝解开（密文帧 ${sealedFrames.length}/${events.length}；控制类明文是设计如此）`);

    /* ⑤ 判据三：带密钥的另一端看得到 */
    const opened = await openFrame(sealedFrames[0] as never, key);
    if (!JSON.stringify(opened).includes(marker)) bad("带密钥也读不出标记（两端解出来的东西对不上）");
    ok("带同一把密钥可以解开（该看到的人看得到）");

    const applied = await syncSession({ dataDir: dirB, sessionId: sid, to: base, token: server.token, producerId: "device-B", roomKey: key, owner: "local" });
    const storeB = createSqliteSessionStore(dirB);
    const bRecords = await storeB.load(sid);
    storeB.close();
    const bText = JSON.stringify(bRecords.records);
    if (!bText.includes(marker)) bad("设备 B 同步之后看不到标记（密钥没接上？）");
    ok(`设备 B 合并了 ${applied.applied} 条，并且看得到标记`);

    process.stdout.write(
      "\n结论：中继只搬运密文；没有房间密钥的第三方既读不到内容、也解不开；持钥的两端内容一致。\n" +
        (keep ? `临时目录已保留：${root}\n` : ""),
    );
  } finally {
    await server.stop();
    if (!keep) {
      /*
       * Windows 上刚关掉的 SQLite/HTTP 句柄可能还占着目录一会儿 ——
       * 清理失败**不该把一场通过的演示变成失败**：重试三次，仍失败就如实说"目录还在"，
       * 让人自己删（比吞掉或报错好）。
       */
      /* Windows 上 SQLite 的句柄要等 GC 才放；给一小段时间再删，删不掉就如实说 */
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        process.stdout.write(`（临时目录还锁着，没删掉：${root} —— 稍后手动删即可）\n`);
      }
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`出错了：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
