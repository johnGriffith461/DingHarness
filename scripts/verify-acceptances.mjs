import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

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
 *   ② 192 条 .mjs 里 **179 条硬编码 `D:/DoubaoWorkClone` 绝对路径**，与脚本自身位置无关；
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
 *   ✅ `accept-voice`（账号按钮现在弹的是菜单，设置在其中一项；三段导航都改对了）
 *   ✅ `accept-p5-prompt` **退役**：它读的 `window.__lastAiPrompt` 是 DEV-only 探针，
 *      打包产物里根本没有 → 这条脚本**永远跑不了**。它要守的东西已搬进单测
 *      （`src/canvas/markers.test.ts` 里 `instructionFromMarkers` 那 5 条）。
 *
 * 这份清单**不是"以后再说"**：§97 撞过的就是"久没跑 → 早已失效 → 谁都不知道"。
 * 逐步把它们归到"能跑且会判定"或"明确废弃"，缺口才算真的关掉。
 */
const CASES = [
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
   * ⚠️ `accept-size-spec.mjs` **摘掉了**（原来在批跑里，标签写着"纯计算"）。
   *
   * §109 实测它**偶发红**（之前一直绿、这次红）。回看脚本内容里有 `gen-run` ——
   * 也就是说它**会真出图**，并不是纯计算。所以它的红绿受模型响应影响，
   * 不适合放在"不依赖模型"的批跑里。
   *
   * **这条的教训**：标签是我自己写的，写错了就没人在意它是不是真的无模型。
   * 判据应该是**读脚本有没有真调模型的调用**，不是"看起来像不像功能测试"。
   */
  // ["accept-size-spec.mjs", "图片尺寸规格（其实会出图，见上）"],
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
 * - `accept-imageedit.mjs`（§167）图片动作条：真生成一张 → 点「变清晰」→ 新图落进 assets → 云盘两张都在（**会真调图像模型 2 次**）。
 * - `accept-doctone.mjs`（§168）调整语气：口语化的原文点「更学术」→ 断言**真的被重写**、历史记着由来、磁盘跟上。
 * - `accept-toolargs.mjs`（§175）工具参数进留痕：让模型记一件事，断言那一行里出现**只有参数里才有**的内容（会真调模型 1 次）。
 * - `accept-sessionlog.mjs`（C2）会话事件日志：跑一轮真对话，读 `sessions/<id>.jsonl`，
 *   断言「首行是 `request`（带着这一轮的用户内容）／工具有调用也有配对的结果／末行是 `done`／
 *   **正文与界面上那条回复对得上**」（会真调模型 1 次，且会真的触发一次工具）。
   *
   * 它们必须存在（那是这些能力的**唯一硬证据**），但不属于"不依赖模型"这一类。
   * 判据与 §109 一致：**读脚本里有没有真调模型的调用**，不是"看起来像不像功能测试"。
   */
  ["accept-versions.mjs", "版本清单与对比（不调模型）"],
  /*
   * §135/§136 新增的三条。它们比上面那批**更抗环境干扰**：开头用 `.verify/harness.mjs`
   * 的 `freshDir()` —— 先杀掉上一轮的残留 Electron 再删数据目录，而不是直接 `rmSync`。
   * （§135 撞过：上一个脚本异常退出时没杀子进程 → 目录被句柄占着 → 下一条 `rmSync` 报 EPERM，
   *  看起来像"产品坏了"，其实是环境。）
   */
  ["accept-memory.mjs", "记忆（加 / 刷新后仍在 / 删）"],
  ["accept-settings-pages.mjs", "设置子页（个人资料 / 账号 / 返回）"],
  ["accept-shortcuts.mjs", "左栏全局快捷键（Ctrl N / Ctrl Shift T·S·D）"],
  ["accept-threads.mjs", "管理历史对话（分档 / 摘要 / 行内操作 / 刷新后仍在）"],
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
  ["accept-new.mjs", "云盘新建 + 首页推荐卡轮换"],
  ["accept-drive.mjs", "云盘接真目录（类型 / 大小 / 隐藏文件 / 最近 / 删除真删盘）"],
  ["accept-context.mjs", "云盘右键七项 + 插件管理子页"],
  ["accept-export.mjs", "画布导出（视图 / 画框各一张真 PNG，画框更小）"],
  ["accept-voice.mjs", "设置·声音选择（真音色列表 / 选了就生效并记住）"],
  /*
   * 2026-10-14 新写/重写的三条（都**不连模型、不看 DEV 探针**）：
   *   · `accept-p5-ref` 重写：原来断的是 `window.__lastChatPayload`（DEV 才有），
   *     打包产物里永远跑不到 —— 现在断的是界面这一路（@ → 候选 → 芯片 → 断链）
   *   · `accept-retry`：聊天失败后的「重试」（用空凭据文件制造确定性失败）
   *   · `accept-codecopy`：代码节点的「复制」真写剪贴板 + 2 秒反馈
   */
  ["accept-p5-ref.mjs", "节点引用芯片（@ 候选 / 芯片 / 断链标注）"],
  ["accept-retry.mjs", "聊天重试（失败有出路 / 撤旧问答重发 / 不卡忙碌态）"],
  ["accept-codecopy.mjs", "代码节点复制（真进剪贴板 / 反馈 2 秒后复位）"],
  ["accept-material.mjs", "@ 添加资料（文件内容真的进了请求 / 发完即摘 / 不污染气泡）"],
  /*
   * agent 真能干活那一条（2026-10-14，§225）：走 `ai:runTool` 真跑六个工具，
   * 看磁盘上的副作用。**不调模型**，所以进批跑。
   */
  ["accept-workspace.mjs", "工作区：授权后 agent 能看/找/读/写/改/跑命令，越界被拒，撤销后立刻失效"],
  /*
   * 连接器（MCP，2026-10-14，§226）：起一个**真的**假 MCP server 子进程，
   * 验装上自动连 / 工具带前缀交给模型 / 调用真回到服务端。**不调模型**。
   */
  ["accept-mcp.mjs", "连接器：装 MCP server 自动连、工具交给模型、调用与服务端报错都如实带回、能重连"],
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
   *   ② 它原来还写死 `D:/DoubaoWorkClone/data`（**真实数据目录**），
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
  ["accept-p5-prompt.mjs", "画布提示词节点"],
  ["accept-clipboard.mjs", "画布复制粘贴"],
  ["accept-doc.mjs", "AI 文档（入口 / 文案对齐 / 落盘重启 / 复制 / 历史还原）"],
  ["accept-taskcenter.mjs", "任务中心（三块分区 / 置顶上限 / 移除 / 落盘）"],
  ["accept-reader.mjs", "AI 阅读（入口 / 大纲 / 页面检索 / 图表 / 最近阅读落盘）"],
  ["accept-agent.mjs", "创建 AI 智能体（入口 / 文案与标签 / 校验 / 落盘 / 选择恢复）"],
  ["accept-driveops.mjs", "云盘证据层（标签页 / 筛选 / 排序 / 新建菜单 / 到底了 / 存储）"],
  ["accept-drivefile.mjs", "云盘文件操作（删除确认 / 重命名不覆盖 / AI 阅读）"],
  ["accept-coding.mjs", "创作广场（只收网页产物 / 分类搜索 / 时间范围 / 排行口径 / 创作同款）"],
  ["accept-search.mjs", "两处搜索（技能搜索 / 云盘搜索：筛选 / 空态 / 清空复原）"],
  ["accept-phrases.mjs", "@ 常用语（唤出 / 筛选 / 替换 / 邮箱不误触发 / Esc / Enter 选不发）"],
  ["accept-searchhistory.mjs", "搜索历史（记录 / 去重 / 两处不串 / 落盘 + 清空也落盘）"],
  ["accept-imagepage.mjs", "生成图片独立页（入口 / 占位逐字 / 尺寸真的在算 / 诚实状态）"],
  ["accept-assets.mjs", "生成图进云盘（assets 来源 / 类型图片 / 可筛 / 重命名改盘 / 删除确认）"],
  ["accept-docformat.mjs", "文档调整语气/格式（九档文案逐字 / 设为小标题真加 ## / 设为正文真去掉 / 留痕）"],
  ["accept-download.mjs", "云盘下载/另存为（菜单项 / 真复制字节一致 / 白名单边界 / 不存在报失败）"],
  ["accept-upload.mjs", "上传按文件回报（正常落盘 / .exe 被拒且原因逐字 / 一个被拒不影响整批 / 空闲无面板）"],
  ["accept-drop.mjs", "拖拽上传 + 面板逐条状态（内容落盘一字不差 / 面板亮起 / .exe 被拒没落盘 / 角标干净）"],
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
 * 跑一条验收并抓它的退出码。
 *
 * @param {string} file 脚本名（相对 scripts/accept）
 * @returns {Promise<{ code: number, tail: string }>}
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
    const child = spawn(process.execPath, [join(ACCEPT_DIR, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out, tail: out.trim().split("\n").slice(-3).join(" | ") }));
  });
}

