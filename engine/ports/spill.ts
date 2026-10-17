/**
 * 工具结果**落盘**的端口（U02，2026-10-18）。
 *
 * ## 为什么是端口而不是直接写盘
 *
 * 内核负责"这段结果该不该落盘、落盘之后给模型看什么"（那是策略）；
 * **落到哪个目录**是宿主的事 —— CLI 落在数据目录，桌面落在 `userData`。
 * 与 `executor` 同一个分工：内核不读全局路径。
 */
export type SpillWriteInput = {
  /** 这次工具调用的 id（文件名用它，天然唯一）。 */
  toolCallId: string;
  /** 工具名（只用于文件头的说明与可读性）。 */
  toolName: string;
  /** 完整正文。 */
  text: string;
};

/** 落盘结果（回注给模型的那句话要用它）。 */
export type SpillWriteResult = {
  /** 绝对路径。 */
  path: string;
  /** 字节数。 */
  bytes: number;
  /** 行数。 */
  lines: number;
};

/** 落盘端口。 */
export type SpillPort = {
  write(input: SpillWriteInput): Promise<SpillWriteResult>;
  /** 这个目录里的文件允不允许 `read_file` 回读（内核用它做路径校验）。 */
  readonly dir: string;
};
