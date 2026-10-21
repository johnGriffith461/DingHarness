/**
 * 手工跑验收时用的**本地假通道**（与 `scripts/verify-acceptances.mjs` 里那个同形，
 * 只够这条脚本用：`/models` + `/chat/completions` 的 SSE）。
 *
 * 批跑自己会起一个更完整的；这个只服务"单独跑某一条验收"的场景。
 * 用法：`node scripts/accept/fake-provider.mjs 18099`
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 18099);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "accept-fake" }] }));
      return;
    }
    if (req.url?.includes("/chat/completions")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deepseek-flash" };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "好的，" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { content: "这一轮来自本地假通道。" }, finish_reason: "stop" }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `没有这个端点：${req.url}（${raw.length} 字节请求体）` } }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`fake provider on http://127.0.0.1:${port}`));