/**
 * 清掉上一条验收留下的应用进程，并**等端口真正释放**。
 *
 * 用 `taskkill /T` 连子进程一起清 —— Electron 会起主进程 + GPU + 渲染器多个，
 * 只杀主进程会留下占着单实例锁的残骸。
 *
 * ⚠️ 等待时间是 4 秒，不是 1.5 秒。原因（§119/§120）：批跑里 **18 条只有 5 条
 * 自己设了 `DSH_DEBUG_PORT`**，其余 13 条都用**同一个默认端口**。
 * 进程被 kill 之后端口不会瞬间释放，下一条就可能连到**残留实例**或分配失败 ——
 * 表现正是"某两条偶发红、单独跑却是绿的"。
 *
 * @returns {Promise<void>} 清完（或本来就没有）即 resolve
 */
function killLeftovers() {
  return new Promise((resolve) => {
    const deadline = Date.now() + 12000;
    const tick = () => {
      const first = spawn("taskkill", ["/F", "/IM", "工作台.exe", "/T"], { stdio: "ignore" });
      first.on("close", () => {
        const second = spawn("taskkill", ["/F", "/IM", "electron.exe", "/T"], { stdio: "ignore" });
        second.on("close", () => {
          setTimeout(() => {
            /*
             * ⭐ 等到**真的没有残留进程**，不是睡固定秒数（§137）。
             *
             * 原来这里是"睡 4 秒就往下走"。而 `taskkill /F` 发出后进程不会瞬间消失，
             * **强杀期间新的实例起不来** —— 于是某几条报出 `ECONNREFUSED` 或
             * `ws disconnected code=1006`，看起来像产品坏了。
             * 判据应当是"还剩几个进程"，不是"过了几秒"。
             */
            if (countLeftovers() === 0 || Date.now() > deadline) return resolve();
            tick();
          }, 500);
        });
        second.on("error", () => resolve());
      });
      first.on("error", () => resolve());
    };
    tick();
  });
}

