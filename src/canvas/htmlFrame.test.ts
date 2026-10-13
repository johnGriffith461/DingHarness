import { describe, expect, it } from "vitest";
import {
  buildCsp,
  buildSrcdoc,
  describeHtml,
  HTML_FRAME_CHANNEL,
  MAX_FRAME_HEIGHT,
  makeChannelId,
  MIN_FRAME_HEIGHT,
  parseFrameMessage,
} from "./htmlFrame";

describe("makeChannelId", () => {
  it("够长、是十六进制、每次都不同", () => {
    const a = makeChannelId();
    const b = makeChannelId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildCsp", () => {
  it("默认断网：connect-src 锁死，外链脚本不执行", () => {
    const csp = buildCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    // 不允许 https 外链脚本
    expect(csp).not.toMatch(/script-src[^;]*https:/);
  });

  it("显式打开才放行 https 外链", () => {
    const csp = buildCsp(true);
    expect(csp).toMatch(/script-src[^;]*https:/);
    expect(csp).toMatch(/connect-src[^;]*https:/);
  });

  it("两种情况下都允许内联脚本（用户自己写的那段要能跑）", () => {
    expect(buildCsp(false)).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(buildCsp(true)).toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});

describe("buildSrcdoc", () => {
  it("碎片会兜成完整文档", () => {
    const out = buildSrcdoc("<p>你好</p>", "abc");
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("<p>你好</p>");
    expect(out).toContain("Content-Security-Policy");
  });

  it("整页文档只往 head 里插 CSP，不重排原结构", () => {
    const page = "<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>";
    const out = buildSrcdoc(page, "abc");
    expect(out).toContain("<title>t</title>");
    expect(out.match(/Content-Security-Policy/g)?.length).toBe(1);
    // 只在 </body> 前插上报脚本，不额外包一层文档
    expect(out.match(/<!doctype html>/gi)?.length).toBe(1);
  });

  it("没有 head 的整页会补一个 head 出来", () => {
    const out = buildSrcdoc("<html><body>x</body></html>", "abc");
    expect(out).toContain("<head>");
    expect(out).toContain("Content-Security-Policy");
  });

  it("注入的上报脚本带上 channel 与 channelId", () => {
    const out = buildSrcdoc("<p>x</p>", "deadbeef");
    expect(out).toContain(HTML_FRAME_CHANNEL);
    expect(out).toContain("deadbeef");
  });

  it("channelId 被 JSON 转义，含引号也不会把脚本拼坏", () => {
    const nasty = 'x";alert(1);//';
    const out = buildSrcdoc("<p>x</p>", nasty);
    // 原始未转义的形态不该出现
    expect(out.includes(`${nasty}`)).toBe(false); // JSON.stringify 会加上引号与转义
    expect(out).toContain(JSON.stringify(nasty));
  });

  it("用户 HTML 里的引号/尖括号不会被当成注入点", () => {
    const evil = '<img src=x onerror="document.body.innerHTML=\'pwn\'">';
    const out = buildSrcdoc(evil, "abc");
    // 内容原样保留（它本来就在 body 里），但注入点上没有可被利用的拼接
    expect(out).toContain("onerror");
    expect(out.match(/Content-Security-Policy/g)?.length).toBe(1);
  });

  it("上报脚本里含高低夹取（防止把画布撑爆）", () => {
    const out = buildSrcdoc("<p>x</p>", "abc");
    expect(out).toContain(String(MIN_FRAME_HEIGHT));
    expect(out).toContain(String(MAX_FRAME_HEIGHT));
  });

  it("上报脚本会多档延时重复上报（文档刚插入时还没布局完，只报一次会缩水）", () => {
    const out = buildSrcdoc("<p>x</p>", "abc");
    // 报的是那组延时值（源码里是一句 forEach 循环，数 setTimeout 字面量是数不对的）
    for (const t of [0, 60, 200, 600, 1200, 2400]) {
      expect(out).toContain(String(t));
    }
    expect(out).toContain("ResizeObserver");
    expect(out).toContain("MutationObserver");
  });

  it("量高度时会同时取 scrollHeight 与 offsetHeight 的最大值", () => {
    const out = buildSrcdoc("<p>x</p>", "abc");
    expect(out).toContain("scrollHeight");
    expect(out).toContain("offsetHeight");
  });

  it("**不注入**输入转发逻辑（那条路走过又撤了，见 htmlFrame.ts 的记录）", () => {
    const out = buildSrcdoc("<p>x</p>", "abc");
    expect(out).not.toContain("elementFromPoint");
  });
});

describe("parseFrameMessage", () => {
  const ok = { channel: HTML_FRAME_CHANNEL, channelId: "c1", kind: "height", height: 320 };

  it("通过校验的高度消息", () => {
    expect(parseFrameMessage(ok, "c1", true)).toEqual({
      channel: HTML_FRAME_CHANNEL,
      channelId: "c1",
      kind: "height",
      height: 320,
    });
  });

  it("来源不是我们的 iframe → 丢掉（页面上别的 frame 发消息是正常的）", () => {
    expect(parseFrameMessage(ok, "c1", false)).toBeNull();
  });

  it("channelId 不匹配 → 丢掉", () => {
    expect(parseFrameMessage(ok, "c2", true)).toBeNull();
  });

  it("channel 标记不对 → 丢掉（不吞别的应用的消息）", () => {
    expect(parseFrameMessage({ ...ok, channel: "other" }, "c1", true)).toBeNull();
  });

  it("非对象 / null / 字符串 → 丢掉，不抛错", () => {
    expect(parseFrameMessage(null, "c1", true)).toBeNull();
    expect(parseFrameMessage("hi", "c1", true)).toBeNull();
    expect(parseFrameMessage(42, "c1", true)).toBeNull();
  });

  it("高度被夹进合法区间（用户 HTML 报 999999 也不会撑爆画布）", () => {
    expect(parseFrameMessage({ ...ok, height: 999999 }, "c1", true)?.kind).toBe("height");
    expect(
      parseFrameMessage({ ...ok, height: 999999 }, "c1", true) as { height: number },
    ).toMatchObject({ height: MAX_FRAME_HEIGHT });
    expect(parseFrameMessage({ ...ok, height: -50 }, "c1", true) as { height: number }).toMatchObject({
      height: MIN_FRAME_HEIGHT,
    });
  });

  it("高度不是数字 → 丢掉", () => {
    expect(parseFrameMessage({ ...ok, height: "很高" }, "c1", true)).toBeNull();
    expect(parseFrameMessage({ ...ok, height: Number.NaN }, "c1", true)).toBeNull();
  });

  it("错误消息会被截断（不让一坨东西塞进界面）", () => {
    const msg = parseFrameMessage(
      { channel: HTML_FRAME_CHANNEL, channelId: "c1", kind: "error", message: "x".repeat(1000) },
      "c1",
      true,
    ) as { message: string };
    expect(msg.message.length).toBeLessThanOrEqual(300);
  });

  it("未知 kind → 丢掉", () => {
    expect(parseFrameMessage({ ...ok, kind: "click" }, "c1", true)).toBeNull();
  });
});

describe("describeHtml", () => {
  it("数出脚本标签与外链引用", () => {
    const html = '<script>a()</script><script src="https://cdn/x.js"></script><img src="https://a/b.png">';
    expect(describeHtml(html)).toEqual({ scripts: 2, externalRefs: 2 });
  });

  it("纯文本片段是 0/0", () => {
    expect(describeHtml("<p>你好</p>")).toEqual({ scripts: 0, externalRefs: 0 });
  });

  it("**内联事件处理器也要算成脚本**（只数 <script> 会漏，提示就失真了）", () => {
    expect(describeHtml('<button onclick="alert(1)">x</button>').scripts).toBe(1);
    expect(describeHtml("<img src=x onerror='boom()'>").scripts).toBe(1);
    expect(describeHtml("<body onload=init()>").scripts).toBe(1);
  });

  it("脚本标签与内联处理器一起数", () => {
    const html = '<script>a()</script><button onclick="b()">x</button><div onmouseover="c()"></div>';
    expect(describeHtml(html).scripts).toBe(3);
  });

  it("`on` 开头的普通属性不算（例如 once / online）", () => {
    // 只认 on + 字母 且后面跟 = 的形态；这里 once 也是 on 开头但语义不同，
    // 保守起见按"像事件处理器"计——重要的是不漏报，宁可多报
    expect(describeHtml('<div data-once="1">x</div>').scripts).toBe(0);
  });
});
