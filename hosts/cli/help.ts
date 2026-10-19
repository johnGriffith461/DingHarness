/**
 * `ding --help` 的那一屏（2026-10-16 从 `ding.ts` 拆出来）。
 *
 * 拆的理由是 `src/structureGuard.test.ts` 的巨石上限（`.ts` ≤ 900 行）：
 * `ding.ts` 在加完审计修复（P212 的不认识命令守卫、P129 的数据根提醒）之后到了 918 行。
 * 这一块是**纯文案**，与命令分发、参数解析没有任何耦合 —— 它是最该先搬走的部分。
 *
 * ⚠️ 命令表**必须与 `ding.ts` 的分发链一致**（`KNOWN_COMMANDS` 那份名单就是它的镜像）：
 * 这里多写一条不存在的命令、或漏掉一条真的命令，都是在教用户做错事。
 */

/**
 * 打印帮助，返回退出码（恒 0）。
 *
 * @param devMode 是否显示工程模式（`--dev`）
 * @param dataDir 本次实际使用的数据目录（照实打出来 —— 它会被 `DH_DATA_DIR` /
 *   `DSH_CANVAS_DATA_DIR` 改，用户要能看见自己现在落在哪）
 */
/**
 * T-10：帮助文本的**纯渲染**（单测直接读它，不用去截 stdout）。
 *
 * 为什么抽出来：`process.stdout.write` 在 vitest 下会被它自己的 console 拦截接管，
 * 截流拿不到内容 —— 于是"帮助里缺了哪些命令"根本测不出来（实测踩过：38 条全红）。
 */