/** 现在还活着的 electron / 工作台 进程数。 */
function countLeftovers() {
  const n = (name) => {
    const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], { encoding: "utf8" });
    const s = r.stdout ?? "";
    if (/no tasks|没有运行|信息: 没有/i.test(s)) return 0;
    return (s.match(new RegExp(name.replace(".", "\\."), "gi")) ?? []).length;
  };
  return n("electron.exe") + n("工作台.exe");
}

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

const results = [];
for (const [file, what] of CASES) {
  if (!existsSync(join(ACCEPT_DIR, file))) {
    results.push({ file, what, ok: false, note: "脚本不存在 —— 名字改了就该更新这里的清单" });
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

  let { code, tail, out } = await run(file);
  let retried = false;

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
    } else {
      tail = second.tail;
      /* ⚠️ 重试失败时**换成第二次的输出**（第一次那份已经没有诊断价值了） */
      out = second.out;
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

  results.push({
    file,
    what,
    ok: code === 0,
    retried,
    note: code === 0 ? "" : tail.slice(0, 160),
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
console.log("");
const flaked = results.filter((r) => r.retried && r.ok).length;
console.log(
  `共 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}` +
    (flaked ? `　（其中 ${flaked} 条是重试才过的 —— 偶发，还没有根治）` : ""),
);
console.log(`记录已写入 ${HISTORY}（今天 ${today}）`);

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
  console.error("✗ 有验收没过 —— 先查它是产品坏了还是脚本过期了（§56 撞过后者）");
  process.exit(1);
}
console.log("✓ 全部通过");
