import path from "node:path";
import ts from "typescript";

/**
 * 符号抽取（E1）。
 *
 * 方案里首选 `web-tree-sitter`（WASM），但当前仓库没有这个依赖，新增它要带 10–25MB
 * 语言包并处理 Electron 打包。方案 §11.2 写明"降级：TS/JS 用 TypeScript 编译器 API"——
 * 本轮就走这条**已存在依赖**的路：TS/TSX/JS/JSX 有符号，其它语言跳过并计数。
 * 这不是"做不了"，是"先做能工作的那一半"，边界写在报告里。
 */

export type Symbol = { file: string; name: string; kind: string; line: number };

const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function supportedSource(file: string): boolean {
  return TS_EXT.has(path.extname(file).toLowerCase());
}

/** 从一段源码里抽顶层与嵌套声明（函数/类/接口/类型/枚举/变量）。 */
export function parseSymbols(file: string, source: string): Symbol[] {
  if (!supportedSource(file)) return [];
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const out: Symbol[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    let name: string | undefined;
    let kind: string | undefined;
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      kind = "function";
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
      kind = "class";
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
      kind = "interface";
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
      kind = "type";
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
      kind = "enum";
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
      kind = "method";
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ file, name: decl.name.text, kind: "variable", line: lineOf(decl) });
      }
      return;
    }
    if (name && kind) out.push({ file, name, kind, line: lineOf(node) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
