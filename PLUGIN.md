# 写一个插件

> 这份指南对应**插件 v1**（Phase 8）。v1 的边界写在最前面，因为它决定你能做什么：
> **`tools:register` 与 `hooks:register` 是真的**（不批准就不接那根线），
> 而 `fs:read` / `fs:write` / `net` / `exec` **只是声明，拦不住**（插件与宿主同进程）。
> 也就是说：**装一个插件等于让它以你的身份在这台机器上跑**。请只装你读得懂的。
>
> ⚠️ 这份文档的**每一处形状都以代码为准**：`engine/runtime/plugins.ts` 的
> `checkManifest` 与 `engine/runtime/pluginHost.ts` 的装载逻辑。
> 照这份文档写出来的东西**真的能装、真的能跑** ——
> 仓库里 `plugin-samples/word-count/` 就是照它写的一份最小插件，
> 由 `src/pluginSamples.test.ts` 每次跑测试时真装一遍、真调一遍
> （把示例改坏，那条测试就红）。抄它比抄文档快。

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
  "description": "数一数一段文本里有多少个非空白字符",
  "main": "index.mjs",
  "tools": ["count"],
  "hooks": ["tool:before"],
  "permissions": ["tools:register", "hooks:register"],
  "engines": { "ding": ">=0.5.0" }
}
```

| 字段 | 说明 |
|---|---|
| `name` | 插件的唯一名字（工具名会带上它：`plugin__<name>__<工具名>`）。小写字母开头，只含小写字母/数字/连字符，2–41 字符 |
| `version` | 语义化版本（`1.0.0` 这种形状） |
| `description` | **不能太短**（少于 8 个字符会被拒），用户装之前靠它判断 |
| `main` | 入口文件（相对 manifest，默认 `index.mjs`）。**不许**绝对路径或 `../` |
| `tools` | 它提供哪些工具（**名字**数组）。声明了却没导出 → 装载时报出来；导出了没声明 → **不接** |
| `hooks` | 它挂在哪些生命周期点上（见下表的四个名字）。声明外的钩子**不会被调用** |
| `permissions` | **必填**（可以是空数组 `[]`，表示什么权限都不要）。允许的值见下 |
| `engines.ding` | **必填**。它兼容的宿主版本（例如 `">=0.5.0"`） |
| `publisher` | 可选。`{id, name?, key}` —— 发布者身份。`key` 是 ed25519 公钥（base64 的 SPKI DER），**私钥永远不进插件** |
| `signature` | 可选。发布者用私钥对"这个插件"的签名（base64）。**与 `publisher` 成对**：缺一个都是清单错误 |

⚠️ `tools` / `hooks` 声明了，就**必须**同时申请对应的权限
（`tools:register` / `hooks:register`）—— 两者不一致会被当成作者写错了，安装直接失败。

**权限值**：

| 值 | 在 v1 里的实际含义 |
|---|---|
| `tools:register` | 真的生效：不批准，你的工具就不会被注册 |
| `hooks:register` | 真的生效：不批准，你的钩子不会被调用 |
| `fs:read` / `fs:write` | **只是声明**（告诉用户你要碰文件） |
| `net` | **只是声明** |
| `exec` | **只是声明** |

前两条真的拦得住那件事由 `engine/runtime/plugins.test.ts` 的「权限与能力注入」那组用例钉着
（清单声明 + 用户批准，两条都在才接上线；用户拒了某一项 → 那条线不接）。

manifest 里声明了 `fs:read` 而实际不用它，用户会问"为什么要这个权限" ——
所以**只声明你真需要的**（安装时用户看到的就是这张表）。

### 入口

```js
// index.mjs —— 导出 tools（工具）和/或 hooks（钩子）
export const tools = {
  count: {
    description: "数一段文本里有多少个非空白字符",
    inputSchema: {                      // 纯 JSON Schema（不是 zod —— 插件不引宿主依赖）
      type: "object",
      properties: { text: { type: "string", description: "要数的文本" } },
      required: ["text"],
    },
    async run(input) {                  // (input, ctx) → 结果
      const text = typeof input?.text === "string" ? input.text : "";
      const n = text.replace(/\s/g, "").length;
      return { ok: true, output: { count: n, line: `数出来 ${n} 个字符` } };
    },
  },
};

