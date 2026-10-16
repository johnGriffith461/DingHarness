/**
 * word-count —— PLUGIN.md 的最小可跑插件（工具 + 钩子各一个）。
 *
 * ⚠️ 两处**必须**与清单（`ding-plugin.json`）对上，否则装载时会如实报错、工具一个都不接：
 *   1. `tools` 是**对象表**（键 = 工具名），不是数组 —— 装载端按 `Object.keys(mod.tools)` 对账；
 *   2. 清单里 `tools` / `hooks` 声明了什么，这里就得导出什么（声明了没导出 → 报出来；导出了没声明 → 不接）。
 *
 * 这个文件不进产品产物，它是**给人抄的模板**；`src/pluginSamples.test.ts` 会真的把它装一遍、
 * 跑一遍、并断言返回的 `output.line` 确实出现在界面留痕里。
 */

export const tools = {
  count: {
    description: "数一段文本里有多少个非空白字符",
    /* 纯 JSON Schema（插件不引宿主的 zod）—— 形状不对时会退回"一个空对象 schema"，不会装不上 */
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要数的文本" } },
      required: ["text"],
    },
    /**
     * @param input 模型给的参数（形状不可信）
     * @returns `{ ok: true, output: { count, line } }`；`line` 就是界面上那一行留痕
     */
    async run(input) {
      const text = typeof input?.text === "string" ? input.text : "";
      const count = text.replace(/\s/g, "").length;
      return { ok: true, output: { count, line: `数出来 ${count} 个字符` } };
    },
  },
};

export const hooks = {
  /* 只在"工具真要执行"之前调用；**返回值被忽略**（v1 的钩子只看不改） */
  "tool:before": async (payload) => {
    console.error(`[word-count] 即将执行 ${payload?.name ?? "?"}`);
  },
};
