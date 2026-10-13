"use strict";
/**
 * 画布文档与快照的共享类型（主进程写盘、渲染进程读写都引这里）。
 *
 * 一份画布 = 版本号 + 单调修订号 + 视口 + 节点 + 边。
 * 节点/边的具体结构由渲染进程的 `src/canvas/types.ts` 定义，这里只保证
 * "能被 JSON 序列化"这一条（画布图必须可序列化，否则宁可显式报错）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
