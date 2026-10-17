/**
 * 产品自述（名字 / 标题 / 版本）——**只有这一份**。
 *
 * 原来 `agentServer.ts` 与 `acp/agent.ts` 各写了一份字面量 `"0.4.0"`，
 * 而包的版本已经走到 0.5.0：对外/对宿主自报的版本号成了两处会各自腐坏的抄本
 * （审计 P183 的同类：接口按其承诺的形状是假的）。抽到这里之后，
 * 升版本只有一处要改。
 *
 * ## D09（2026-10-18）：版本号从 `version.json` 读
 *
 * 在这之前，`PRODUCT_VERSION` 是一个**手写的字面量**，注释写着"与 package.json 手动保持一致"。
 * 现实是：npm 已经发到 0.5.1，根 `package.json` 还是 0.5.0，`ding --version` 也跟着说 0.5.0。
 * "手动保持一致"在没有机器检查时等于"迟早不一致"。
 *
 * 现在：`shared/version.json` 是**唯一的数字**，运行时从它读；
 * 根 `package.json` / `packages/cli/package.json` 由 `src/versionSource.test.ts` 钉住一致。
 * 不直接 import `package.json` 是因为 CLI 构建会把 `dist-cli/package.json`
 * 写成 `{"type":"commonjs"}`（见 `scripts/build-cli.mjs`），版本会被覆盖掉；
 * 单独的 `version.json` 在两条产物里都能原样保留。
 */
import version from "./version.json";

export const PRODUCT_NAME = "ding-harness";
export const PRODUCT_TITLE = "Ding Harness";
export const PRODUCT_VERSION = version.version;
