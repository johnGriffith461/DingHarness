import { useEffect, useState } from "react";

import type { ComputerAuditView, ComputerStatusView, ShellBridge } from "@shared/ipc";
import { COMPUTER_KEYS } from "@shared/computer";

/**
 * Computer Use 的授权与控制面板（V6-2n）。
 *
 * ## 为什么控制面板在「权限矩阵」页
 *
 * 它是一条**权限**：默认关闭、每次动作要批准、全程留痕。放在权限页比塞进设置深处更显眼，
 * 也符合"两轴矩阵"的心智（这是工具轴之外的第三个开关：**能不能碰真实桌面**）。
 *
 * ## 它不隐藏风险
 *
 * 授权确认在**主进程**弹原生对话框（这里只是入口）；每个动作还会再弹一次。
 * 面板上写清"这不是 OS 级沙箱"，不做"看起来很安全"的措辞。
 */

function shell(): ShellBridge | null {
  return (globalThis as { shell?: ShellBridge }).shell ?? null;
}

export function ComputerUseCard() {
  const [status, setStatus] = useState<ComputerStatusView | null>(null);
  const [log, setLog] = useState<ComputerAuditView[]>([]);
  const [note, setNote] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [x, setX] = useState("100");
  const [y, setY] = useState("100");
  const [button, setButton] = useState<"left" | "right">("left");
  const [text, setText] = useState("");
  const [key, setKey] = useState<string>("enter");

  const refresh = async () => {
    const api = shell();
    if (!api?.computer) {
      setNote("这一页要在桌面端打开（浏览器预览里没有电脑操作）。");
      return;
    }
    try {
      const got = await api.computer.status();
      setStatus(got);
      setLog(got.log);
      setNote(got.supported ? "" : `当前平台（${got.platform}）还没有实现电脑操作（目前只有 Windows）`);
    } catch (error) {
      setNote(`读取失败：${String((error as Error)?.message ?? error)}`);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<{ ok: boolean; detail?: string; error?: string; dataUrl?: string }>) => {
    try {
      const got = await fn();
      if (got.ok) {
        setNote(got.detail ?? "完成");
        if (got.dataUrl) setShot(got.dataUrl);
      } else {
        setNote(got.error ?? "没执行");
      }
    } finally {
      void refresh();
    }
  };

  return (
    <section className="wb-card" data-testid="wb-computer" style={{ padding: 12, marginTop: 16 }}>
      <h4 style={{ marginTop: 0 }}>电脑操作（Computer Use）</h4>
      <p className="wb-setpage-note">
        默认关闭。授权后可以截屏、点击、输入；**每个动作都会再弹一次确认**，并且留痕
        （输入的文字不记录）。这不是操作系统级沙箱 —— 操作的是你的真实桌面。
      </p>

      {status ? (
        <p className="wb-card-desc" data-testid="wb-computer-status">
          状态：<strong>{status.enabled ? "已授权" : "未授权"}</strong>　平台：{status.platform}
          {status.supported ? "" : "（未实现）"}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!status?.enabled ? (
          <button
            type="button"
            className="wb-chip"
            data-testid="wb-computer-enable"
            onClick={() => void shell()?.computer?.enable().then(() => refresh())}
          >
            授权电脑操作…
          </button>
        ) : (
          <button
            type="button"
            className="wb-chip"
            data-testid="wb-computer-disable"
            onClick={() => void shell()?.computer?.disable().then(() => refresh())}
          >
            关闭授权
          </button>
        )}
        {status?.enabled && status.supported ? (
          <>
            <button
              type="button"
              className="wb-chip"
              data-testid="wb-computer-screenshot"
              onClick={() => void run(() => shell()!.computer.screenshot())}
            >
              截屏
            </button>
            <label className="wb-card-desc">
              x <input className="wb-input" style={{ width: 64 }} value={x} onChange={(e) => setX(e.target.value)} />
            </label>
            <label className="wb-card-desc">
              y <input className="wb-input" style={{ width: 64 }} value={y} onChange={(e) => setY(e.target.value)} />
            </label>
            <select value={button} onChange={(e) => setButton(e.target.value as "left" | "right")} aria-label="鼠标键">
              <option value="left">左键</option>
              <option value="right">右键</option>
            </select>
            <button
              type="button"
              className="wb-chip"
              data-testid="wb-computer-click"
              onClick={() => void run(() => shell()!.computer.click(Number(x), Number(y), button))}
            >
              点击
            </button>
          </>
        ) : null}
      </div>

      {status?.enabled && status.supported ? (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="wb-input"
              style={{ flex: "1 1 260px" }}
              placeholder="要输入的文字（不记录；单次 ≤4000 字符）"
              value={text}
              data-testid="wb-computer-text"
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="button"
              className="wb-chip"
              data-testid="wb-computer-type"
              onClick={() => void run(() => shell()!.computer.type(text))}
            >
              输入
            </button>
            <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="按键">
              {COMPUTER_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="wb-chip"
              data-testid="wb-computer-key"
              onClick={() => void run(() => shell()!.computer.key(key))}
            >
              按键
            </button>
          </div>
          {shot ? (
            <img
              src={shot}
              alt="最近一次截屏"
              data-testid="wb-computer-shot"
              style={{ maxWidth: "100%", marginTop: 8, border: "1px solid var(--line, #ddd)", borderRadius: 6 }}
            />
          ) : null}
        </>
      ) : null}

      {note ? (
        <p className="wb-setpage-note" data-testid="wb-computer-note">
          {note}
        </p>
      ) : null}

      {log.length ? (
        <details data-testid="wb-computer-log">
          <summary className="wb-card-desc">最近 {log.length} 条操作留痕</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
            {log.map((item, index) => (
              <li key={`${item.at}-${index}`}>
                {new Date(item.at).toISOString().slice(11, 19)}　{item.kind}　{item.ok ? "成功" : "未执行"}　{item.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
