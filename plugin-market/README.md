# 插件市场索引（format 1）

> ⚠️ 仓库里这份是**格式示例 + 仓内示例插件**，不是线上市场。
> 线上索引需要一个稳定 URL 与审核流程；没有就是没有，不假装有。

## 用

```bash
ding plugins search 字数 --index plugin-market/index.json
ding plugins search "" --index https://example.com/ding/index.json
ding plugins install index:word-count --yes --index plugin-market/index.json
```

`--index` 不给时，从当前目录往上找 `plugin-market/index.json`。

## 格式

```json
{
  "format": 1,
  "updatedAt": "2026-10-17",
  "plugins": [
    {
      "id": "word-count",
      "name": "字数统计",
      "version": "1.0.0",
      "description": "一句话说明",
      "publisher": "作者 id",
      "enginesDing": ">=0.5.0",
      "tags": ["统计", "sample"],
      "homepage": "https://…",
      "npm": "package-name"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定 id（`index:<id>` 安装时用它） |
| `version` | 是 | `x.y.z` |
| `enginesDing` | 是 | 兼容的宿主版本范围（与 manifest 的 `engines.ding` 同义） |
| `npm` | 二选一 | npm 包名（安装走 `npm pack`） |
| `local` | 二选一 | **本地索引**里的目录（相对索引文件）；**远程索引里的 local 会被忽略** |
| `name` / `description` / `tags` / `publisher` / `homepage` | 否 | 搜索与展示用 |

## 索引不是信任

索引只回答"有哪些插件、去哪装"。**信任由签名与安装时验签决定**
（`engine/runtime/pluginSignature.ts`、`engine/adapters/pluginTrust.ts`）：
索引里写"官方"没有任何意义，装的时候验不过就是装不上。

### 索引自己的信任（L04）

索引本身也可能被换掉（尤其是远程索引）。两条路：

1. **签名索引**（推荐线上市场用）：顶层加 `publisher` 与 `signature`，用
   `pnpm plugin-sign sign-index --file plugin-market/index.json --publisher <id> --key <私钥.pem>`
   签。宿主会验签；同一个发布者**换公钥一律拒**（TOFU，与插件发布者同一套）。
2. **未签名索引**：第一次见到就钉住内容摘要（`<数据目录>/plugin-index-pins.json`）。
   之后内容一变就拒，确认来源可信后加 `--accept-index-change` 放行。

## 依赖

插件的 `ding-plugin.json` 可以声明依赖的其他插件：

```json
{ "dependencies": { "word-count": "^1.0.0" } }
```

依赖必须**已安装且开着**：安装时缺依赖直接拒（显式 `--allow-missing-deps`
可先装后补，但补齐前不会装载）；装载时缺依赖会跳过并在
`ding plugins list` 里说明原因。不做自动递归安装 —— 每一次下载都该是用户看过的。

## 兼容门

`enginesDing` 会被真的比较（`engine/runtime/pluginIndex.ts`）：

- 支持的写法：`*`、精确版本、`>=` `>` `<=` `<` `=`、`^`、`~`、空格 AND、`||` OR；
- **看不懂的范围一律当不兼容**（保守）；
- 不兼容的条目在搜索里**仍然列出**（标 ⚠️ 并说明原因），但安装会被拒。
