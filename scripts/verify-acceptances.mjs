import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { killLeftovers } from "./accept/harness.mjs";

/**
 * 批跑**不依赖模型**的验收脚本。
 *
 * ## 为什么需要它
 * `.verify/` 下已有 45 条验收，但**没有一轮全跑过** —— 多数要真调模型、真等出图，
 *   accept-chatapprove —— 聊天里被拦下的工具就地批准（要模型真的调工具）
 *   accept-chatartifact —— 聊天里产出的文件变成卡片（要模型真的吐 artifact 标签）
 * 全跑一遍耗时很长。所以实际情况是"每轮挑与改动相关的那几条"，
 * 而代价是：**与改动无关的脚本可能已经悄悄过期**。
 *
 * §56 就撞到过一次：产品换了 UI 结构、脚本还在找旧 testid，
 * 于是那两步**静默跳过**、脚本却仍然"通过"。**静默少测比测试失败更危险。**
 *
 * 这一条把"随手回归一遍"的成本从"手动挑"降到一条命令，
 * 从而让那类过期更容易被撞见。
 *
 * ## 判据
 * 只收**完全不需要模型**的脚本：跑得快、不受网络与上游波动影响，
 * 所以适合频繁跑。需要模型的（出图、写文档、问答）不在这里。
 *
 * ## ⚠️ 单独跑它时会有几条**环境红**（2026-10-16，审计 A21）
 *
 * 打包类那三条（`accept-p6` / `accept-package` / `accept-installed`）在 `CASES` 里：
 * `pnpm build` 链的尾巴就是本批跑，而那时 `package:win` 刚跑过、产物就在眼前。
 * 但**单独 `pnpm verify:accept`**（没打过包、没装过）时，它们会**明确报「环境红」** ——
 * 缺产物不等于通过，也不假装是产品坏了（判词里写着「先 pnpm package:win」）。
 * 所以：**要全绿得先 `pnpm package:win`**（`accept-installed` 还要先静默安装到 `.verify/instA`）；
 * 只有这三条红、其余全绿时，那是"还没打包"，不是"产品坏了"。
 *
 * 用法：node scripts/verify-acceptances.mjs
 */

/**
 * 验收脚本所在目录。
 *
 * ── B5（2026-10-13）：从 `.verify/` 分出来并纳入版本库 ──
 *
 * 原来这 94 条脚本和 700 多个**一次性手术脚本**（`wire-*.py` / `append-*.py` /
 * `diag-*.mjs` / `tmp-*.txt`）混在同一个被 gitignore 的目录里。后果：
 * "哪些是真验收、哪些是当场的临时动作"只存在于记忆里，而且**这批最值钱的资产不在版本库里**。
 *
 * 分出来之后：`.verify/` 剩下的一律是**一次性/临时**的东西（可以整目录忽略），
 * 而这里每一条脚本都跟着 commit 走。
 *
 * ⚠️ 搬迁是安全的，三条实测依据（不是推断）：
 *   ① 51 条脚本 import 的是**同级** `./harness.mjs`，`harness.mjs` **一起搬了**，所以路径仍对；
 *   ② 192 条 .mjs 里**179 条硬编码项目绝对路径**（当时那版工程的工作目录，与脚本自身位置无关）；
 *      ⚠️ 2026-10-14 项目迁到 `C:\DingHarness` 之后那批硬编码**全部失效**（脚本一跑就找不到
 *      electron.exe 与它自己的数据目录）。已改成**相对仓库根**的路径 ——
 *      批跑器不传 `cwd`，所以子进程的 cwd 就是仓库根，相对路径解析到同一处，
 *      而脚本从此跟着仓库走（换机器/换目录都不用再改）。
 *   ③ 只有 8 条提到 `.verify/` 字面路径，且**全部是截图输出**（如 `.verify/theme-toggled.png`），
 *      而那些是相对**进程 cwd**（本批跑器不传 `cwd`，即仓库根）解析的，与脚本位置无关。
 */
const ACCEPT_DIR = "scripts/accept";

/**
 * 批跑的**记录**仍留在 `.verify/`。
 *
 * 这两个文件每次跑都会变（`:353` 的 `accept-history.json`、`:405` 的 `accept-runs.jsonl`），
 * 属于**运行产物**而不是脚本 —— 入库只会制造无意义的 diff。
 */
const RECORDS_DIR = ".verify";

/** 只跑这些：都不调模型。 */
/*
 * ────────────────────────────────────────────────────────────────
 * ⚠️ **覆盖缺口（2026-10-13 逐条跑过一遍之后如实记在这里）**
 *
 * `scripts/accept/` 共 99 条，这份批跑收 58 条。剩下的分三类（**都不在下面，都不会被定期跑**）：
 *
 * **甲 · 需要模型**（按设计不收，单独跑）：见本文件下方那段长注释里的清单。
 *
 *   ⚠️ **2026-10-14 修**：`accept-material`（@ 添加资料）与 `accept-mcp`（连接器）
 *   原先列在上面那份"免模型"清单里 —— 而它们断言的是"**模型看见了什么**"
 *   （请求体里有没有资料块 / 这一轮下发了哪些工具），**必须有真模型跑一轮**才成立。
 *   代价实测到了：那天 `DSH_NO_REAL_MODEL` 这个防烧钱闸被修成真的之后，
 *   这两条立刻红，而红的原因是"没模型" —— 也就是说**在此之前它们一直在悄悄花钱**
 *   （批跑号称免模型，实际上替它们打了真调用）。
 *   已挪出免模型清单。要让它们重回"免费"得给批跑接一个**本地假 provider**（见下方遗留项）。
 *
 * **乙 · 报告型：能跑完、但一条判定都没有**（只 `console.log` 一个报告就退）——
 * 它们**在批跑里等于"静默不测"**（永远 exit 0）。
 * ✅ **2026-10-14 已逐条补上后果断言**，能跑的已收进下面的清单：
 *   `accept-drive` / `accept-edit` / `accept-new` / `accept-schedule`（已收）
 *   `accept-installed` / `accept-p6` / `accept-package`（**仍不收**：要装机版/打包产物，
 *     本机没装过就是"跳过"而不是"通过"，塞进免模型批跑只会制造假绿）
 *
 * **丙 · 已经过期**（跑出来是红的）：
 *   ✅ `accept-context`（菜单 testid 从 `wb-ctx-*` 改成 `wb-drive-menu-*`；
 *      删除改成走确认框；顺带逮到**真缺陷**：`refresh()` 把「已复制链接」回执吃掉）
 *   ✅ `accept-export`（"没有画框"的提示是常驻浮层且盖在导出菜单上，不点掉后面全被挡）
 *   🗑️ `accept-voice`：**2026-10-16 删了**（主人把设置里的「声音选择」拆了 —— 没有可挑的音色，就没有可验的入口）
 *   ✅ `accept-p5-prompt` **退役**：它读的 `window.__lastAiPrompt` 是 DEV-only 探针，
 *      打包产物里根本没有 → 这条脚本**永远跑不了**。它要守的东西已搬进单测
 *      （`src/canvas/markers.test.ts` 里 `instructionFromMarkers` 那 5 条）。
 *
 * 这份清单**不是"以后再说"**：§97 撞过的就是"久没跑 → 早已失效 → 谁都不知道"。
 * 逐步把它们归到"能跑且会判定"或"明确废弃"，缺口才算真的关掉。
 */
/*
 * ⚠️ **不在批跑里的脚本 —— 结构化名单**（2026-10-16，审计 G96）。
 *
 * 这份文件里原来有一段很长的散文，讲"哪些脚本为什么不进批跑"。散文的问题不在长短，
 * 而在**它不可执行**：DEFECT-PROTOCOL 第 4/5 步写的是硬规矩
 * （「不进批跑 = 没人跑」「没有回归用例的修复不算修完」），而仓里只有**一个方向**的对账
 * （登记了 → 文件在不在，缺则记一笔红）；反过来「文件在 → 没登记」**没有任何东西在查**。
 * 实测：`scripts/accept/` 有 99 个 `accept-*.mjs`，`CASES` 只登记 71 个 ——
 * 剩下那 28 个到底是"按设计不进"还是"忘了"，只有散文说了算，而散文不会红。
 *
 * 现在两条一起做：
 *   ① 这份名单是**数据**（`kind` + `why` 必填），`src/acceptRegistry.test.ts` 拿它跟文件系统对账，
 *      两边对不上就红 —— 新写一个脚本忘了登记，第一次 `pnpm test` 就会撞上；
 *   ② `kind` 里 **`debt` 是明账**：它承认"本该进批跑、现在还没进"，
 *      守卫会把它印出来并卡住总数（只许少不许多）。债可以欠，但要记账。
 *
 * kind 的四种取值：
 *   · `needs-model`   真调模型（烧钱 + 受上游波动影响，不适合无模型批跑）
 *   · `needs-package` 要先有打包/安装产物（`pnpm package:win` 之后才谈得上跑）
 *   · `debt`          本该进批跑，还没进（要么改造它、要么把它跑通后登记进 CASES）
 *   · `retired`       已退役（脚本自己头部写了退役声明），留着只供开发期手工排查
 *   · `fossil`        化石：早就与产品脱节（打 dev server / 硬编码本机路径），要么重写、要么删
 */
const NOT_IN_BATCH = {
  /*
   * ⚠️ 2026-10-16（A20 收尾）：图像那四条（`accept-imagegen` / `accept-image-actions` /
   * `accept-imageedit` / `accept-size-spec`）**已从这张名单里划掉、收进 CASES**。
   *
   * 堵住它们的那一格里有两半，这次补齐了：
   *   ① 产品侧：`IMAGE_PROVIDERS` 补了 `baseURLEnv`（与文本那张表同一口径），
   *      `lunora` 那条规定 `LUNORA_BASE_URL` —— 图像通道终于能指向自建/中转/假服务；
   *   ② 装置侧：批跑的本地假通道认了 `/images/generations` 与 `/images/edits`，
   *      按请求里的 `size` 现造一张真 PNG（b64_json），于是"出图 / 能显示 / 尺寸对得上"
   *      全都能在**零出网**下验。
   * 顺带把三条**只打报告、没有判定**的脚本补上了真判定（那是它们在批跑里的唯一入场券）。
   */

  /* ── 要先有打包 / 安装产物 ── */
  /*
   * ⚠️ 2026-10-16（A21）：`accept-p6` / `accept-package` / `accept-installed` **已进 CASES**
   * （见上面那三条与它们的说明）。只剩这一条留在名单里，理由是它**另有两处硬依赖** ——
   * 不是"要产物"这么简单，见 why。
   */
  "accept-packaged-run.mjs": { kind: "needs-model", why: "打包版端到端。它**不能**进批跑，两处硬依赖：① 第 4 项要求打包版**真的生成一张图**（`img[src^=dshasset://]` + naturalWidth）—— 图像通道的 baseURL 覆盖口 2026-10-16 已补（见 A20），所以这一处不再是拦路的了；② 但整条**没有任何判定**（只有 console.log(report)）—— 收进批跑只会多一条 no-judge（= 没测）。要收得先补判定（它验的是打包产物，本身也该进 needs-package 那一类）" },
};