export const hooks = {
  /* 只在"工具真要执行"之前调用；**返回值被忽略**（v1 的钩子只看不改） */
  "tool:before": async ({ name }) => {
    console.error(`[word-count] 即将执行 ${name}`);
  },
};
```

⚠️ **`tools` 是对象表，不是数组**：键就是工具名（清单里 `tools` 声明的那几个），
装载端按 `Object.keys(mod.tools)` 与清单对账。

**工具的返回值**：成功给 `{ ok: true, output: { line, ... } }` ——
`line` 是界面上那一行留痕（不写的话留痕会退化成"已完成"，用户看不出结果）；
它由 `shared/agentTools.ts` 的 `describeToolResult` 取出来，最长显示 80 字
（那条分支由 `src/pluginSamples.test.ts` ② 钉着：示例的 `line` 必须真的出现在留痕里）。
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
ding plugins install ./my-plugin      # 本地目录（装之前会列出它要的权限，要加 --yes 才真装）
ding plugins install npm:word-count   # npm 包（同上，两段式确认）
ding plugins list                     # 看装了哪些、开着哪些
ding plugins doctor                   # 查装载有没有问题
ding plugins disable word-count        # 关掉（不删）
ding plugins remove word-count         # 卸掉（台账 + 拷进来的那份内容都清，你给的源目录不动）
```

桌面端在「插件 · 技能 · 伙伴」页的「外部插件」段里做同样的事（含权限确认对话框）。

## 签名（可选，但建议）

签名的意义只有一条：**装完之后内容被改过，能被验出来**。没签名的插件照样能装能跑
（v1 兼容），只是没人替它担保。

### 怎么签

```bash
# ① 生成一把发布者钥匙（Ed25519）—— 私钥留在你手里，别外传
pnpm plugin:sign keygen --out ./acme-key

# ② 签名：把 publisher + signature 写进 ding-plugin.json
pnpm plugin:sign sign --dir ./my-plugin --publisher acme --name "ACME 工作室" --key ./acme-key.pem
```

⚠️ 签完**再改任何文件、或改清单里任何字段**（哪怕只是改个 description）都要**重新签**。

### 它签的是什么

两个面一起进摘要：**整棵目录的文件清单**（逐文件 sha256）与**清单里除 `signature`
之外的全部字段**。所以：

- 改一个字节 → 摘要变 → 验不过；
- 换一把公钥还说自己是同一个 id → 摘要变 → 验不过。

⚠️ 由此有一条规矩：**签名的插件用 `ding-plugin.json` 装清单**（`package.json#ding`
那条渠道不签 —— 签名得有个"不被自己覆盖"的位置，而 package.json 自己在文件面里）。

### 装的时候会发生什么

| 情形 | 结果 |
|---|---|
| 没签名（v1 插件） | **照装**，台账记 `unsigned`（"没有签名"≠"签名坏了"） |
| 签名验过，第一次见这个 `id`+钥匙 | 装，记 `unverified`（钥匙钉进信任表，TOFU；签名是真的，身份还没被复核过） |
| 签名验过，`id`+钥匙与信任表一致 | 装，记 `trusted`（**同一把钥匙** —— 不是"它安全"） |
| 签名验不过（文件被改 / 不是这把钥匙签的） | **拒装**，并说清是哪一种对不上 |
| 同一个 `id` 带了**另一把**钥匙 | **拒装**（身份被换掉这件事不能由"装个插件"顺手接受；轮换钥匙要先删信任表里那条） |

信任表在数据目录的 `plugins/trusted-publishers.json`（与台账同一层）。

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

`plugin-samples/` 下有一份**真能跑**的最小插件（`word-count`：一个工具 + 一个钩子，
manifest 与入口都对应本文档的形状）。可以直接 `cp -r` 出去改。

它不是在文档里"应该有"而已：`src/pluginSamples.test.ts` 会真的
`installFromDir` → `loadEnabledPlugins` → 调工具 → 跑钩子，
并且对 `plugin-samples/` 下**每一个**目录都这么做 —— 把示例改坏（少一个导出、
漏一项权限、入口写错形状），那条测试立刻红。
