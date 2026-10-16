# 插件示例（可以抄的那份）

这些目录是**真能装、真能跑**的插件，不是纸上的形状：

| 目录 | 它是什么 |
|---|---|
| `word-count/` | 最小插件（一个工具 + 一个钩子）。`PLUGIN.md` 的示例与它一一对应 |

用法：

```bash
ding plugins install plugin-samples/word-count --yes     # 装到本机
ding plugins list                                        # 看权限与状态
ding run "用 word-count 数一下这段话有几个字"
ding plugins remove word-count                           # 卸掉
```

## 为什么它跟着测试走

`src/pluginSamples.test.ts` 对 `plugin-samples/` 下的**每一个**目录都真跑一遍
安装（`installFromDir`）→ 装载（`loadEnabledPlugins`）→ 调工具（`runPluginTool`）
→ 跑钩子（`runHooks`），并断言：

- 清单能被 `checkManifest` 接住（形状对了才装得上）；
- 清单声明的工具名与入口导出的键**一一对上**（声明了没导出就会少一个工具）；
- 工具能真的被调用，返回值的字段与文档一致；
- 声明的钩子真的会被跑到。

所以：**示例改坏 → 测试红**。这是"文档里给的代码装不上"（审计 P204/P207 那一族）
在工程上的收口 —— 与其在文档里承诺"参考实现会现场造一个"，不如让示例自己进 CI。

## 加一个新示例

1. 建目录 `plugin-samples/<名字>/`，放 `ding-plugin.json` 与入口（默认 `index.mjs`）；
2. 清单里 `tools` / `hooks` 声明了什么，入口就导出什么；
3. 跑 `npx vitest run src/pluginSamples.test.ts` —— 绿了就说明这份示例真能装。

⚠️ 示例里**不要**引宿主的依赖（宿主也不保证它的内部模块路径稳定）；
工具参数用纯 JSON Schema，返回值按 `{ ok, output: { line } }`。