const CASES = [
  /*
   * 窗口控制（2026-10-15，M0 工单 1）。用户报「右上角关闭/最小化按钮重复显示」，
   * 根因是原生 `titleBarOverlay` 那套固定画在右上角的按钮，压住了云盘/插件/定时任务
   * 三个视图自己的操作按钮。修法：删覆盖层 + 自绘窗口按钮 + `.wb` 让出标题栏那一条。
   *
   * 这条进批跑是**必须的** —— 它同时挡两件容易悄悄复发的事：
   *   ① 原生覆盖层被加回来（源码守卫 `src/windowChrome.test.ts` 挡写法，这条挡行为）；
   *   ② 某个视图/浮层又把按钮放进标题栏那一条（拖动区会吃掉点击，表现为"按钮点不动"）。
   * 拖动那一步用**真实鼠标输入**（SendInput）—— Playwright 的合成事件驱动不了
   * app-region 那条系统拖拽路径，实测会把好的拖动区判成"拖不动"（假阴性）。
   */
  ["accept-windowctl.mjs", "窗口控制（自绘一套按钮 / 标题栏是拖动区 / 底下无被压按钮 / 拖动·最大化·还原·最小化 / 跟随主题）"],
  /*
   * 配置型 store 的 **SQLite KV 路径**（Phase 12.1）。批跑里那一大批脚本固定走文件后端
   * （见 run() 里那段说明），所以"默认那条路在桌面里行不行"由这一条盯：
   * 写进 stores.db / 不写 JSON 文件 / **重启后读得回** / 回退开关能退。
   */
  ["accept-kvstore.mjs", "配置型 store 走 SQLite KV（写进 stores.db / 不写 JSON / 重启后读得回 / 回退开关）"],
  /*
   * 右侧面板（2026-10-15，M0 工单 2）。修前实测的三条事实写在脚本头部：
   * 摘要面板本来就能关、侧栏把手热区没被吞，真问题在**关的入口只有一颗 17px 的 `‹`**
   * 与两个面板都缺 Esc。断言落在"入口带字 / Esc 可关 / 往返各 10 次一致"。
   */
  ["accept-panels.mjs", "右侧面板（两个都能开关 / 收起入口带字 / Esc / 往返各 10 次 / 把手热区未被吞）"],
  /*
   * 左栏折叠（2026-10-15，M0 工单 3）。这颗按钮原来**六个页面各写一遍**、六份都是 disabled，
   * 工单清单里它一个占五处。工单对这类给的是"能快的就实现"，所以按实现办：
   * 一处组件六处收口。这条断言它真的能收能开，**并盯住"收起后按钮自己还在"** ——
   * 那是唯一能再打开左栏的入口（它在页面头部，不在左栏里）。
   */
  ["accept-navcollapse.mjs", "左栏折叠（四个页面 + 任务中心能收能开 / 收起后按钮仍在 / 标题跟着状态走 / 往返 10 次）"],
  /*
   * 开箱冒烟与 DPI 矩阵（2026-10-15，M0 工单 4 机制 2 / 3）。
   *
   * 冒烟刻意**不追覆盖率**：它一次启动走完 启动 → 窗口 → 左栏 → 右栏 → 画布 → 设置 → 主路径
   * 各一格，问的是"装完能不能用"。矩阵则把 100% / 125% / 150% × 还原·最大化·再还原 每格实测
   * —— 右上角那套按钮原来是原生画的，缩放下会怎样从来没人量过。
   */
  ["accept-smoke.mjs", "开箱冒烟（一次启动走完各条最小路径：启动/窗口/左栏/右栏/画布/设置/主路径）"],
  ["accept-dpi-matrix.mjs", "DPI 矩阵（100%·125%·150% × 还原·最大化·再还原，逐格断言标题栏与按钮）"],
  ["accept-accountmenu.mjs", "账号菜单 + 外观设置子菜单（三选一）"],
  /*
   * Ding Harness 视觉系统的口径（2026-10-14 落地那一轮的产物）。
   * 它挡的是"不报错、不崩、只是某处不对"那类失效 —— 最典型的是装饰渐变：
   * 落地时漏掉整整一族（清点器只认 `#hex`，`linear-gradient(...)` 被跳过），
   * 最后靠**看截图**才发现手机遥控页那块浅蓝。这条把它变成断言。
   */
  ["accept-brand.mjs", "视觉系统（三族字体 / 纸白·暖墨 / 无冷色 / 区块标题衬线）"],
  ["accept-chips.mjs", "输入区 chip（项目 / 按需确认点了要有反应）"],
  /*
   * ⭐ 2026-10-16：**三条曾经因"要模型"被排除的脚本收回来了**（审计 G46/G47 的正面结果）。
   *
   * 它们要的是"发一轮、有回复"，而批跑现在自带**本地假通道** + `DSH_NO_REAL_MODEL=1`
   * （见本文件上面的 `startLocalFakeModel`）—— 于是这一类脚本重新变得"免费且确定"。
   * 同时它们也是 G08/G09/G10 的主场：三条脚本原来**永远红**（读废弃的 .jsonl 通道 /
   * 断言从未赋值的变量），本次一并修好，回收是为了让修复真的被定期跑到。
   */
  ["accept-material.mjs", "资料（@ 添加资料：真进请求 / 标记在正文里 / 工具清单有落痕）"],
  ["accept-sessionlog.mjs", "会话日志（走 IPC：request 带用户内容 / 工具成对 / done 收尾 / 正文对得上界面）"],
  ["accept-abort.mjs", "停止与流式（正文实时在长 / 停止键 / 点了真收 / 步骤说已中止 / 日志有终止记录）"],
  ["accept-modelchip.mjs", "输入区的「模型 · 思考」chip（真列模型 / 真落盘 / 默认不发字段）"],
  /*
   * ⭐ 2026-10-16（A22）：`accept-providers` **按现界面重写并收回批跑**。
   * 它原来是墓碑（整条建在已拆掉的画布对话侧栏上），而墓碑自己也承认
   * 「真调用成功过 → 界面标出已验证」这条**没有替代品** —— 那是要还给清单的东西。
   * 重写后不点"探测"按钮（现界面没有它了），改成**真跑通一轮**再看设置·模型页那一列。
   */
  ["accept-providers.mjs", "provider 状态诚实（没密钥的写无密钥 / 真跑通一轮之后那一家升成已验证）"],
  ["accept-settings-models.mjs", "设置·模型页（左列 provider / 状态是真的 / 拉取要么出清单要么给人话 / 勾选与默认落盘）"],
  /*
   * ⚠️ `accept-theme.mjs` **2026-10-14 退役**（从这份清单摘掉，脚本本体留在原地并加了墓碑说明）：
   * 它点的是设置弹窗里的「外观」行，而**外观早就挪到账号菜单的子菜单**（`wb-acct-appearance`）——
   * 导航是死的（点了永远等不到），而它**没有判定**，于是长期 exit 0 混在批跑里。
   * 它的判据（三选一 + 持久化 + **刷新后仍按选过的那档渲染**）已由 `accept-accountmenu.mjs` 接住。
   */
  // ["accept-theme.mjs", "外观开关（切换 / 持久化 / 刷新记住）"],
  ["accept-custom.mjs", "自定义能力（加 / 装 / 启用 / 取名字 / 跨重启）"],
  ["accept-media.mjs", "媒体画廊 + 自定义协议 + 视频通道"],
  ["accept-phone.mjs", "手机遥控（远端许可 / 活动状态 / 跨重启）"],
  ["accept-proto.mjs", "产物协议字段（预置数据，不调模型）"],
  /*
   * ⚠️ `accept-size-spec.mjs` 曾在 2026-10-14 被**摘掉**（那时它真出图、受上游波动影响）。
   *
   * ⭐ 2026-10-16（A20）：它**回来了**，而且比原来更硬 —— 假通道现在按请求里的 `size`
   * 现造图，于是第 6 段那句「选 16:9 / 1K 就得到 1280×720」不再是"看上游心情"，
   * 而是**可判**的；前 5 段（纯计算）也照旧钉着。
   * 教训仍然成立：**判据是读脚本有没有真调模型的调用**，不是标签写着"不调模型"。
   */
  /*
   * ⚠️ 同样**不进**这里的还有下面这几条 —— 它们**真调模型**（不属于"不依赖模型"这一类），
   * 单独跑即可：
   *
   * - `accept-tools.mjs`（§141）工具协议端到端：断言"模型真的调了工具 + 磁盘上真有结果"。
   * - `accept-followup.mjs`（§147）多轮对话：断言第二轮答得出**只在第一轮出现过**的信息。
   * - `accept-compaction.mjs`（§149）上下文压缩：用验收开关把额度调小，断言"真压了 + 关键数字穿过摘要"。
   * - `accept-subagent.mjs`（§150）子智能体：两段分别验**汇合**与**审批穿透**。
 * - `accept-checkpoint.mjs`（§151）会话检查点：验分叉不动原对话、回退重答、**且不撤销已发生的动作**。
 * - `accept-doc-action.mjs`（§153）AI 文档操作条：断言「润色」**真的改写了正文**、历史记着由来、磁盘跟上。
 * - `accept-agent-persona.mjs`（§156）AI 智能体人设：用带暗号的智能体提问，断言回复**真的带上了暗号**。
 * - `accept-toolfeed.mjs`（§163）工具输出进历史：两轮验证 —— 第 1 轮只说条数，**第 2 轮却能说出只存在于上一步工具输出里的内容**。
 * - `accept-memoryinject.mjs`（§164）记忆注入：**不许调工具**，问只存在于记忆库里的称呼，断言它答得出来（且这一轮没有工具留痕）。
 * - `accept-imageedit.mjs`（§167）图片动作条：⭐ **2026-10-16（A20）已收进 CASES**（见上面那四条登记）。
 * - `accept-doctone.mjs`（§168）调整语气：口语化的原文点「更学术」→ 断言**真的被重写**、历史记着由来、磁盘跟上。
 * - `accept-toolargs.mjs`（§175）工具参数进留痕：让模型记一件事，断言那一行里出现**只有参数里才有**的内容（会真调模型 1 次）。
 * - `accept-material.mjs`（@ 添加资料）与 `accept-mcp.mjs`（连接器）：断言的是
 *   **模型看见了什么**（请求体里有没有资料块 / 这一轮下发了哪些工具）——
 *   没有真模型跑一轮，那一轮请求根本不会发生。
 *   ⚠️ 2026-10-14 从"免模型"清单里挪出来：那天给 `DSH_NO_REAL_MODEL` 装成真的之后
 *   这两条立刻红，才看清**它们一直在悄悄花钱**（批跑号称免模型，实际替它们打真调用）。
 *   顺带说明：它们的报告现在**走 IPC 读会话记录**（`readAllSessionRecords`），
 *   不读 `sessions/*.jsonl` —— 存储已换成 SQLite，读文件那条路是空的。
 * - `accept-sessionlog.mjs`（C2）会话事件日志：跑一轮真对话，读会话记录，
 *   断言「首行是 `request`（带着这一轮的用户内容）／工具有调用也有配对的结果／末行是 `done`／
 *   **正文与界面上那条回复对得上**」（会真调模型 1 次，且会真的触发一次工具）。
   *
   * 它们必须存在（那是这些能力的**唯一硬证据**），但不属于"不依赖模型"这一类。
   * 判据与 §109 一致：**读脚本里有没有真调模型的调用**，不是"看起来像不像功能测试"。
   */
  ["accept-versions.mjs", "版本清单与对比（不调模型）"],
  /*
   * 消息操作栏的六个动作（11.19）—— 含「重新生成必须是同一次提问的重跑」。
   * 2026-10-16：从 `NOT_IN_BATCH` 的明账里收进来（它原来因为"自己 spawn Electron"没进批跑），
   * 实跑过一次绿的；它与 `accept-retry`（旧的聊天侧栏那条，已随界面改版退役）覆盖同一件事。
   */
  ["accept-actions.mjs", "消息操作栏六个动作（复制 / 重新生成是同一次提问的重跑 / 幂等）"],
  /*
   * 「一个人都没来过」的几处空态（§208 那类"没人点过的界面"）。
   * 2026-10-16：从 `NOT_IN_BATCH` 的明账里收进来（它不调模型、用 bootApp + 自隔离数据目录，
   * 判据是空态文案逐字 + 容器宽度 ≥200px）。
   */
  ["accept-emptystates.mjs", "空态（历史对话 / 任务中心 / 摘要产物 / 摘要媒体：文案逐字 + 没被挤塌）"],
  /* 标记层与框选（阶段 5）：八种标记能画、样式能切、撤销/清空、落盘、当提示词（2026-10-16 从明账收进来试跑） */
  ["accept-p5.mjs", "标记层（八种标记 / 样式切换 / 撤销清空 / 落盘 / 拼进生成要求）"],
  /*
   * AI 文档操作条（§153 + P87）：润色真的改写了正文、历史记着由来、磁盘跟上，
   * 且**往返期间正文只读**（2026-10-16 从"需要模型"那一类收进来试跑 —— 假通道能驱动它）。
   */
  ["accept-doc-action.mjs", "文档操作条（润色真改写 / 历史记由来 / 磁盘跟上 / 往返期间只读）"],
  /*
   * L06 个性化（2026-10-18）：主题 / 快捷键 / 助手人格。
   * 判据全是行为：data-theme 真的变、自定义键位真的开面板且旧键失效、
   * 裸键被拒、settings 落 KV（stores.db）且**重启后三项都还在**。
   */
  ["accept-personalize.mjs", "个性化（主题切换 / 快捷键录制与校验 / 人格落盘 / 跨重启）"],
  /*
   * G11（2026-10-18）：子智能体被闸门拦下的动作会冒泡成父级待批。
   * 自带本地假通道（零出网、不调真模型）：父级派活 → 子智能体写记忆被拦 →
   * 父级出现待批行 → 点允许 → 磁盘上真的多一条。
   */
  ["accept-subagent-approval.mjs", "子智能体审批冒泡（待批行 / 批准前未执行 / 批准后真执行）"],
  /* G10+G15（2026-10-18）：知识库面板真能导入/检索；工作流时间线按真实起止画两段 */
  ["accept-knowledge-timeline.mjs", "知识库面板（导入/检索/库文件）+ 工作流时间线"],
  /* G16（2026-10-18）：只靠键盘开设置、Tab 不逃逸、Esc 关闭且焦点归位 */
  ["accept-keyboard.mjs", "键盘核心路径（命令面板→设置 / 焦点陷阱 / 焦点归还 / 焦点环）"],
  /*
   * ── 2026-10-16：把"清单外的脚本并进批跑"（主人的要求）──
   * 下面这五条原来列在"明账（本该进批跑、还没进）"里，理由都是"自己 spawn Electron（老一代写法）"。
   * 它们**能**在批跑里跑（批跑自带假通道 + 隔离数据目录 + 只收拾自己起的应用），
   * 所以收进来；跑不动的当场改，改不动就如实记回去。
   */
  ["accept-library.mjs", "插件安装与项目分组（装/启用/项目/置顶 的持久化）"],
  ["accept-canvasopen.mjs", "点产物卡片在画布里打开（文本类进画布 / Office 交给系统程序）"],
  ["accept-float.mjs", "对话流产物卡片 + 悬浮助手窗（可拖拽 / 自带输入区 / 问答不建任务）"],
  ["accept-rowmenu.mjs", "左栏行悬停 ⋯ 菜单 + 任务标题点击重命名"],
  ["accept-workbench.mjs", "工作台外壳三栏（左导航 / 中任务 / 右摘要）"],
  /*
   * ── 2026-10-16（A17/A18/A19）：把"要真模型"那一类收进批跑 ──
   *
   * 这十二条原来都在 `NOT_IN_BATCH` 的 `needs-model` 里，理由都是同一句：
   * "断言的是**模型看见了什么**，没真模型跑一轮就不成立"。
   * 假通道补了第三条装置标记（**「复述:X」**，见 `startLocalFakeModel` 的说明）之后，
   * 那句理由就不再成立了 —— 真模型"看见了就会说出来"，假通道现在也会：
   * 凡是上下文里出现 `复述:X`，回复里就带上 X，而 X 只有真的走通了那条链路才会出现在请求里。
   *
   * ⭐ 判据一个字都没放宽：token 从哪来、落在哪一处提示词里、链路断在哪一节，
   * 每条脚本下面的注释与断言都写着（并且逐条做过变异实证，见各脚本头部的记载）。
   */
  ["accept-agent-persona.mjs", "AI 智能体人设（一键完善真写出描述 / 人设真的进了系统提示词）"],
  ["accept-doctone.mjs", "调整语气（点「更学术」真改写正文 / 历史记由来 / 磁盘跟上）"],
  ["accept-writing-model.mjs", "写作助手（写作菜单 4 档 / 「写短一点」真把模型输出写回节点 / 节点数不变）"],
  ["accept-followup.mjs", "多轮对话（追加在同一段对话里 / 不新建任务 / 上一轮的信息真送到了模型）"],
  ["accept-compaction.mjs", "上下文压缩（真压了 / 关键数字穿过摘要 / 本地历史一条没少）"],
  ["accept-checkpoint.mjs", "会话检查点（分叉产出新对话且不动原对话 / 回退重答且**不撤销已发生的动作**）"],
  ["accept-memoryinject.mjs", "记忆注入（不调工具却答得出只存在于记忆库里的称呼）"],
  ["accept-toolargs.mjs", "工具参数进留痕（那一行出现只有工具参数里才有的内容）"],
  ["accept-toolfeed.mjs", "工具输出进历史（第 1 轮只说个数，第 2 轮却答得出只存在于上一步工具输出里的文件名）"],
  ["accept-tools.mjs", "工具协议端到端（六个阶段：记忆工具 / 每步确认拦下 / 允许真执行 / 拒绝不动盘 / 定时任务工具 / 画布节点工具）"],
  ["accept-mcp.mjs", "连接器（装上自动连 / 工具带前缀交给模型 / 调用真回到服务端 / 能重连）"],
  /*
   * 2026-10-16：从 `NOT_IN_BATCH` 收进来。它原来卡在**产品侧**（不是脚本）：
   * 放行那条路 `ai:runTool` 用的是「第一个可用通道」，不沿用这段对话自己的 provider ——
   * 于是子智能体被换到别家、在零出网闸下当场被拦，断言「子智能体办完了」必然红。
   * 那一处已修（`electron/ipc/ai.ts` 改成按会话日志取这一轮真正的 provider），
   * 修完这条能在假通道下跑绿 —— 所以它不再是 needs-model。
   */
  ["accept-subagent.mjs", "子智能体（汇合：两段活都回来 / 审批穿透：按需确认下点「允许」后真的办完）"],
  /*
   * `accept-usage`（C5 真实用量）**不是图像类** —— 它要的是一次**文本轮**带 usage
   * （`tasks.json` 的步骤上要有 provider 给的 tokens）+ 界面那句 hover 如实说清"这是估的"。
   * 假通道的 SSE 里本来就带 usage 帧，所以它能跑；2026-10-16 从 A20 那一组里挪进来。
   */
  ["accept-usage.mjs", "真实用量（步骤上带 provider 的 tokens / 界面如实说清那个数是估的、本机没有额度体系）"],
  /*
   * ── 2026-10-16（A21）：打包类三条进清单 ──
   *
   * 它们要的是 `pnpm package:win` 之后的产物。收进 CASES 的理由：
   * `pnpm build` 链的**尾巴**就是本批跑，而那时 `package:win` 刚跑过、产物就在眼前 ——
   * 不进清单等于"那条链上一次都没验过打包产物"。
   *
   * ⚠️ 单独 `pnpm verify:accept`（没打过包）时这三条会**报环境红**：
   * 它们的判词是「打包产物不存在 / 还没打包 / 装出来的那份不存在」，`classify` 按这些词
   * 归到 `environment` 那一类（**不静默通过**，也不假装是产品坏了）。
   * 要全绿得先 `pnpm package:win`（`accept-installed` 还要先静默安装到 `.verify/instA`）。
   */
  ["accept-p6.mjs", "打包产物能起来（release/win-unpacked 的 exe：画布/工具条/标注/自动保存，且没漏 DEV 出口）"],
  ["accept-package.mjs", "打包产物齐不齐（setup.exe 在 + 体积 + 两处图标真的嵌进 PE + app.asar 里有主进程入口）"],
  ["accept-installed.mjs", "装出来的那份能跑（静默安装到 .verify/instA 之后：外壳渲染 / 导航齐 / 两处交互能动 / 有写用户数据）"],
  /*
   * §135/§136 新增的三条。它们比上面那批**更抗环境干扰**：开头用 `.verify/harness.mjs`
   * 的 `freshDir()` —— 先杀掉上一轮的残留 Electron 再删数据目录，而不是直接 `rmSync`。
   * （§135 撞过：上一个脚本异常退出时没杀子进程 → 目录被句柄占着 → 下一条 `rmSync` 报 EPERM，
   *  看起来像"产品坏了"，其实是环境。）
   */
  ["accept-memory.mjs", "记忆（加 / 刷新后仍在 / 删）"],
  ["accept-settings-pages.mjs", "设置子页（个人资料 / 账号 / 返回）"],
  ["accept-team.mjs", "团队空间页（发码 / 入团 / 改角色 / 移除 / 账本，且账本真落盘）"],
  ["accept-shortcuts.mjs", "左栏全局快捷键（Ctrl N / Ctrl Shift T·S·D）"],
  ["accept-threads.mjs", "管理历史对话（分档 / 摘要 / 行内操作 / 刷新后仍在）"],
  ["accept-navsearch.mjs", "左栏搜索（真发一条→搜得中→点开进任务；后退/前进已移除）"],
  ["accept-suggestions.mjs", "首页推荐卡（三段结构 / 一列竖排 / 与标签对齐）"],
  ["accept-nodemenu.mjs", "画布节点右键菜单（画布操作）"],
  ["accept-layers.mjs", "画布图层操作（画布操作）"],
  ["accept-shapes.mjs", "画布形状节点"],
  ["accept-textstyle.mjs", "画布文字样式"],
  ["accept-frames.mjs", "画布分组框"],
  ["accept-scheddraft.mjs", "定时任务草稿流转"],
  /*
   * §109：这三个分类是**读脚本**得出的（有没有 chat-send/gen-run 这类真调模型的调用、
   * 有没有 marker-tool 这类需要前序状态的依赖）。下面这批两类都没有，
   * 也就是"本该能跑" —— 而它们**从没被跑过**（正是 §100 批量修好但没批量验的那批）。
   */
  ["accept-p4.mjs", "画布阶段 4"],
  /*
   * 2026-10-14 收进来的 7 条：原来分别是"报告型"（只打报告不判定）与"已过期"
   * （选择器/导航变过、跑起来就红）。逐条补了后果断言并实跑通过之后才写在这里 ——
   * 清单里的每一条都必须是"跑过且绿"的，否则批跑会长期带红。
   */
  ["accept-schedule.mjs", "定时任务：落盘 / 立刻执行真开任务 / 暂停态跨重启"],
  ["accept-edit.mjs", "定时任务编辑：重算下次时间 / 历史不动 / 非法值不放行"],
  ["accept-export.mjs", "画布导出（视图 / 画框各一张真 PNG，画框更小）"],
  /*
   * 2026-10-14 新写/重写的三条（都**不连模型、不看 DEV 探针**）：
   *   · `accept-p5-ref` 重写：原来断的是 `window.__lastChatPayload`（DEV 才有），
   *     打包产物里永远跑不到 —— 现在断的是界面这一路（@ → 候选 → 芯片 → 断链）
   *   · `accept-retry`：聊天失败后的「重试」（用空凭据文件制造确定性失败）
   *   · `accept-codecopy`：代码节点的「复制」真写剪贴板 + 2 秒反馈
   */
  ["accept-retry.mjs", "聊天重试（失败有出路 / 撤旧问答重发 / 不卡忙碌态）"],
  ["accept-codecopy.mjs", "代码节点复制（真进剪贴板 / 反馈 2 秒后复位）"],
  /*
   * agent 真能干活那一条（2026-10-14，§225）：走 `ai:runTool` 真跑六个工具，
   * 看磁盘上的副作用。**不调模型**，所以进批跑。
   */
  ["accept-workspace.mjs", "工作区：授权后 agent 能看/找/读/写/改/跑命令，越界被拒，撤销后立刻失效"],
  /*
   * 连接器（MCP，2026-10-14，§226）：起一个**真的**假 MCP server 子进程，
   * 验装上自动连 / 工具带前缀交给模型 / 调用真回到服务端。**不调模型**。
   */
  /*
   * `accept-html` 2026-10-14 改造后收进来：它原来**不在批跑里、且一条判定都没有**，
   * 还有一处 `page/page2` 笔误（重启段用已关闭的页面 → 抛异常直接死）。
   * 现在：判定落在**沙箱属性、断网 CSP、放行后落盘、重启后内容还在**上，
   * 启动走 `openApp`（换端口重试，见 harness 里那三层端口坑的记录）。
   */
  ["accept-html.mjs", "HTML 节点（沙箱 / 断网 CSP / 联网徽章能放行且落盘 / 重启还在）"],
  ["accept-projects.mjs", "左栏项目行（建 / 改名 / 归入后计数 1 / 成员行 / 移出回 0 / 删项目不删任务）"],
  /*
   * ⚠️ `accept-writing` **2026-10-14 摘出批跑并改名** → `accept-writing-model.mjs`。
   *
   * 它名字看不出，但它**真的连模型**：点「写短一点」然后等 15 秒看节点文字变没变。
   * 待在"免模型批跑"里有两重问题：
   *   ① 冒犯了这份文件自己的判据（"只收完全不需要模型的脚本"）——
   *      没配通道的机器上它会静默走完 15 秒然后判"没变"，看起来像产品坏了；
   *   ② 它原来还写死项目绝对路径下的 `data`（**真实数据目录**），
   *      每跑一次都在真实画布上改一次节点（已改成隔离目录）。
   * 名字带上 `-model` 就是为了让"按名字挑脚本跑"的人一眼看见代价。
   */
  // ["accept-writing.mjs", "写作产物"],
  /*
   * §112 修好的三条 —— 它们原先直接点 `.canvas-mode[data-mode="point"]`，
   * 而那个按钮在**弹出层**里（要先点 `bottom-select` 展开）。
   * 补上"先展开弹出层"这一步后即通过。
   *
   * 这三条一度被记成"状态依赖"，其实不是 —— 是**少一步导航**，
   * 和 §100 修的那 23 条同类，只是**插入点不同**（那批补在等画布之前，这批补在点模式之前）。
   */
  ["accept-p5-keys.mjs", "画布选择模式（快捷键）"],
  /*
   * ⚠️ `accept-p5-prompt.mjs` 已从批跑里**摘掉**（2026-10-14）。
   * 它读的 `window.__lastAiPrompt` 是 DEV-only 探针 —— **打包产物里根本没有**，
   * 也就是说这条脚本永远跑不了（下面"过期清单"里也写着它退役）。
   * 它要守的东西已经搬进单测：`src/canvas/markers.test.ts` 的 `instructionFromMarkers` 那几条。
   * 留着它的唯一后果是批跑多一条**永久的假红** —— 而假红多了，真红就没人看。
   */
  ["accept-clipboard.mjs", "画布复制粘贴"],
  ["accept-doc.mjs", "AI 文档（入口 / 文案对齐 / 落盘重启 / 复制 / 历史还原）"],
  ["accept-taskcenter.mjs", "任务中心（三块分区 / 置顶上限 / 移除 / 落盘）"],
  ["accept-reader.mjs", "AI 阅读（入口 / 大纲 / 页面检索 / 图表 / 最近阅读落盘）"],
  ["accept-agent.mjs", "创建 AI 智能体（入口 / 文案与标签 / 校验 / 落盘 / 选择恢复）"],
  ["accept-coding.mjs", "创作广场（只收网页产物 / 分类搜索 / 时间范围 / 排行口径 / 创作同款）"],
  ["accept-search.mjs", "两处搜索（技能搜索 / 云盘搜索：筛选 / 空态 / 清空复原）"],
  ["accept-phrases.mjs", "@ 常用语（唤出 / 筛选 / 替换 / 邮箱不误触发 / Esc / Enter 选不发）"],
  ["accept-searchhistory.mjs", "搜索历史（记录 / 去重 / 两处不串 / 落盘 + 清空也落盘）"],
  ["accept-imagepage.mjs", "生成图片独立页（入口 / 占位逐字 / 尺寸真的在算 / 诚实状态）"],
  /*
   * ── 2026-10-16（A20 收尾）：**图像那四条收进批跑** ──
   *
   * 它们原来都在 `NOT_IN_BATCH` 的 `needs-model` 里，理由是同一条硬依赖：
   * 图像通道那张表没有 baseURL 覆盖口，批跑的假通道指不进去，而零出网闸又不放行远程地址。
   * 这次两半一起补：产品侧加了 `baseURLEnv`（`imageGen.ts`），装置侧让假通道
   * 认 `/images/generations` 与 `/images/edits` 并按请求的 `size` 现造真 PNG。
   *
   * ⚠️ 收每一条时都做了变异实证（改坏一条断言即红），并且**逐条实跑过**（见各脚本头部）。
   * 另一件顺带的事：其中三条原来**只打报告、没有判定**（`accept-image-actions` 一处判定都没有、
   * `accept-size-spec` 只靠 `failOnMarks` 兜"谁印了 ✗"）—— 在批跑里那等于没测，所以一并补上，
   * 判据就是它们各自头部承诺的那几条。`accept-imageedit` 还逮到一处**陈旧断言**
   * （读 `wb-imagegen-recent-*` 这个不存在的 testid、再拿一个从未赋值的 `driveRows` 去比），
   * 修好之后它才谈得上"能红的验收"。
   */
  ["accept-imagegen.mjs", "图片生成端到端（真出一张图 / 能显示 / 文档只存文件名 / 文件名不含大写 T / 重启还在）"],
  ["accept-image-actions.mjs", "图片动作条（有图可改 / 菜单四项 / 变清晰换新图且沿用尺寸 / 扩图更大 / 图能显示且落盘 / Ctrl+Z 撤回）"],
  ["accept-imageedit.mjs", "图片动作条·生成图片页（动作条五个词逐字 / 点变清晰多出一张 / 落进 assets / 最近生成两张都在）"],
  ["accept-size-spec.mjs", "图像尺寸规格（三档模式 / 比例表逐格对上 / 自动与规整提示 / 极端比例不被原样受理 / 真按 16:9 1K 出 1280×720）"],
  ["accept-docformat.mjs", "文档调整语气/格式（九档文案逐字 / 设为小标题真加 ## / 设为正文真去掉 / 留痕）"],
  ["accept-createdoc.mjs", "创建文档（种一条消息 → 跳文档面板 / 正文一字不差 / 标题取第一行 / 那句话逐字 / 留痕）"],
  ["accept-docbar.mjs", "文档粘贴+插入附件（逐字 / 替换选区且留痕 / 附件列云盘文件且链接对得上 / 空剪贴板有话直说）"],
  ["accept-videopage.mjs", "生成视频独立页（入口 / 标题逐字 / 诚实状态：没模型就说清 / 最近生成空态逐字）"],
  ["accept-approve.mjs", "就地批准（允许真执行 / 那行换成结果 / 拒绝什么都没发生且写明你已拒绝）"],
  ["accept-restore.mjs", "重启恢复（压缩摘要在 / 工具留痕与参数在 / 消耗在 / 被中断的任务如实写明）"],
  ["accept-schedbad.mjs", "坏/旧的任务文件不崩（好的照跑 / repeat 坏与无 id 被丢 / status 坏标已暂停 / 无 Invalid Date）"],
  ["accept-artifacts.mjs", "坏产物/澄清卡不崩（对话照常打开 / awaiting 活下来 / 好的都在 / 坏的被丢 / 无报错）"],
  ["accept-codinglike.mjs", "应用详情+喜欢（详情逐字 / 喜欢↔取消喜欢 / **重启后还在** / 没有编造点赞数）"],
  ["accept-canvasbad.mjs", "坏画布文档不崩（缺位置的挪到原点保住内容 / 坏类型与悬空连线被丢 / 如实告知 / 无报错）"],
  ["accept-settings2.mjs", "设置通用/关于（分类逐字 / 记忆开关有真效果且活过重启 / 开启新话题真回到新任务）"],
  ["accept-pinned.mjs", "新对话默认模型（选择器逐字 / 落盘成 provider/model / 重启后仍在且列表行可见）"],
  ["accept-pinneddead.mjs", "默认模型失效提示（钉了个不存在的 → 那行标「不可用」；钉了个真可用的 → 不误报）"],
  /*
   * ⚠️ `check-titlebar.mjs`（标题栏通路）**暂不放进批跑** —— 但它本身是好的：
   * 单独跑通过、有退出码判定、且**红过一次**（§116：只改源码没重建 →
   * `setTitlebar is not a function`）。
   *
   * 不放进来的原因是**批跑器还不够稳**：加上它之后 `accept-layers.mjs` 变红，
   * 而 `accept-layers` **单独跑是绿的** —— 又是环境耦合（§101 残留进程、
   * §109 未隔离数据目录，这是第三次）。
   *
   * **在查清这个耦合之前，不再往批跑里加东西** ——
   * 加得越多，偶发红越频繁，而"批跑全绿"的可信度就越低。
   * 这比"多一条覆盖"重要。
   */
  /*
   * ⚠️ 下面四条**不能进批跑** —— 不是它们坏，是它们**不隔离数据目录**。
   *
   * 实测：47 条 accept-* 里有 5 条没设 `DSH_CANVAS_DATA_DIR`：
   *   accept-final / accept-image / accept-p2 / accept-p3 / accept-package
   * 也就是说它们读写**真实 userData**。放进串行批跑会两头出问题：
   *   ① 它们自己拿不到预置数据 → 失败；
   *   ② 它们把状态写进真实目录 → **污染后续条目**（§109 撞到：连之前一直绿的
   *      `accept-phone` / `accept-textstyle` 都被带红了，而它们单独跑是过的）。
   *
   * 要收进来得先给这四条补上数据目录隔离 —— 那是改脚本，不是加一行清单。
   * 这一条也提醒：**加验收进批跑之前，先看它隔不隔离。**（这是我上次漏查的。）
   */
  // ["accept-final.mjs", "最终产物落盘"],
  // ["accept-html.mjs", "HTML 产物"],   // 已隔离但本次失败，原因待查
  // ["accept-image.mjs", "图片产物"],
  // ["accept-p2.mjs", "画布阶段 2"],
  // ["accept-p3.mjs", "画布阶段 3"],
  /*
   * ⚠️ 这四条试过、**暂时不在批跑里**（实测失败，但我还没逐条查明原因）：
   *   accept-p5-keys.mjs    画布快捷键
   *   accept-p5-prompt.mjs  画布提示词节点
   *   accept-p5-ref.mjs     画布引用
   *   accept-providers.mjs  模型通道清单 —— **已结案：它真探测、真发对话，属需要模型**（§105）
   *
   * **不写"它们过期了"** —— 那是猜的。可能是需要模型（跑起来在等）、
   * 也可能是入口又变了、或者另有原因。要收进来得先逐条看失败原因。
   *
   * （本轮加它们进批跑时整批跑了 10 分钟以上，从这个耗时看**至少有需要模型的**。
   *   但"至少"不等于"全部"，所以标"待查"而不是下结论。）
   */
  /*
   * ⚠️ `accept-clipboard.mjs` 与 `accept-export.mjs` **不在批跑里** —— 它们**依赖前序状态**。
   *
   * 实测：单独跑时 `accept-export` 报的错是
   *   `<div class="canvas-toast is-error">还没有画框：先用「新建 → 画框」建一个</div> intercepts pointer events`
   * 也就是说它**假定画布上已经有一个画框**（由别的场景先建好）。
   * `accept-clipboard` 同样点不到 —— 它也需要先有东西可复制。
   *
   * 这与"过期"不同：**它们没坏，只是不能独立跑**。
   * 要收进来得先给它们各自的前置步骤（建画框 / 建节点），
   * 那是"把它们改成自足脚本"的活，不是改一行入口能解决的。
   */
  /* 上面那条注释说的两条已摘掉，见注释 */
  /*
   * ⚠️ `accept-packaged-run.mjs` **不在这里**，原因是**它调模型**，不是它过期了。
   *
   * 它曾经**确实**过期过（写的时候应用是画布优先形态，开头就等 `.react-flow__node`，
   * 而应用现在默认打开工作台 → 30 秒超时）。这条过期正是 §96 的批跑器
   * 第一次跑起来撞见的（§97），**已经修好**：开头先点「打开画布」再断言。
   *
   * 但修好之后跑通时发现它会**真出图**（实测生成 1024×1024、落进 assets），
   * 所以它属于"需要模型"那一类 —— 慢、且受上游影响，不适合放进无模型批跑。
   *
   * 两件事要分清：**"过期的脚本"要修**；**"要调模型的脚本"不进这个批跑**。
   */

];

