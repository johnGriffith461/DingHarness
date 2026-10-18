# 投稿一个插件（E04）

> 三件事：**自检通过 → 带签名 → 进索引**。前两件是技术门槛，第三件是运营决定
> （索引里出现什么，由维护者按下面的门槛收）。

## 1. 先自检（安装时会拒的，这里先拒）

```bash
ding plugins verify ./my-plugin
ding plugins verify ./my-plugin --json      # 给 CI 用
```

它跑的是安装时的**同一批判据**（不是另写一套）：清单合法、`engines.ding` 兼容、
入口存在、签名（有就必须验得过）、以及**真起一次隔离进程**看"声明的工具/钩子"
与"导出的"是否一一对上。

一个常见坑：`tools: ["hello"]` 但代码里导出的是 `Hello` —— 自检会点名，安装也会拒。

## 2. 签名（可选，但市场里推荐）

```bash
pnpm plugin-sign keygen --out ./my-publisher-key
pnpm plugin-sign sign --dir ./my-plugin --publisher <你的 id> --name "你的工作室" --key ./my-publisher-key.pem
ding plugins verify ./my-plugin      # 再跑一次：签名有效
```

- 私钥**永远不进插件目录、不进索引**；
- 发布者 id 与公钥第一次被装的人看到时会被钉住（TOFU），之后**换钥匙一律拒**；
- 没签名也能装 —— 只是用户会看到「没人担保」，别把这句话藏起来。

## 3. 进市场索引

在 `plugin-market/index.json` 里加一条（`format: 1`）：

```json
{
  "id": "word-count",
  "name": "字数统计",
  "version": "1.0.0",
  "description": "一句话说清它干什么、不改什么",
  "publisher": "your-publisher-id",
  "enginesDing": ">=0.5.0",
  "tags": ["统计"],
  "npm": "your-npm-package"
}
```

提交前先自检索引本身：

```bash
ding plugins verify-index plugin-market/index.json
ding plugins verify-index plugin-market/index.json --json   # 给 CI
```

它离线校验：结构/坏条目、签名或指纹、每条来源（npm 名形状、本地目录存在、`enginesDing` 是否覆盖当前宿主）。

要求：

- `id` 稳定（用户用它 `install index:<id>`）；
- `npm` 指向真实可 `npm pack` 的包；本地示例才用 `local`（远程索引里的 `local` 会被忽略）；
- 索引本身要签名（`pnpm plugin-sign sign-index`）或接受首次钉摘要 ——
  **改索引内容不重签，用户那边会拒**（这正是它该做的）。

## 4. 维护者收不收：四条门槛

1. **自检全绿**（第 1 步）；
2. **说明与行为一致**：`description` 不夸大，申请的权限确实是它要用的；
3. **不碰密钥**：插件运行在隔离进程里，但 `net` 拦不住 —— 索引进来的插件
   不得读取/上传宿主凭据，发现即下架；
4. **可卸载**：装/卸不留残渣（`ding plugins remove` 之后目录与台账都干净）。

## 5. 版本与兼容

- `engines.ding` 写**最低兼容**版本，不要写 `*`；
- 破坏性改动升 major，并在 `description` 或包 README 里说"从哪个版本开始不兼容"；
- 依赖别的插件时用 `dependencies`（`插件名 → 范围`），不要靠 README 口头约定 ——
  缺依赖时安装会拒、装载会跳过并说明原因。

## 6. 发布之后

```bash
ding plugins install index:word-count --yes --index plugin-market/index.json
```

装完 `ding plugins list` 会显示：权限（哪些真生效）、签名信任态（未签名/首次见到/
同一把钥匙）、依赖、隔离档位。这四行就是"用户能不能相信这个插件"的全部信息。
