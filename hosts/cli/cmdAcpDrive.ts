/**
 * `ding acp-drive` —— 让 Ding 驱动**外部** ACP agent（V6-3f）。
 *
 * ```
 * ding acp-drive --cmd node --arg ./my-agent.mjs --prompt "把报表整理一下" --cwd .
 * ding acp-drive --cmd claude-code-acp --prompt "…" --timeout 600000
 * ```
 *
 * `--arg` 可重复（每个参数一个）。为什么不用 `ding acp-drive <命令 ...>`：
 * 命令自己的旗标（`--foo`）会被 Ding 的参数解析吃掉 —— `--arg` 明确、不歧义。
 */
import { AcpClient } from "../acp/client";
import { flag, flagAll, parseIntFlagValue, type Parsed } from "./args";

export async function cmdAcpDrive(p: Parsed): Promise<number> {
  const command = flag(p, "cmd");
  const prompt = flag(p, "prompt");
  if (!command || !prompt) {
    process.stderr.write(
      "用法：ding acp-drive --cmd <可执行> [--arg <参数> …] --prompt \"任务\" [--cwd <目录>] [--timeout <ms>]\n" +
        "  例：ding acp-drive --cmd node --arg ./my-agent.mjs --prompt \"整理报表\" --cwd .\n",
    );
    return 2;
  }
  const timeout = parseIntFlagValue(flag(p, "timeout"), "timeout", { min: 1000, max: 3_600_000, fallback: 120_000 });
  if (!timeout.ok) {
    process.stderr.write(`${timeout.message}\n`);
    return 2;
  }
  const cwd = flag(p, "cwd") ?? process.cwd();
  const args = flagAll(p, "arg");

  const client = AcpClient.spawn({
    command,
    args,
    cwd,
    timeoutMs: timeout.value,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  try {
    const init = await client.initialize();
    process.stderr.write(`✓ 握手完成（protocolVersion=${String(init.protocolVersion ?? "?")}）\n`);
    const sessionId = await client.newSession(cwd);
    process.stderr.write(`✓ 会话：${sessionId}\n`);

    let streamed = false;
    client.onUpdate(({ update }) => {
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        const content = update.content as { text?: unknown } | undefined;
        if (typeof content?.text === "string") {
          streamed = true;
          process.stdout.write(content.text);
        }
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const title = String(update.title ?? update.toolCallId ?? "");
        const status = String(update.status ?? "");
        process.stderr.write(`\n⚙ ${title}${status ? ` [${status}]` : ""}\n`);
        return;
      }
      process.stderr.write(`\n· ${kind || "(未知 update)"}\n`);
    });

    const result = await client.prompt(sessionId, prompt);
    if (streamed) process.stdout.write("\n");
    process.stderr.write(`✓ 收尾：${result.stopReason}\n`);
    /*
     * 退出码跟着 stopReason：`end_turn` 才算成功；`cancelled` / 其它值都是"没跑完"，
     * 不该让脚本把它当成成功（那会让 CI 里"agent 被取消"看起来像通过）。
     */
    return result.stopReason === "end_turn" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`出错了：${String((error as Error)?.message ?? error)}\n`);
    const tail = client.stderr();
    if (tail) process.stderr.write(`外部 agent 的 stderr（最后一段）：\n${tail}\n`);
    return 1;
  } finally {
    await client.close();
  }
}