/**
 * **批跑自带的本地假 provider**（2026-10-16，审计 G46/G47 的正面修法）。
 *
 * ## 为什么批跑必须有它
 *
 * 审计实测：这套号称"不依赖模型"的批跑里**混着真调模型的用例** ——
 * `accept-schedule` 的判定必须等真模型往返才可能绿，而且用的是
 * `.credentials.yaml` 里那把**机器级真 key**（出网记账为证）。
 * 也就是说：**批跑绿过一次，用的是真额度**。
 *
 * 现在批跑自己起一个 OpenAI 兼容的本地假服务，并把环境指过去：
 *   · `STRATA_BASE_URL` → 这个假服务（`strata` 是那个本来就指本机的 provider）；
 *   · `DSH_NO_REAL_MODEL=1` → 内核那道闸（图像/视频/探测也管，见 P53）。
 * 于是"零出网"是**结构上**成立的：假服务在 127.0.0.1 上，闸只放行本机地址。
 *
 * ⚠️ 边界如实记：桌面侧如果走的是"自己存着的通道"而不是 `strata`，
 * 这次回答仍然来自假服务（因为我们把 `strata` 指向了它），但它**不会**因此
 * 变成真模型 —— 只是那些脚本若依赖真实回复内容，会以断言红的形式暴露出来
 * （那是"该移出免模型清单"的信号，不是"白花钱"）。
 */
