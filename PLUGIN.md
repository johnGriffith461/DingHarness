# 写一个插件

> 这份指南对应**插件 v1**（Phase 8）。v1 的边界写在最前面，因为它决定你能做什么：
> **`tools:register` 与 `hooks:register` 是真的**（不批准就不接那根线），
> 而 `fs:read` / `fs:write` / `net` / `exec` **只是声明，拦不住**（插件与宿主同进程）。
> 也就是说：**装一个插件等于让它以你的身份在这台机器上跑**。请只装你读得懂的。

## 一个插件是什么

一个目录，里面有一个 manifest 和一个入口文件：

```
my-plugin/
  ding-plugin.json     ← manifest（权限声明必填）
  index.mjs            ← 入口（ESM 或 CJS 都行）
```

### manifest（`ding-plugin.json`）

```json
{
  "name": "word-count",
  "version": "1.0.0",
  "description": "数一数文件里有多少字",
  "main": "index.mjs",
  "permissions": ["fs:read"]
}
```

| 字段 | 说明 |
|---|---|
| `name` | 插件的唯一名字（工具名会带上它：`plugin__<name>__<工具名>`） |
| `version` | 语义化版本 |
| `description` | **不能太短**（校验会拒），用户装之前靠它判断 |
| `main` | 入口文件（相对 manifest） |
| `permissions` | **必填**。允许的值见下 |

**权限值**：

| 值 | 在 v1 里的实际含义 |
|---|---|
| `tools:register` | 真的生效：不批准，你的工具就不会被注册 |
| `hooks:register` | 真的生效：不批准，你的钩子不会被调用 |
| `fs:read` / `fs:write` | **只是声明**（告诉用户你要碰文件） |
| `net` | **只是声明** |
| `exec` | **只是声明** |

manifest 里声明了 `fs:read` 而实际不用它，用户会问"为什么要这个权限" ——
所以**只声明你真需要的**（安装时用户看到的就是这张表）。

### 入口

```js
// index.mjs —— 导出 tools（工具）和/或 hooks（钩子）
export const tools = [
  {
    name: "count",                       // 模型看到的是 plugin__word-count__count
    description: "数一段文本里有多少个字符（不含空白）",
    inputSchema: {                       // JSON Schema（不是 zod —— 插件不引我们的依赖）
      type: "object",
      properties: { text: { type: "string", description: "要数的文本" } },
      required: ["text"],
    },
    async run({ text }) {
      const n = String(text ?? "").replace(/\s/g, "").length;
      return { ok: true, output: { count: n, line: `数出来 ${n} 个字符` } };
    },
  },
];

export const hooks = {
  /* 只在"工具真要执行"之前调用；**返回值被忽略**（v1 的钩子只看不改） */
  "tool:before": async ({ name, input }) => {
    console.error(`[word-count] 即将执行 ${name}`);
  },
};
```

**工具的返回值**：成功给 `{ ok: true, output: { line, ... } }` ——
`line` 是界面上那一行留痕（不写的话留痕会退化成"已完成"，用户看不出结果）。
失败给 `{ ok: false, error: "人话" }`（原文会回注给模型）。

## 四个钩子

| 钩子 | 什么时候 | 参数 |
|---|---|---|
| `session:start` | 一轮开始前 | `{ sessionId, provider, model }` |
| `tool:before` | 某个工具**执行前** | `{ name, input }` |
| `tool:after` | 某个工具**执行后** | `{ name, ok, error? }` |
| `turn:end` | 一轮结束 | `{ sessionId, ok, aborted }` |

⚠️ **钩子的返回值被忽略**：v1 里钩子**不能**改参数、也不能拦调用。
理由是可观测性 —— "模型说它调了 A、实际执行的是 B"这种事在留痕里看不出来。
要"能改行为"的能力等 v2 的隔离方案。

**钩子抛异常不会影响那一轮**（我们吞掉并记日志）：插件坏了不该变成用户的故障。

## 装 / 试 / 卸

```bash
ding plugins install ./my-plugin      # 本地目录
ding plugins install npm:word-count   # npm 包（要 --yes 确认权限清单）
ding plugins list                     # 看装了哪些、开着哪些
ding plugins doctor                   # 查装载有没有问题
ding plugins disable word-count        # 关掉（不删）
ding plugins uninstall word-count      # 卸掉
```

桌面端在「插件 · 技能 · 伙伴」页的「外部插件」段里做同样的事（含权限确认对话框）。

## 两条容易被忽略的规矩

1. **装完再改 manifest**：台账里存的是**你批准时那份清单的快照** ——
   之后文件被改过，装载会**拒绝**（`manifestDrifted`）。这是防"批准时人畜无害、
   之后偷偷加上 `exec`"。改了 manifest 就要重新装一次（等于重新确认一次）。
2. **工具名会带前缀**：模型看到的是 `plugin__<插件名>__<工具名>`。
   别在工具名里再写一遍插件名。

## 调试

```bash
ding plugins doctor          # 装载失败的原因会列在这里（含 require/import 的错误）
ding run "用 word-count 数一下这段话"
```

工具的调用与结果都会进会话日志（`ding sessions --export <id>` 能看到），
所以"工具到底被调没被调、参数是什么"是可查的 —— 别靠猜。

## 参考实现

仓库里 `scripts/accept/` 的插件验收脚本会现场造一个最小插件（含工具与钩子），
可以直接拿来当模板改。