export function renderHelp(devMode: boolean, dataDir: string): string {
  return [
      "ding —— Ding Harness 的命令行宿主",
      "",
      '  ding run "任务" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps n] [--plan] [--background]',
      "  ding sessions [--kind chat|task|cli] [--json] [--export <会话 id>]",
      "  ding sessions --state <会话 id>                # 回放运行态（运行中/等你确认/已暂停…）",
      "  ding review <会话 id> [--json] [--revert <路径>]  # 逐文件看改动 / 回滚某个文件",
      "  ding sessions --cost [--by session|day|model]   # 成本账本（数字只来自 provider 上报）",
      "  ding doctor [--json] [--fix]                   # 一键自检（--fix 只修建目录/检索索引两类）",
      "  ding recipe list|show|run|export|import            # 任务模板（可分享的「提示词 + 工具范围 + 档位」）",
      "  ding space [invite|join|members|roles|remove|share|unshare|takeover|rooms|room|usage|audit]   # 团队空间（配对码 / 名册 / 共享 / 接管 / 账本）",
      "  ding approvals --to <服务地址> --token <口令> [--watch]   # 审批：列一遍 / 盯着新处置（批后通知的消费端）",
      "  ding sync <会话 id> --to <服务地址> --token <口令>   # 两端同步（推自己 + 拉别人，幂等；口令也可走 DH_SYNC_TOKEN）",
      "  ding serve [--port 8787] [--bind <地址> --token <口令>] [--member <id>:<口令>]…  # Agent Server（默认只绑回环；--member 给成员身份）",
      "  ding connect <url> [任务] [--token <口令>]           # 连到远端 agent 跑一轮（Phase 17 的另一半）",
      "  ding acp                                       # 作为 ACP agent 跑在标准输入输出上（被外部宿主驱动）",
      "  ding resume [<会话 id>] [--continue]           # 崩溃恢复（列出被打断的回合；--continue 重跑那一轮）",
      "  ding backup [--out <文件>] [--keep-provenance] # 全量备份（会话 + 配置型 store + CLI 配置，单个 JSON）",
      "  ding restore <文件> [--list]                   # 从备份恢复（--list 只看不恢复；只补不覆盖：已有的键跳过）",
      "  ding init                                      # 首次配置向导（配 key / 选模型 / 选目录）",
      "  ding eval [类别] [--json] [--repeat <k>] [--update-baseline]  # 离线评测集（--repeat = pass@k 采样）",
      "  ding bench list|run [suite] [--task <id>] [--split train|test] [--repeat <k>] [--docker] [--json] [--out <文件>]",
      "  ding fork <会话 id> [--at-turn N | --at-seq N] [--into <新 id>] [--list]  # 从任一时点分叉",
      "  ding worktree start|list|merge|remove <名字> [--base <ref>] [--dir <仓库>] [--yes]  # git 工作树隔离",
      "  ding knowledge add|search|ask|list|remove … [--domain private|team] [--limit n]  # 本地知识库（带引用）",
      "  ding acp-drive --cmd <可执行> [--arg <参数>…] --prompt \"任务\" [--cwd <目录>]  # 驱动外部 ACP agent",
      "  ding providers list|add|remove …                    # 自定义 provider（端点/协议/密钥引用）",
      "  ding schedule add \"每天 9 点\" --title <名> --prompt <任务> | list | run-due [--every N]  # 定时任务常驻执行",
      "  ding im serve|status [--port 8790] [--config <文件>]  # 飞书/Slack bot 身份桥（验签+去重+回复）",
      "  ding memory list|export|import|status [--git <目录>] [--push|--pull]  # 记忆的 Git 工作树承载",
      "  ding workflow run|validate|list|show … [--resume <运行.json>] [--retry-failed]  # 多 agent 工作流（断点续跑）",
      "  ding models",
      "  ding agents                                    # 内置专家（AgentSpec）",
      "  ding plugins [list|search <词>|verify <目录>|verify-index <索引>|install <目录|npm:包名|index:id> --yes|enable|disable|remove|doctor] [--index <文件|URL>]",
      "  ding config [show|set <键> <值>|unset <键>]    # 默认 provider / 模型 / 档位 / 目录",
      /*
       * T-10：这七条**已经能用**但主列表里没有 —— `ding stats` 是全 CLI 最有用的
       * 可靠性统计（成功率/工具失败数/p50/p95），用户看不到就不会用。
       * 下面 `help.test.ts` 拿 KNOWN_COMMANDS 与这份输出对账，以后再漏会红。
       */
      "  ding stats [--days N] [--json]                # 可靠性统计：成功率 / 工具失败数 / p50 / p95",
      "  ding tree [会话 id] [--json]                  # 分叉树（谁从哪一刻分出来的）",
      "  ding jobs list|show|wait|cancel [任务 id]     # 后台任务",
      "  ding steer <会话 id> \"要补的话\"               # 中途插话（下一段生效）",
      "  ding board list|add|claim|done|fail|post|inbox …  # 任务板（认领 / 收件箱）",
      "  ding export [--out <文件>] [--kind chat|task|cli]  # 导出（不含密钥）",
      "  ding import <导出文件.json> [--dry-run]       # 导入（只补不覆盖）",
      "  ding help [<命令>]                             # 这份总帮助，或某条命令自己的用法",
      "  ding --json <命令>                             # 给脚本/CI 的 JSON 输出",
      ...(devMode
        ? [
            "",
            "工程模式（--dev，验收驱动器，不属于产品表面）：",
            "  ding record <会话 id> [--out <文件>]",
            "  ding replay <快照文件>",
          ]
        : ["", "（`--dev` 会多出两个工程模式命令：record / replay —— 那是验收驱动用的。）"]),
      "",
      /*
       * ⚠️ 这一行要**如实**（审计 P129）：数据目录可以被两个环境变量改，
       * 而用户最需要知道的就是"我现在落在哪"（`ding backup` 备份的是它，不是桌面那份）。
       */
      `数据目录：${dataDir}（DH_DATA_DIR 可覆盖；桌面的 DSH_CANVAS_DATA_DIR 也认）`,
      "",
      /*
       * A-03：退出码表。脚本靠它分支，所以要写在**用户能看见的那一屏**上，
       * 不能只活在源码里。
       */
      "退出码：0 成功 / 1 失败 / 2 用法错误 / 3 没有可用 provider / 4 预算暂停 / 6 等待人工确认",
      "",
  ].join("\n");
}

export function cmdHelp(devMode: boolean, dataDir: string): number {
  process.stdout.write(renderHelp(devMode, dataDir));
  return 0;
}

/**
 * **每条命令自己的用法**（U11，2026-10-18）。
 *
 * 在这之前 `--help` 只在**顶层**生效：`ding run --help` 会被当成"缺任务描述"，
 * 打印一句用法就以退出码 2 失败。对用户来说这是"我想问怎么用，它却报错了"。
 *
 * 表里每一条都必须与 `ding.ts` 的分发链一致；`args.test.ts` 会扫命令表核对。
 */