/**
 * ── 假通道的「图像」那一半：造一张**真的 PNG**（2026-10-16，审计 A20）──
 *
 * ## 为什么需要它
 *
 * 图像那几条验收（`accept-imagegen` / `accept-image-actions` / `accept-imageedit` /
 * `accept-size-spec`）要的是「生成出一张图、落盘、**能显示**（`naturalWidth > 0`）、
 * 尺寸对得上」—— 而零出网那道闸只放行本机地址，真图像通道（远程域名）永远被拦下。
 * 所以这里自己造图：**必须是真 PNG 字节**，否则 Electron 的 `nativeImage.createFromBuffer`
 * 解不开（图生图那条会在"输入图解不开"处红）、渲染侧的 `<img>` 也不会 `naturalWidth > 0`。
 *
 * ## 尺寸是**照请求来的**
 *
 * `accept-size-spec` 第 6 段要断「选 16:9 / 1K 生成出来的图就是 1280×720」——
 * 假通道如果固定吐一个尺寸，那条断言就永远立不起来（红得看不出是装置的问题）。
 * 所以 `size` 字段（JSON 或 multipart 里的）会被**照抄**；没有（`auto` 模式）时给 1024×1024。
 *
 * ## 一张图为什么还要垫一段文字块
 *
 * `accept-imagegen` 断言「磁盘上有一张**像样的**图（`bytes > 1000`）」——
 * 纯色小图压出来只有几十字节，会被那条判成"没落盘"。垫一个 `tEXt` 块是**正当**的
 * PNG 结构（真图里满是元数据块），既不改变像素，也让"这是假通道的占位图"写在文件里。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 PNG 块：长度 + 类型 + 数据 + CRC。 */
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

