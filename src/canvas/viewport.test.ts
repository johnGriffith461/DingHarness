import { describe, expect, it } from "vitest";
import {
  clientToFlowPosition,
  clientToScreenPosition,
  flowToScreenPosition,
  fromTransform,
  screenToFlowPosition,
  snapToGridPosition,
  toTransform,
} from "./viewport";

const IDENTITY = { x: 0, y: 0, zoom: 1 } as const;
const ZOOMED = { x: 0, y: 0, zoom: 2 } as const;

describe("viewport 与 xyflow 元组互转", () => {
  it("对象转元组，元组转回对象", () => {
    expect(toTransform({ x: -12, y: 34, zoom: 1.5 })).toEqual([-12, 34, 1.5]);
    expect(fromTransform([-12, 34, 1.5])).toEqual({ x: -12, y: 34, zoom: 1.5 });
  });
});

describe("screenToFlowPosition", () => {
  it("恒等变换下世界坐标 = 屏幕坐标", () => {
    expect(screenToFlowPosition({ x: 128, y: 64 }, IDENTITY)).toEqual({ x: 128, y: 64 });
  });

  it("缩放时屏幕像素按比例折算回世界坐标", () => {
    expect(screenToFlowPosition({ x: 200, y: 100 }, ZOOMED)).toEqual({ x: 100, y: 50 });
  });

  it("平移量与缩放量叠加（x 先减平移再除缩放）", () => {
    expect(screenToFlowPosition({ x: 200, y: 140 }, { x: 120, y: 40, zoom: 2 })).toEqual({
      x: 40,
      y: 50,
    });
  });
});

describe("flowToScreenPosition", () => {
  it("与 screenToFlowPosition 互为逆运算", () => {
    const transform = { x: -37, y: 91, zoom: 1.75 };
    const world = { x: 512, y: -64 };
    const roundTrip = screenToFlowPosition(flowToScreenPosition(world, transform), transform);
    expect(roundTrip.x).toBeCloseTo(world.x, 6);
    expect(roundTrip.y).toBeCloseTo(world.y, 6);
  });

  it("缩放放大后同一世界点的屏幕距离等比放大", () => {
    expect(flowToScreenPosition({ x: 100, y: 50 }, ZOOMED)).toEqual({ x: 200, y: 100 });
  });
});

describe("clientToScreenPosition", () => {
  it("扣除容器在页面中的偏移", () => {
    expect(clientToScreenPosition({ x: 400, y: 300 }, { left: 320, top: 36 })).toEqual({
      x: 80,
      y: 264,
    });
  });

  it("容器 rect 取不到时按贴齐左上角处理", () => {
    expect(clientToScreenPosition({ x: 12, y: 34 }, null)).toEqual({ x: 12, y: 34 });
  });
});

describe("clientToFlowPosition", () => {
  it("连贯整条链路：客户端坐标 → 容器内坐标 → 世界坐标", () => {
    const result = clientToFlowPosition({ x: 500, y: 260 }, { left: 320, top: 36 }, { x: 60, y: 0, zoom: 2 });
    expect(result).toEqual({ x: 60, y: 112 });
  });
});

describe("snapToGridPosition", () => {
  it("按网格四舍五入到最近的格点", () => {
    expect(snapToGridPosition({ x: 17, y: 30 }, [16, 16])).toEqual({ x: 16, y: 32 });
    expect(snapToGridPosition({ x: -5, y: 8 }, [16, 16])).toEqual({ x: -0, y: 16 });
  });
});