/**
 * **认识哪些命令**（U11，2026-10-18：从 `ding.ts` 搬出来的唯一一份）。
 *
 * 它同时是"拼错命令要报错"的判据与"每条命令都要有用法说明"的清单 ——
 * 一份名单两个用途，别再在别处抄第二份。
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "run",
  "sessions",
  "record",
  "replay",
  "models",
  "plugins",
  "recipe",
  "space",
  "sync",
  "approvals",
  "serve",
  "connect",
  "acp",
  "resume",
  "backup",
  "restore",
  "doctor",
  "init",
  "eval",
  "bench",
  "fork",
  "worktree",
  "knowledge",
  "acp-drive",
  "providers",
  "schedule",
  "im",
  "memory",
  "workflow",
  "config",
  "agents",
  "review",
  "jobs",
  "steer",
  "tree",
  "stats",
  "export",
  "import",
  "board",
  "help",
]);

export const COMMAND_USAGE: Record<string, string> = {
  run: 'ding run "任务描述" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps <整数>] [--plan] [--background]',
  sessions: "ding sessions [--kind chat|task|cli] [--json] [--export <会话 id>] [--state <会话 id>] [--cost [--by session|day|model]]",
  review: "ding review <会话 id> [--json] [--revert <文件路径>]",
  jobs: "ding jobs <list|show|wait|cancel> [任务 id]",
  steer: 'ding steer <会话 id> "要补的话"',
  tree: "ding tree [会话 id] [--json]",
  stats: "ding stats [--days N] [--json]",
  export: "ding export [--out <文件>] [--kind chat|task|cli]（不含密钥）",
  import: "ding import <导出文件.json> [--dry-run]",
  board: "ding board [list|add|claim|done|fail|post|inbox] …",
  record: "ding record <会话 id> [--out <文件>]（工程模式）",
  replay: "ding replay <快照文件>（工程模式）",
  models: "ding models [--json]",
  plugins: "ding plugins <list|search|verify|verify-index|install|remove|enable|disable> …",
  recipe: "ding recipe <list|show|run|export|import> …",
  space: "ding space <invite|join|members|roles|remove|share|unshare|takeover|rooms|room|usage|audit> …",
  sync: "ding sync <会话 id> --to <服务地址> --token <口令> [--owner <成员 id>] [--producer <id>]",
  approvals: "ding approvals --to <服务地址> --token <口令> [--watch] [--state pending|approved|rejected]",
  serve: "ding serve [--port 8787] [--bind <地址> --token <口令>] [--member <id>:<口令>]…",
  connect: "ding connect <url> [任务] [--token <口令>] [--cwd <目录>] [--sessions] [--json]",
  acp: "ding acp（stdio 上的 ACP 宿主；需要一个 provider）",
  resume: "ding resume <会话 id> [--continue] [--owner <成员 id>]",
  backup: "ding backup [--out <路径>] [--data-dir <数据根>] [--force]",
  restore: "ding restore <备份文件> [--list]",
  doctor: "ding doctor [--json] [--fix]",
  init: "ding init（交互式向导：provider → key → 模型 → 工作目录）",
  eval: "ding eval [--json] [--update-baseline] [--repeat N]",
  bench: "ding bench <list|run> [--task <id>] [--suite <名>] [--repeat N]",
  fork: "ding fork <源会话 id> [--at-turn N | --at-seq N] [--into <新 id>] [--list]",
  worktree: "ding worktree <add|list|remove> …",
  knowledge: "ding knowledge <add|search|list> …",
  "acp-drive": 'ding acp-drive --cmd <可执行> --arg <参数>… --prompt "任务" [--cwd <目录>] [--timeout <ms>]',
  providers: "ding providers [--json]",
  schedule: "ding schedule <add|list|remove|run-due> …",
  im: "ding im（飞书/Slack 桥；配置在 im.json）",
  memory: "ding memory <list|add|remove|export|import|status> [--git <目录>]",
  workflow: "ding workflow <list|show|run> …",
  config: "ding config <show|set|unset> [键] [值]",
  agents: "ding agents [--json]",
  help: "ding help",
};

/**
 * 打印某条命令的用法（`ding run --help` 走这里）。
 *
 * @param command 命令名
 * @param devMode 是否显示工程模式命令
 * @returns 退出码（认识的命令恒 0；不认识的也回 0 并指向总帮助 —— 用户是在问，不是在犯错）
 */
export function cmdCommandHelp(command: string, devMode: boolean): number {
  const line = COMMAND_USAGE[command];
  if (!line) {
    process.stdout.write(`没有「${command}」这条命令的单独说明 —— 看总帮助：ding --help\n`);
    return 0;
  }
  if (!devMode && (command === "record" || command === "replay")) {
    process.stdout.write(`${command} 是工程模式命令（加 --dev 才会出现在总帮助里）。用法：${line}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `用法：${line}`,
      "",
      "通用：--json（机器可读） / --dir <目录>（可重复） / --mode <档位> / --help",
      "总帮助：ding --help",
      "",
    ].join("\n"),
  );
  return 0;
}