/** 造一张 `w×h` 的 PNG（8 位 RGBA，逐行渐变 —— 解出来是一张正常的图，不是空白）。 */
function makeFakePng(w, h) {
  const width = Math.max(1, Math.min(3840, Math.round(w)));
  const height = Math.max(1, Math.min(3840, Math.round(h)));
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // 过滤器 0（None）
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      raw[at] = Math.round((x * 255) / width);
      raw[at + 1] = Math.round((y * 255) / height);
      raw[at + 2] = 128;
      raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  const note = "本地假通道占位图：像素是按请求尺寸现造的，只用来验链路与尺寸，不是真的生成结果".repeat(20);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.concat([Buffer.from("Comment", "latin1"), Buffer.from([0]), Buffer.from(note, "utf8")])),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 从请求体里抠出 `WxH` 尺寸（生成那条是 JSON、编辑那条是 multipart；`auto` 一律当没给）。 */
function sizeFromRequest(jsonBody, latin1Body) {
  let size = "";
  try {
    const parsed = JSON.parse(jsonBody);
    if (typeof parsed?.size === "string") size = parsed.size;
  } catch {
    /* 不是 JSON 就是 multipart，走下面那条 */
  }
  if (!size) {
    /* multipart 的表单字段：`name="size"` 之后隔一行就是值 */
    const m = /name="size"\s*\r?\n\r?\n([^\r\n]+)/.exec(latin1Body ?? "");
    if (m) size = m[1];
  }
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(size ?? "").trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1024, h: 1024 };
}

