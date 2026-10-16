/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由原本记在 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 */

import { useEffect, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import { Check, Clock, Monitor, Smartphone } from "lucide-react";
import { NavCollapseButton } from "./NavCollapseButton";

export function PhonePage() {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  /*
   * 两个开关都是**真状态**，不是 useState：
   *   · 「可被同账号设备连接与控制」是**许可**，关掉后别的设备不该能连上 → 写盘；
   *   · 「让这台设备保持唤醒状态」是这台机器**当前的真实状态** → 主进程 powerSaveBlocker。
   * 原来两个都是本地 useState，重启就回到默认值，用户会以为"设了没用"。
   *
   * ⚠️⚠️ 但"读真实状态"这件事也做了一半（2026-10-16 审计 P09）：
   *   · `allowConnect` 的初值是**写死的 true** —— 状态还不知道时界面就显示"允许连接"，
   *     而它是**许可**类：用户打开这一页看到的可能是**与磁盘不符**的一句承诺；
   *   · `status()` 那一串只有 `.finally` 没有 `.catch` —— 读失败时那个写死的 true
   *     就留在界面上了（正好是最"松"的那一档）；
   *   · `toggleConnect` 只 `setAllowConnect(next)`，**不看主进程回了什么**
   *     （同一文件里的 `toggleAwake` 已经改成以返回值为准了 —— 两个开关两套口径）。
   *
   * 现在：初值 `null` = **未知**（界面如实显示"读取中"、按钮禁用），
   * 读到才知道；读失败就保持未知（不假装成"允许连接"）；切换以主进程返回值为准。
   */
  const [allowConnect, setAllowConnect] = useState<boolean | null>(null);
  const [keepAwake, setKeepAwake] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!bridge?.remote) {
      setLoaded(true);
      return;
    }
    void bridge.remote
      .status()
      .then((status) => {
        setAllowConnect(status.allowConnect);
        setKeepAwake(status.keepAwake);
      })
      .catch(() => {
        /*
         * 读不到就**保持未知**（`allowConnect` 仍是 null）——
         * 这里原来没有 catch，于是"读失败"与"允许连接"在界面上长得一模一样。
         */
      })
      .finally(() => setLoaded(true));
  }, [bridge]);

  const toggleConnect = () => {
    if (!bridge?.remote?.setAllowConnect) return;
    const next = !(allowConnect ?? false);
    // 以主进程回给的真实状态为准 —— 与 toggleAwake 同一套口径
    void bridge.remote.setAllowConnect(next).then((actual) => setAllowConnect(actual));
  };

  const toggleAwake = () => {
    // 以主进程回给的真实状态为准 —— 不必信本地这一份记忆
    void bridge?.remote?.setKeepAwake(!keepAwake).then((actual) => setKeepAwake(actual));
  };

  return (
    <section className="wb-page" data-testid="wb-page-phone">
      <header className="wb-page-head">
<NavCollapseButton />
        <span className="wb-spacer" />
        {!loaded ? <em className="wb-phone-loading">读取本机状态…</em> : null}
        {/* 读完了却还是未知（没有桥或读失败）——如实说，不把它显示成「允许连接」 */}
        {loaded && allowConnect === null ? (
          <em className="wb-phone-loading" data-testid="wb-phone-unknown">
            读不到本机状态，开关保持未知（不猜一个值）
          </em>
        ) : null}
      </header>

      <div className="wb-page-body wb-phone-body">
        <div className="wb-phone-left">
          <div className="wb-mini-label">远程控制</div>
          <h2 className="wb-page-h2">出门也能操作电脑</h2>
          <p className="wb-page-p">
            用手机端在工作任务中，连接此电脑后，可远程继续任务，接收进度提醒，并调用这台电脑上的文件和工具。
          </p>

          <div className="wb-switch-list">
            <label className="wb-switch-row">
              <span className="wb-switch-icon is-blue">
                <Monitor size={15} />
              </span>
              <span className="wb-switch-text">可被同账号设备连接与控制</span>
              <button
                className={`wb-switch${allowConnect ? " is-on" : ""}`}
                data-testid="wb-switch-connect"
                /*
                 * 未知（正在读 / 读不到）时不许切：那一下会写一个"用户没看过"的**许可**值。
                 * 注意这不是"本机版没有"那类借口式置灰（`deadControls` 守的就是那种）：
                 * 它是一个**过渡中的真状态**，`title` 里把原因说清了（正在读，读到才能切）。
                 */
                disabled={allowConnect === null}
                data-state={allowConnect === null ? "unknown" : allowConnect ? "on" : "off"}
                title={allowConnect === null ? "正在读本机状态：读到之前不能切（读不到就保持未知，不替你猜一个值）" : undefined}
                onClick={toggleConnect}
                aria-pressed={allowConnect === true}
              >
                <span />
              </button>
            </label>
            <label className="wb-switch-row">
              <span className="wb-switch-icon is-green">
                <Clock size={15} />
              </span>
              <span className="wb-switch-text">让这台设备保持唤醒状态</span>
              <button
                className={`wb-switch${keepAwake ? " is-on" : ""}`}
                data-testid="wb-switch-awake"
                onClick={toggleAwake}
                aria-pressed={keepAwake}
              >
                <span />
              </button>
            </label>
          </div>

          <div className="wb-steps">
            <div className="wb-step">
              <span className="wb-step-num">1</span>
              <span>
                <b>打开手机端 App</b>
                <em>登录与当前电脑相同账号</em>
              </span>
            </div>
            <div className="wb-step">
              <span className="wb-step-num">2</span>
              <span>
                <b>在工作任务中选择电脑</b>
                <em>选择在线的电脑便可远程控制</em>
              </span>
            </div>
            <div className="wb-qr">
              {/*
                实机这里是一张真的二维码（扫了去下手机端）。
                本机版**没有配套手机端**，所以不画一张假的二维码 ——
                假码扫出来什么都没有，比一块说明更误导。
              */}
              <div className="wb-qr-box wb-qr-none" data-testid="wb-qr-unavailable">
                <Smartphone size={26} />
                <em>本机版不含手机端</em>
              </div>
              <em className="wb-qr-cap">下载或打开手机端 APP</em>
            </div>
          </div>
        </div>

        {/* 右侧样机：实机是一张手机截图，这里用 DOM 画出来，内容照实机的文案 */}
        <div className="wb-phone-mock" data-testid="wb-phone-mock" aria-hidden>
          <div className="wb-mock-screen">
            <div className="wb-mock-menu">
              <div className="wb-mock-menu-head">对话</div>
              {["工作电脑", "家里电脑", "云电脑"].map((name, i) => (
                <div className={`wb-mock-menu-row${i === 0 ? " is-on" : ""}`} key={name}>
                  工作任务 · {name}
                  {i === 0 ? <Check size={12} /> : null}
                </div>
              ))}
            </div>
            <div className="wb-mock-chips">
              {["工作电脑", "周报", "始终允许", "PPT"].map((chip) => (
                <span className="wb-mock-chip" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
            <div className="wb-mock-input">发消息或按住说话...</div>
          </div>
          <div className="wb-mock-prompt">整理桌面上的 Word 文件</div>
          <div className="wb-mock-prompt">帮我清理电脑上大于 5G 的文件</div>
        </div>
      </div>
    </section>
  );
}

