import { describe, expect, it } from "vitest";
import {
  getReaderTapThresholds,
  getRelativeXFraction,
  resolveReaderTapAction,
} from "./tap-navigation";

describe("reader tap navigation", () => {
  it("uses the expected navigation zones for single and double page layouts", () => {
    expect(getReaderTapThresholds(false)).toEqual({
      leftNavEnd: 0.4,
      rightNavStart: 0.6,
    });
    expect(getReaderTapThresholds(true)).toEqual({
      leftNavEnd: 0.33,
      rightNavStart: 0.67,
    });
    expect(getReaderTapThresholds(true, true)).toEqual({
      leftNavEnd: 1 / 3,
      rightNavStart: 2 / 3,
    });
  });

  it("keeps paginated side taps as navigation actions", () => {
    expect(
      resolveReaderTapAction({
        fraction: 0.2,
        isDoublePage: false,
        isScrollMode: false,
      }),
    ).toBe("prev");
    expect(
      resolveReaderTapAction({
        fraction: 0.8,
        isDoublePage: false,
        isScrollMode: false,
      }),
    ).toBe("next");
    expect(
      resolveReaderTapAction({
        fraction: 0.5,
        isDoublePage: false,
        isScrollMode: false,
      }),
    ).toBe("toggle-controls");
  });

  it("splits fixed-layout taps into equal previous, controls, and next zones", () => {
    expect(
      resolveReaderTapAction({
        fraction: 0.32,
        isDoublePage: true,
        isFixedLayout: true,
        isScrollMode: false,
      }),
    ).toBe("prev");
    expect(
      resolveReaderTapAction({
        fraction: 0.68,
        isDoublePage: true,
        isFixedLayout: true,
        isScrollMode: false,
      }),
    ).toBe("next");
    expect(
      resolveReaderTapAction({
        fraction: 0.34,
        isDoublePage: true,
        isFixedLayout: true,
        isScrollMode: false,
      }),
    ).toBe("toggle-controls");
    expect(
      resolveReaderTapAction({
        fraction: 0.66,
        isDoublePage: true,
        isFixedLayout: true,
        isScrollMode: false,
      }),
    ).toBe("toggle-controls");
  });

  it("only toggles controls in scroll mode", () => {
    expect(
      resolveReaderTapAction({
        fraction: 0.1,
        isDoublePage: true,
        isScrollMode: true,
      }),
    ).toBe("toggle-controls");
    expect(
      resolveReaderTapAction({
        fraction: 0.9,
        isDoublePage: true,
        isFixedLayout: true,
        isScrollMode: true,
      }),
    ).toBe("toggle-controls");
  });

  it("computes shell click positions relative to the reader instead of the window", () => {
    expect(getRelativeXFraction(320, { left: 240, width: 800 })).toBeCloseTo(0.1);
    expect(getRelativeXFraction(1040, { left: 240, width: 800 })).toBe(1);
    expect(getRelativeXFraction(120, { left: 240, width: 800 })).toBe(0);
    expect(getRelativeXFraction(320, { left: 240, width: 0 })).toBeNull();
  });
});