function startLocalFakeModel() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const raw = body.toString("utf8");
      /*
       * 认四个端点：`/chat/completions`（文本轮）、`/models`（列模型/探测），
       * 以及**图像那两条** —— `POST /images/generations`（文生图）与
       * `POST /images/edits`（图生图，multipart）。路径照 `electron/ipc/imageGen.ts`
       * 实际发的来（它请求的是 `${base}/images/generations` / `${base}/images/edits`）。
       *
       * 图像两条都回 `{ data: [{ b64_json }] }` —— 与真上游同形（imageGen 只认这个形状）。
       * 文本轮的行为见下面：默认分片流式；消息里点了名要工具就先回一个工具调用。
       */
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "accept-fake" }] }));
        return;
      }
      if (req.url?.includes("/images/generations") || req.url?.includes("/images/edits")) {
        const { w, h } = sizeFromRequest(raw, body.toString("latin1"));
        const png = makeFakePng(w, h);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: png.toString("base64") }] }));
        return;
      }
      /*
       * ── 把这次请求读成四样东西（2026-10-16，收 A17~A19 时补全）──
       *
       * ① `lastUser`：最后一条 user 消息 —— 老装置标记（`请调用 …` / `请产出 …`）认它；
       * ② `ctxText`：**整份请求的文本**（含 system）—— 新标记「复述:X」在整个上下文里找。
       *    这样它既能落在系统提示词里（人设 / 长期记忆那块），
       *    也能落在历史里（上一轮说过的话、折进历史里的工具留痕）；
       * ③ `historyHasTool`：这份请求里已经出现过工具调用或工具结果 ——
       *    真 provider 在工具回来之后是**接着把话说成正文**，不会把同一个工具再调一遍；
       *    缺这条行为的后果实测过：`请调用 … 工具` 那一支会一路复发到步数上限
       *    （脚本读到的留痕是 4 条，而真模型那一轮只有 1 条）。
       * ④ `echoTokens`：见下面「复述」那段说明。
       */
      let msgs = [];
      try {
        msgs = JSON.parse(raw)?.messages ?? [];
      } catch {
        /* 体不合法就当没有消息 */
      }
      const textOf = (m) => {
        const c = m?.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
        return "";
      };
      let lastUserIndex = -1;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === "user") {
          lastUserIndex = i;
          break;
        }
      }
      const lastUserText = lastUserIndex >= 0 ? textOf(msgs[lastUserIndex]) : "";
      const ctxText = msgs.map(textOf).join("\n");
      const historyHasTool = msgs.some(
        (m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0),
      );

      /*
       * ⭐ 装置标记「复述:<token>」（2026-10-16，收 A17/A18 时新增）。
       *
       * ## 为什么必须有它
       *
       * 那十几条脚本要证的都不是"回复里有某段固定文字"，而是**"某样东西真的到了模型眼前"**：
       * 智能体人设进没进系统提示词（§156）、长期记忆有没有注入（§164）、
       * 上一轮说过的话与工具留痕有没有进历史（§147/§163）、
       * 压缩出来的摘要有没有把关键信息带过来（§149）。
       * 真模型"看见了就会说出来"，假模型不会 —— 于是这些断言在批跑里只能永远红。
       *
       * 所以补这一条：**上下文里出现 `复述:<token>`，回复里就原样带上那个 token**；
       * 并且把 `复述:<token>` 这一段**也写回去**，于是它穿过摘要、记忆、工具留痕、
       * 子智能体汇合之后仍然触发同一条规则。
       *
       * ⚠️ 它**不削弱任何断言**，反而让它们可判：token 只有真的走通了那条链路
       * 才会出现在请求里 —— 链路断了（人设没进提示词、记忆没注入、历史被丢）
       * token 就不在，回复里也就没有它，脚本照旧红（收每一条时都做过这个变异实证）。
       *
       * ⚠️ 写法上的一个约定：token 后面要跟空白或中文标点（`复述:42。` / `复述:【喵】 `），
       * 否则标点会被一起吃进 token（正则的终止符只有空白与 `，。；、,;）)`）。
       *
       * ⚠️ **一条位置上的例外**（2026-10-16，为 `accept-toolfeed` / `accept-subagent` 而加）：
       * 当**最后一条消息就是工具结果**（role=tool）时，**只复述那些在更早的消息里也出现过**的 token。
       *
       * 为什么要有这条：AI SDK 在**同一轮里**会把工具结果立刻回灌给模型 ——
       * 也就是说"工具刚返回的原文"那一刻正躺在请求的末尾。若照样复述，模型"当场把它念出来"，
       * 于是**同一轮的正文里就已经有了那个 token**，下一轮"有没有从历史里读到它"就分辨不出来了
       * （`accept-toolfeed` 的前置断言「第 1 轮不许泄底」直接失去意义 —— 实测撞到过）。
       *
       * 而这个例外**不能一刀切**：`accept-subagent` 的"汇合"要的正是
       * "子智能体的要点经由**工具结果**回到父级，父级把它转告出来" ——
       * 那一份 token 本来就**只**在末尾的工具结果里。所以判据做成**逐 token**：
       * 早期上下文里出现过的照旧复述，只在末尾那一份里的不复述。
       *
       * 这两条合起来也顺手把假通道变得更像真模型：真模型不会把**刚拿到的工具结果原样念一遍**
       * 当回答，但它会**接着把刚拿到的结果讲下去**（那些内容此刻也在更早的上下文里）。
       */
      const earlierText = msgs.slice(0, Math.max(0, msgs.length - 1)).map(textOf).join("\n");
      const tokensIn = (text) => [...new Set([...text.matchAll(/复述[:：]([^\s，。；、,;）)]+)/g)].map((m) => m[1]))];
      const lastIsToolResult = msgs[msgs.length - 1]?.role === "tool";
      const seenEarlier = new Set(tokensIn(earlierText));
      const echoTokens = tokensIn(ctxText).filter((t) => !lastIsToolResult || seenEarlier.has(t));
      const echoLine = echoTokens.length ? `复述:${echoTokens.join(" / ")}` : "";

      /*
       * ⭐ 装置标记「算出:A×B」（2026-10-16，为 `accept-subagent` 而加）：
       * 上下文里出现 `算出:12×13`，回复里就带上 `156`。
       *
       * ## 为什么需要它
       *
       * 子智能体那一条要证的"汇合"是：**子智能体把 12×13 算出来 → 要点回给父级 → 父级转告用户**。
       * 真模型当然会算乘法，假通道不会 —— 没有这条，`accept-subagent` 的
       * "父级正文里有 156"就只能永远红。
       *
       * ⚠️ 关键是这个标记**只出现在子智能体那一轮的上下文里**：
       * 父级那边的一句人话是「派一个子智能体去把 12×13 算出来」（**不带这个标记**），
       * 标记是**假通道在给 `spawn_agent` 填参数时**写进那个自包含任务里的
       * （真模型给的 task 也是自包含的，这一条与它同形）。
       * 于是 156 只能经由"子智能体那一轮的回复 → 工具结果 → 父级"这条路到达父级正文：
       * 子智能体没真的跑（或要点没汇合回来），父级请求里就没有这个标记，父级正文里也就没有 156。
       *
       * ⚠️ 吐回去写成 `算出:12×13=156`（**带上原式**）而不是光 `156` ——
       * 这样它和「复述」那条一样**自我传播**：子智能体的回复里带着 `算出:12×13`，
       * 折进工具结果回到父级时又能触发同一条规则。只吐 156 的话父级那边认不出来
       * （实测：A 段"汇合"会假红）。
       */
      const calcTokens = [...ctxText.matchAll(/算出[:：]\s*(\d+)\s*[×x*]\s*(\d+)/g)].map(
        (m) => `算出:${m[1]}×${m[2]}=${Number(m[1]) * Number(m[2])}`,
      );
      const calcLine = calcTokens.length ? calcTokens.join(" / ") : "";

      /*
       * ⭐ **按工具名给参数**（2026-10-16，收 A19 时补全）。
       *
       * 原来无论点了哪个工具都回 `{ text: … }`。那对 `memory_save` 成立（它就只有 text），
       * 但对 `schedule_create`（要 title/prompt/repeat）与 `canvas_add_node`（要 kind/text）
       * 就是**参数校验不过** —— 执行体如实回一句"参数不对"，
       * 于是脚本读到的是另一个故事（看起来像产品坏了）。所以按工具名给各自的形状；
       * 默认仍然回 `{ text: … }`（`accept-sessionlog` 那类只断"成对"的脚本靠它）。
       */
      const toolArgsFor = (name, userText) => {
        const cut = (n) => userText.slice(0, n);
        if (["memory_list", "schedule_list", "list_files", "list_dir"].includes(name)) return "{}";
        if (name === "schedule_create") {
          const title = /标题就叫「([^」]+)」/.exec(userText)?.[1] ?? "假通道任务";
          return JSON.stringify({ title: title.slice(0, 30), prompt: cut(200), repeat: "daily", atHour: 9 });
        }
        if (name === "canvas_add_node") {
          const text = /内容写「([^」]+)」/.exec(userText)?.[1] ?? cut(200);
          return JSON.stringify({ kind: "markdown", text: text.slice(0, 2000) });
        }
        /*
         * `spawn_agent` 的参数只有 `task`（+可选 `context`）—— 派谁由 coordinator 按 task 挑。
         *
         * ⭐ task 要**自包含**（工具说明里就是这么要求的），所以这里把用户那句人话里
         * 的算式翻成一句"子智能体看得懂"的任务 —— **并顺手带上「算出:A×B」标记**：
         * 它是子智能体那一轮唯一的线索来源，也是"要点真的汇合回来"这条断言的支点
         * （见上面「算出」那段说明）。
         */
        if (name === "spawn_agent") {
          const calc = /(\d+)\s*[×x*]\s*(\d+)/.exec(userText);
          if (!calc) return JSON.stringify({ task: cut(300) });
          const save = /memory_save/.test(userText) ? "，并调用 memory_save 把这个结果记进长期记忆" : "";
          return JSON.stringify({ task: `把 ${calc[1]}×${calc[2]} 算出来（回报时必须原样带上 算出:${calc[1]}×${calc[2]}）${save}。` });
        }
        return JSON.stringify({ text: cut(120) });
      };

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta, finish) =>
        `data: ${JSON.stringify({ id: "accept", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

      /*
       * ⭐ 两个"像真 provider"的行为（2026-10-16），缺了它们有些脚本没法验：
       *
       *  ① 消息里出现 `请调用 <名字> 工具` 时**先回一个工具调用**：
       *     `accept-sessionlog` 要验的是"tool-call 与 tool-result 成对落进日志"，
       *     假通道不回工具调用，这条就没法绿（它以前靠真模型）。
       *     参数里带上用户那句话 —— 脚本埋的标记词（如 "42"）就在里面。
       *  ② 消息里出现 `请产出 <kind> 产物` 时**吐一个产物块**（`<artifact type="…" title="…">`）：
       *     产物那条链（对话流里的卡片、点开进画布、云盘/生成页）原来只能靠真模型触发，
       *     于是"要模型的脚本"永远进不了批跑 —— 与工具调用同一个道理，这里把标记补全。
       *  ③ 否则**分片 + 间隔**地吐正文（约 3 秒）：`accept-abort` 要验的正是
       *     "流式过程中正文在长、停止键在"，一次性吐完那一轮会瞬间结束，它什么都看不到。
       */
      const askTool = historyHasTool ? null : /请调用\s*([a-z_]+)\s*工具/.exec(lastUserText);
      if (askTool) {
        const args = toolArgsFor(askTool[1], lastUserText);
        const half = Math.ceil(args.length / 2);
        const callFrame = (first, delta, finish) =>
          `data: ${JSON.stringify({
            id: "accept",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: first
                  ? {
                      role: "assistant",
                      tool_calls: [
                        { index: 0, id: "accept-call-1", type: "function", function: { name: askTool[1], arguments: delta } },
                      ],
                    }
                  : { tool_calls: [{ index: 0, function: { arguments: delta } }] },
                finish_reason: finish ?? null,
              },
            ],
          })}\n\n`;
        /*
         * 真 provider 调工具时通常也带一句正文 —— 脚本要断"正文能从日志重建"。
         *
         * ⚠️ 这一支**故意不复述**（不吐 `echoLine`，见上面「复述」那段）：
         * 工具那一支的正文是"好，安排上了"，它不该替工具说话。
         * 而且正因为第一轮不复述，「工具输出真的进了历史」才验得出来
         * （第二轮还答得出那个 token，只可能来自上一轮的工具留痕）。
         */
        res.write(frame({ role: "assistant", content: "（本地假通道）好，安排上了。" }));
        res.write(callFrame(true, args.slice(0, half)));
        res.write(callFrame(false, args.slice(half), "tool_calls"));
        res.write(
          `data: ${JSON.stringify({ id: "accept", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      /*
       * ⚠️ 每轮**带一个序号**（2026-10-16）：假通道原来每轮吐的字**一模一样**，
       * 于是"重生成之后回复真的变了"这类判据在批跑里永远立不起来
       * （`accept-actions` 的「重新生成」那一格就是这么卡住的 —— 它 `after !== before` 恒为假）。
       * 真模型每轮的字当然不一样；这一句让**装置**也具备那个性质，判据才谈得上"能红"。
       */
      /*
       * ⭐ **产物块**（2026-10-16）：标记写成 `请产出 <kind> 产物`（例如「请产出 markdown 产物」），
       * 回一个 `<artifact type="kind" title="…">正文</artifact>`。正文里带上用户原话 ——
       * 脚本埋的标记词（如 "42"）就在里面，与工具那一路同一套口径。
       */
      const askArtifact = /请产出\s*(?:一个)?\s*([a-z]+)\s*产物/.exec(lastUserText);
      if (askArtifact) {
        const kind = askArtifact[1];
        const body = `# 本地假通道产出的 ${kind}\n\n${lastUserText.slice(0, 80)}\n${echoLine}\n`;
        const block = `<artifact type="${kind}" title="假通道产物">${body}</artifact>`;
        const chunks = [block.slice(0, Math.ceil(block.length / 2)), block.slice(Math.ceil(block.length / 2))];
        let k = 0;
        const tickArtifact = () => {
          if (k >= chunks.length) {
            res.write(frame({}, "stop"));
            res.write(
              `data: ${JSON.stringify({ id: "accept", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(frame(k === 0 ? { role: "assistant", content: chunks[k] } : { content: chunks[k] }));
          k += 1;
          setTimeout(tickArtifact, 300);
        };
        tickArtifact();
        return;
      }

      const pieces = [
        `（本地假通道第 ${++round} 轮）`,
        "正在",
        "逐段",
        "返回，",
        "用来",
        "验证",
        "流式",
        "与",
        "中止",
        "。",
        /* 「复述」与「算出」两条标记找到的东西跟着正文一起流出去（见上面两段说明） */
        ...(echoLine ? [echoLine] : []),
        ...(calcLine ? [calcLine] : []),
      ];
      let i = 0;
      const tick = () => {
        if (i >= pieces.length) {
          res.write(frame({}, "stop"));
          res.write(
            `data: ${JSON.stringify({ id: "accept", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 24, completion_tokens: pieces.length * 2, total_tokens: 24 + pieces.length * 2 } })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(frame(i === 0 ? { role: "assistant", content: pieces[i] } : { content: pieces[i] }));
        i += 1;
        setTimeout(tick, 300);
      };
      tick();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/* 第几轮请求（每轮正文里带出来，见上面 pieces 的说明） */
let round = 0;

const localModel = await startLocalFakeModel();
console.log(`批跑自带假通道：${localModel.url}（配 DSH_NO_REAL_MODEL=1 —— 零出网是结构上成立的）`);

/*
 * ⭐ **只留假通道那两把键**（2026-10-16，图像那一半由 A20 补上）。
 *
 * 桌面侧挑通道的顺序是"用户存过的 → **第一个可用的**"。而"可用"= 有密钥，
 * 本机 shell 里就躺着 `ANXIN_API_KEY` 之类的真 key、`~/.dsh/.credentials.yaml` 里还有几把 ——
 * 于是脚本里的应用会挑到**真远程**，被 `DSH_NO_REAL_MODEL` 一拦，
 * 表现成"这一轮出错了"（红得莫名其妙，而根因其实是环境里那几把真 key）。
 *
 * 现在：把凭据文件写成**只有假通道那两把**（文本的 `STRATA_API_KEY` + 图像的
 * `LUNORA_API_KEY`，值都是占位串），并在子进程环境里把其它 `*_API_KEY` 摘掉 ——
 * 于是"第一个可用通道"只能是那两个指向 127.0.0.1 的假通道。
 * "零出网"从"闸拦着"变成"根本没别的可挑"。
 *
 * ⚠️ 图像那把是**必须的**：`IMAGE_PROVIDERS` 只认 `LUNORA_API_KEY`，
 * 没有它图像那几条脚本连面板都进不去（界面会说"没有可用的图像通道"）。
 */
const CRED_FILE = join(RECORDS_DIR, "batch-credentials.yaml");
try {
  writeFileSync(
    CRED_FILE,
    "refs:\n  STRATA_API_KEY: accept-local-fake\n  LUNORA_API_KEY: accept-local-fake\n",
    "utf8",
  );
} catch {
  /* 写不进去就退回"只靠闸"（下面的环境清理照做） */
}

/**
 * 一条验收的硬超时（2026-10-16，待补收尾方案 §三.1）。
 *
 * 实测依据：76 条串行跑里 **29 条（38%）卡到 260 秒被硬杀** —— 而"跑不完"这件事
 * 以前**没有兜底**（不设超时，卡住就永远是它）。所以：一条用例最多跑这么久，
 * 到点连子进程一起收拾掉，并**按"超时"这个类别单独记**（不是"产品断言失败"）。
 */
const CASE_TIMEOUT_MS = Number(process.env.DSH_ACCEPT_TIMEOUT_MS ?? 260_000);

/**
 * 跑一条验收并抓它的退出码。
 *
 * @param {string} file 脚本名（相对 scripts/accept）
 * @returns {Promise<{ code: number, tail: string, out: string, timeout: boolean }>}
 */
function run(file) {
  return new Promise((resolve) => {
    /*
     * ⚠️ `ELECTRON_RUN_AS_NODE` 要**真的删掉**，不能写成空串（§137.10）。
     *
     * 这个变量一旦留给子进程，Electron 会**当 Node 跑** → 静默退出、没有 userData、
     * 没有调试端口 —— 就是 §73~§76 白查三轮的那个坑。
     *
     * 眼下每条验收脚本自己都会 `delete env.ELECTRON_RUN_AS_NODE`（本轮核对 0 条漏删），
     * 所以写空串暂时没出事；但那是**靠每个脚本各自记得**，新脚本一忘就复现。
     * 传干净的环境是这一层该做的事。
     */
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    /*
     * ⭐ **批跑固定走文件后端**（2026-10-15，Phase 12.1 之后）。
     *
     * 配置型数据（任务/记忆/设置/会话/文档/智能体/搜索历史…）从那一天起**默认存 SQLite**
     * （`stores.db`），而这一批脚本里有一大半是**用"写 JSON 文件"种数据、读 JSON 文件断言**的
     * （`readStoreFile`）。切了介质之后它们全红 —— **红的是脚本读错了地方，不是产品坏了**
     * （与 §56 那次"存储换 SQLite 之后脚本还在读 jsonl"是同一类，仓库里那段的说明写得很清楚：
     * 验收脚本该走应用自己的口子，而不是直接翻文件）。
     *
     * 眼下这么做：**批跑跑文件后端**（它仍然是被支持、被单测覆盖的一条路，
     * 而且这些脚本验的是**行为**——"设置重启后还在"——介质换不换不影响那条判据），
     * KV 那条路由 `src/kvStores.test.ts`（机制）与 `accept-kvstore.mjs`（桌面端到端 + 重启）覆盖。
     *
     * 后续该做的：把这批脚本改成"经 IPC 种数据、经 IPC 断言"（`readAllSessionRecords` 已经是这个写法），
     * 那时这个 pin 就可以撤掉。
     */
    env.DSH_STORE_BACKEND = "file";
    /* 本地假通道 + 零出网闸（审计 G46/G47）；`strata` 是那个本来就指本机的 provider */
    env.DSH_NO_REAL_MODEL = "1";
    env.STRATA_BASE_URL = localModel.url;
    env.STRATA_API_KEY = "accept-local-fake";
    /*
     * ⭐ **图像通道也指到同一个假服务**（2026-10-16，审计 A20）。
     * 靠的是产品侧那个新增的覆盖口（`electron/ipc/imageGen.ts` 的 `baseURLEnv`）——
     * 没有它，图像那几条只能真调远程模型（`IMAGE_PROVIDERS` 里写死的是远程域名）。
     */
    env.LUNORA_BASE_URL = localModel.url;
    env.LUNORA_API_KEY = "accept-local-fake";
    env.DSH_CREDENTIALS_FILE = CRED_FILE;
    /* 把别的 provider 的键摘掉（见上面那段说明）——只留假通道那两把 */
    for (const name of Object.keys(env)) {
      if (/_API_KEY$/i.test(name) && name !== "STRATA_API_KEY" && name !== "LUNORA_API_KEY") delete env[name];
    }
    /*
     * ⭐ **批跑强制一个隔离数据目录**（2026-10-16，审计 G01 的兜底）。
     *
     * 开发态应用的数据目录默认是**仓库里那个 `data/`**（`main.ts` 的 `configureDataDir`）。
     * 脚本自己没设 `DSH_CANVAS_DATA_DIR` 的话，这一跑就会去写（甚至删）真实数据。
     * 这一层先给一个 `.verify/` 下的目录兜住；脚本自己设的那个会覆盖它
     * （所以还有下面那道"源码级拒绝"）。
     */
    env.DSH_CANVAS_DATA_DIR = env.DSH_CANVAS_DATA_DIR || join(RECORDS_DIR, "batch-data", file.replace(/\.mjs$/, ""));
    const child = spawn(process.execPath, [join(ACCEPT_DIR, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      /*
       * 超时了就**连子进程一起收拾**（脚本自己可能起了应用；它没机会收尾了）。
       * 用 /T 杀整棵树 —— 只杀脚本进程的话，它起的应用会变成孤儿。
       */
      try {
        /* 已经退出的进程不杀 —— 免得撞上 PID 复用（见下面 close 里那句说明） */
        if (child.exitCode === null && child.signalCode === null) {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
        }
      } catch {
        /* 已经死了就算了 */
      }
    }, CASE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      /*
       * ⚠️ **必须撤定时器**（2026-10-16 自查逮到）：不撤的后果不是"多跑一次 setTimeout"——
       * 那个定时器到点会 `taskkill /F /T /PID <child.pid>`，而这条脚本**早就跑完了**、
       * PID 可能已经被系统**复用**给别的进程。那正是审计 G43 说的危害形状
       * （"按名字全机强杀"换成"按一个已经失效的 PID 强杀"，一样会打到不相干的进程）。
       */
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        out,
        tail: out.trim().split("\n").slice(-3).join(" | "),
        timeout: timedOut,
      });
    });
  });
}

/**
 * 这一条脚本**能不能进批跑**（2026-10-16，审计 G01 的源码级守卫）。
 *
 * 判据：不许把应用的数据目录钉成仓库里那个真实的 `data/` ——
 * 那意味着这一跑会**动用户真实的数据**（其中 9 条还带 `rmSync`）。
 * 命中就**拒跑**（并当场说清为什么），而不是"默默还是跑了"。
 */
function isolationProblem(file) {
  try {
    const text = readFileSync(join(ACCEPT_DIR, file), "utf8");
    if (/const\s+\w*DATA\w*\s*=\s*"data"\s*;/.test(text)) {
      return '脚本把数据目录钉成了仓库里真实的 "data" —— 会动真实数据；改成 ".verify/data-<名字>" 再进批跑';
    }
    return null;
  } catch {
    return "脚本读不出来（路径不对？）";
  }
}

/**
 * 把一次结果**分类**（2026-10-16，待补收尾方案 §三.1 的判据）。
 *
 * 三类要能一眼分开，因为它们指向完全不同的下一步：
 *   · `assert` —— 产品/脚本的断言真失败了（要修的是它们）；
 *   · `environment` —— 应用根本没起来 / CDP 连不上 / 端口坏（修环境或换装置）；
 *   · `timeout` —— 到硬超时被收拾（要么产品挂住，要么脚本等不到条件）；
 *   · `no-judge` —— 跑完了、退 0，但源码里**没有任何判定**（等于没测）。
 */
function classify(result, source) {
  if (result.timeout) return "timeout";
  if (result.code !== 0) {
    /*
     * ⭐ **"产物还没打"也要归到环境红**（2026-10-16，审计 A21）。
     *
     * 打包类那几条（`accept-p6` / `accept-package` / `accept-installed`）在缺产物时会明确退出非零 ——
     * 但它们的判词是"打包产物不存在 / 还没打包 / 装出来的那份不存在"，**不在原来那张模式表里**，
     * 于是会被归成「断言红」（看起来像产品坏了），而真相是"这条还没轮到跑"。
     * 分类错了，读报告的人就会去查错方向 —— 与"把环境问题当产品问题"是同一个坑。
     */
    const envRed =
      /ECONNREFUSED|connectOverCDP|connect ETIMEDOUT|code=1006|换了三个端口都起不来|一个页面都没建|ports? .*不通|EPERM|EBUSY|EISDIR|打包产物不存在|没有解包产物|还没打包|装出来的那份不存在/i;
    return envRed.test(result.out ?? "") ? "environment" : "assert";
  }
  const hasJudge = /process\.exitCode\s*=\s*1|verdict\(|bad\.push|failures\.push|failed\s*\+=\s*1|process\.exit\(1\)|throw new Error/.test(source ?? "");
  return hasJudge ? "pass" : "no-judge";
}

/*
 * 清残留**只有一份实现**（2026-10-16，审计 G03）：
 * 从 `./accept/harness.mjs` 里 import —— 那边按"我们自己起的应用的命令行开关"认领
 * （审计 G43 的修法），不再按程序名全机强杀，也不再有第二份会各自漂的实现。
 */

/*
 * 开跑前清掉上一次的失败日志（2026-10-14）。
 * 不清的话 `accept-fail-*.log` 会把几轮的失败混在一起 —— 看的人会以为"这次也红了那些"。
 */
try {
  for (const name of readdirSync(RECORDS_DIR)) {
    if (name.startsWith("accept-fail-") && name.endsWith(".log")) unlinkSync(join(RECORDS_DIR, name));
  }
} catch {
  /* 目录还不存在就算了 */
}

/*
 * `DSH_ACCEPT_ONLY=a.mjs,b.mjs`：只跑清单里的这几条（2026-10-16）。
 * 用途：逐条复查（先修超时那一组、再修快速非零那一组 —— 待补收尾方案 §三.3），
 * 以及给运行器自己留一个"小样本"回归口。
 */
const only = (process.env.DSH_ACCEPT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SELECTED = only.length ? CASES.filter(([f]) => only.includes(f)) : CASES;

const results = [];
for (const [file, what] of SELECTED) {
  if (!existsSync(join(ACCEPT_DIR, file))) {
    results.push({ file, what, ok: false, verdict: "blocked", note: "脚本不存在 —— 名字改了就该更新这里的清单" });
    continue;
  }
  /*
   * ⭐ **源码级隔离守卫**（审计 G01）：把数据目录钉成仓库里真实 `data/` 的脚本
   * **拒绝跑**（其中有的还带 rmSync）——“批跑不许碰真实数据”这条规矩不能靠记得。
   */
  const isolation = isolationProblem(file);
  if (isolation) {
    console.log(`  ⛔ ${file.padEnd(22)} 拒绝跑：${isolation}`);
    results.push({ file, what, ok: false, verdict: "blocked", note: isolation });
    continue;
  }

  /*
   * 每条之间**清掉上一次留下的应用进程**。
   *
   * 不清的话会出现"单独跑能过、连着跑就挂"的假失败 —— 上一条的应用还没退干净，
   * 下一条起来的实例被单实例锁挡住（§76 为此白查过三轮），
   * 或者它的窗口抢在中间挡了点击。
   *
   * 这类**偶发失败比稳定失败更糟**：它让人既不敢信绿、也不知道红的含义。
   */
  await killLeftovers();

  let result = await run(file);
  let { code, tail, out } = result;
  let retried = false;
  let timedOut = result.timeout;
  /* 第一次红了就先留证据（哪怕重试会过）—— 偶发的形态全在这份日志里 */
  if (code !== 0 && out.trim()) {
    try {
      writeFileSync(
        join(RECORDS_DIR, `accept-fail-${file.replace(/\.mjs$/, "")}.log`),
        `# ${file}（${what}）第一次失败于 ${new Date().toISOString()}${timedOut ? "（超时）" : ""}\n\n${out}`,
        "utf8",
      );
    } catch {
      /* 写不进去不影响判定 */
    }
  }

  /*
   * 失败后重试一次。
   *
   * 起因：批跑到 22 条后，连续起 22 个 Electron 已经不稳 —— 失败名单**每次都不一样**，
   * 而且出现过 `ECONNREFUSED`（应用根本没起来），可**单独跑又是绿的**。
   * 真坏的东西会连续两次失败；偶发第二次就过。
   *
   * 重试前**多等一会儿再清一次**，因为要等的正是"上一个实例彻底退干净"。
   */
  if (code !== 0) {
    retried = true;
    await killLeftovers();
    await new Promise((r) => setTimeout(r, 3000));
    const second = await run(file);
    if (second.code === 0) {
      code = 0;
      timedOut = false;
    } else {
      tail = second.tail;
      /* ⚠️ 重试失败时**换成第二次的输出**（第一次那份已经没有诊断价值了） */
      out = second.out;
      timedOut = second.timeout;
      try {
        writeFileSync(
          join(RECORDS_DIR, `accept-fail-${file.replace(/\.mjs$/, "")}.log`),
          `# ${file}（${what}）两次都失败于 ${new Date().toISOString()}${timedOut ? "（第二次超时）" : ""}\n\n${out}`,
          "utf8",
        );
      } catch {
        /* 写不进去不影响判定 */
      }
    }
  }

  /*
   * ⚠️ 失败时把**完整输出**写成文件（2026-10-14 补）。
   *
   * 这条批跑以前只留**最后 3 行** —— 而脚本崩在 Playwright 的 `connectOverCDP` 时，
   * 最后 3 行是 `} | | Node.js v24.18.0` 这种没信息量的尾巴：
   * 想弄清"到底哪一步、什么错"只能**重跑那条**（而偶发失败一重跑又是绿的）。
   * 现在完整 stdout+stderr 落在 `.verify/accept-fail-<脚本名>.log` —— 红了先看文件。
   */
  if (code !== 0 && out.trim()) {
    try {
      writeFileSync(
        join(RECORDS_DIR, `accept-fail-${file.replace(/\.mjs$/, "")}.log`),
        `# ${file}（${what}）失败于 ${new Date().toISOString()}\n\n${out}`,
        "utf8",
      );
    } catch {
      /* 写不进去不影响判定 */
    }
  }

  let source = "";
  try {
    source = readFileSync(join(ACCEPT_DIR, file), "utf8");
  } catch {
    /* 读不出来就按"有判定"处理（隔离守卫那一步已经会拦读不出来的） */
  }
  const verdictClass = classify({ code, out, timeout: timedOut }, source);
  /*
   * ⚠️ `no-judge` 也要留输出（2026-10-16 修）：这类是**退 0 但没有判定** ——
   * 上面那几处写日志的条件都是 `code !== 0`，于是屏幕上报"跑通却没判定"、
   * 下面失败清单里还列出一个**根本不存在**的 `accept-fail-*.log`（照着去开文件的人会以为文件被删了）。
   * 判"没有判定"靠的是读**报告内容**，那就得把报告留下来。
   */
  if (verdictClass === "no-judge" && out.trim()) {
    try {
      writeFileSync(
        join(RECORDS_DIR, `accept-fail-${file.replace(/\.mjs$/, "")}.log`),
        `# ${file}（${what}）跑通但没有判定（${new Date().toISOString()}）

` +
          `# ⚠️ 没有判定 = 在批跑里等于没测（要补判据或标废）——下面它的原始输出:

${out}`,
        "utf8",
      );
    } catch {
      /* 写不进去不影响判定 */
    }
  }
  results.push({
    file,
    what,
    ok: verdictClass === "pass",
    retried,
    verdict: verdictClass,
    note: code === 0 ? (verdictClass === "no-judge" ? "跑通但**没有任何判定** —— 它在批跑里等于没测" : "") : tail.slice(0, 160),
    ...(code === 0 ? {} : { out }),
  });
}
await killLeftovers();

/**
 * 跑批记录：这条上次通过 / 上次失败是什么时候。
 *
 * ## 为什么要记
 * §97 撞到的事说明了"长期没跑过的脚本本身就是可疑信号"：
 * `accept-packaged-run.mjs` 因为应用换了形态而失效，却**很多轮没人跑过**，
 * 直到批跑器第一次跑起来才发现。
 *
 * 所以这里把每次结果攒下来。下次跑的时候，
 * **"很久没通过过"这件事会自己显出来**，不用靠谁记得。
 */
const HISTORY = join(RECORDS_DIR, "accept-history.json");
let history = {};
try {
  history = JSON.parse(readFileSync(HISTORY, "utf8"));
} catch {
  /* 第一次跑，没有历史是正常的 */
}

const STALE_DAYS = 14;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const stales = [];

for (const r of results) {
  const rec = history[r.file] ?? {};

  /*
   * ⚠️ 陈旧判定必须用**更新之前**的记录。
   *
   * 第一版是先写 `lastPass = now`、再算"距今多少天"—— 于是**通过的脚本永远算不出陈旧**
   * （刚写成"现在"，差值是 0）。那是"永远不可能触发的守卫"，
   * 而这一整轮的意义就是"守卫必须能红一次才算数"（§53 亲手验过同一类）。
   */
  const prevLastPass = rec.lastPass;

  if (r.ok) {
    rec.lastPass = now.toISOString();
  } else {
    rec.lastFail = now.toISOString();
  }
  history[r.file] = rec;

  if (prevLastPass) {
    const days = (now - new Date(prevLastPass)) / 86400000;
    if (days > STALE_DAYS) stales.push(`${r.file}（上次通过 ${Math.floor(days)} 天前）`);
  } else {
    stales.push(`${r.file}（本次之前从未通过过）`);
  }
}
writeFileSync(HISTORY, JSON.stringify(history, null, 2) + "\n", "utf8");

/*
 * 每次跑的**结果序列**另记一份。
 *
 * 只记"上次通过时间"看不出偶发规律；记下"这次红的是谁"才能回答
 * "是不是总在同一两条上偶发"、"换一条是不是说明是环境而不是脚本"。
 *
 * 起因：§119 撞到批跑偶发不稳（16~18/18），两次假设都不成立 ——
 * ① 拉长条目间等待（1.5s → 4s）**没用**（红的那条从 layers 变成 phone）；
 * ② 端口互串 —— 查过，各脚本用的是自己的端口（9420 / 9590 / 变量…），**也不成立**。
 * 所以改成先**收集数据**，不再猜。
 */
const RUNS = join(RECORDS_DIR, "accept-runs.jsonl");
const failedNames = results.filter((r) => !r.ok).map((r) => r.file);
try {
  appendFileSync(
    RUNS,
    JSON.stringify({
      at: now.toISOString(),
      total: results.length,
      failed: failedNames,
    }) + "\n",
    "utf8",
  );
} catch {
  /* 记不上不影响本次判定 */
}

console.log("");
console.log("=== 不依赖模型的验收批跑 ===");
for (const r of results) {
  // 注意：Node 的 console.log **不支持** `%-22s` 那种宽度对齐，
  // 直接写会把占位符原样打出来。用 padEnd 自己补。
  // 靠重试才过的用 ⚠✓ 标出来 —— 不能让它悄悄变成"都绿了"
  const mark = r.ok ? (r.retried ? "⚠✓" : "✓") : "✗";
  console.log(`  ${mark} ${r.file.padEnd(22)} ${r.what}`);
  if (!r.ok) console.log(`      ${r.note}`);
}
const failed = results.filter((r) => !r.ok);
const byVerdict = (kind) => results.filter((r) => r.verdict === kind).length;
console.log("");
const flaked = results.filter((r) => r.retried && r.ok).length;
/*
 * ⚠️ 自述数字**实时算**（审计 G12：注释里那句"共 99 条、收 58 条"早就过期了，
 * 而它正是读的人判断"这批覆盖率"的唯一依据）。
 */
const scriptFiles = (() => {
  try {
    return readdirSync(ACCEPT_DIR).filter((f) => f.startsWith("accept-") && f.endsWith(".mjs")).length;
  } catch {
    return 0;
  }
})();
console.log(
  `脚本目录共 ${scriptFiles} 条 accept-*.mjs，本清单收 ${CASES.length} 条${only.length ? `，本次只跑指定的 ${SELECTED.length} 条` : ""}`,
);
console.log(
  `共 ${results.length} 条：通过 ${byVerdict("pass")}` +
    `，断言红 ${byVerdict("assert")}` +
    `，环境红 ${byVerdict("environment")}` +
    `，超时 ${byVerdict("timeout")}` +
    `，拒跑 ${byVerdict("blocked")}` +
    `，**无判定 ${byVerdict("no-judge")}**` +
    (flaked ? `　（其中 ${flaked} 条是重试才过的 —— 偶发，还没有根治）` : ""),
);
if (byVerdict("no-judge")) {
  console.log("⚠️ 上面这些「无判定」的脚本跑通了却什么都没断 —— 在批跑里等于没测（要补判据或标废）");
}
console.log(`记录已写入 ${HISTORY}（今天 ${today}）`);

/*
 * ⚠️ **把"没跑的那部分"也报出来**（2026-10-16，审计 G96）。
 *
 * 这一批跑完之后屏幕上原来只有"多少条通过/失败"—— 而"这一批只覆盖了一部分脚本"这件事
 * 从来没出现在任何输出里。`NOT_IN_BATCH` 就是那部分，它不是"不存在"，
 * 而是"今天没人跑"。`debt`（本该进批跑还没进）与 `fossil`（早与产品脱节）
 * 这两类尤其要报 —— 它们的棘轮钉在 `src/acceptRegistry.test.ts` 里。
 */
{
  const outside = Object.entries(NOT_IN_BATCH);
  const byKind = (kind) => outside.filter(([, e]) => e.kind === kind).map(([name]) => name);
  console.log(
    `本轮没跑的有 ${outside.length} 个脚本（需要模型 ${byKind("needs-model").length} / ` +
      `要打包产物 ${byKind("needs-package").length} / 已退役 ${byKind("retired").length} / ` +
      `明账之债 ${byKind("debt").length} / 化石 ${byKind("fossil").length}）—— 名单在 verify-acceptances.mjs 的 NOT_IN_BATCH`,
  );
  const debts = byKind("debt");
  if (debts.length) console.log(`   ⚠️ 明账（本该进批跑、还没进）：${debts.join(" / ")}`);
  const fossils = byKind("fossil");
  if (fossils.length) console.log(`   🗿 化石（早不是本产品的验收了，重写或删）：${fossils.join(" / ")}`);
}

if (stales.length) {
  console.log("");
  console.log(`⚠️ 这些脚本超过 ${STALE_DAYS} 天没通过过 —— 它们覆盖的东西可能已经没人盯着：`);
  for (const x of stales) console.log(`   ${x}`);
  console.log("   （§97 就是这么撞到一条过期脚本的：久没跑 → 早已失效 → 谁都不知道）");
}

if (failed.length) {
  /* 把"完整输出在哪"直接说出来 —— 少了这一行，没人会想到 .verify 里有日志。 */
  console.error("失败脚本的完整输出（红了先看这些文件，别急着重跑）：");
  for (const f of failed) console.error(`  · ${f.file} → .verify/accept-fail-${f.file.replace(/\.mjs$/, "")}.log`);
  const envRed = byVerdict("environment");
  const timeouts = byVerdict("timeout");
  if (envRed || timeouts) {
    console.error(
      `⚠️ 其中环境红 ${envRed} 条、超时 ${timeouts} 条 —— ` +
        "这两类先改装置/环境（应用没起来、等不到条件），别当成产品坏了。",
    );
  }
  console.error("✗ 有验收没过 —— 先查它是产品坏了还是脚本过期了（§56 撞过后者）");
  await localModel.close();
  process.exit(1);
}
await localModel.close();
console.log("✓ 全部通过");
