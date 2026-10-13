/**
 * pangu 没有随包提供类型声明（`@types/pangu` 也不存在），这里补一份最小声明。
 * 只声明本项目实际用到的 API，避免用 `any` 逃逸类型检查。
 */
declare module "pangu" {
  /** 在中日韩文字与半角字符之间插入空格。 */
  export function spacing(text: string): string;
  /** 对 HTML 字符串做同样处理（本项目未用，保留声明以便将来需要）。 */
  export function spacing(text: string, options: { html?: boolean }): string;
  const pangu: {
    spacing: typeof spacing;
  };
  export default pangu;
}
