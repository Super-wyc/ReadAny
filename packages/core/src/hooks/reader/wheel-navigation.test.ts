import { describe, expect, it } from "vitest";
import {
  FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX,
  accumulateDirectionalDelta,
  canScrollInDirection,
  wheelDeltaToPixels,
} from "./wheel-navigation";

describe("wheel navigation", () => {
  it("normalizes line and page wheel deltas to pixels", () => {
    expect(wheelDeltaToPixels(2, 0)).toBe(2);
    expect(wheelDeltaToPixels(2, 1)).toBe(32);
    expect(wheelDeltaToPixels(1, 2, 640)).toBe(640);
  });

  it("requires accumulated movement to reach the fixed-layout edge threshold", () => {
    let accumulated = 0;
    accumulated = accumulateDirectionalDelta(accumulated, 40);
    expect(Math.abs(accumulated)).toBeLessThan(FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX);
    accumulated = accumulateDirectionalDelta(accumulated, 80);
    expect(Math.abs(accumulated)).toBe(FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX);
  });

  it("starts a new accumulation when the wheel direction changes", () => {
    expect(accumulateDirectionalDelta(90, -20)).toBe(-20);
    expect(accumulateDirectionalDelta(-90, 20)).toBe(20);
  });

  it("detects whether an overflowing page can keep scrolling in the requested direction", () => {
    expect(canScrollInDirection(300, 1000, 50)).toBe(true);
    expect(canScrollInDirection(1000, 1000, 50)).toBe(false);
    expect(canScrollInDirection(300, 1000, -50)).toBe(true);
    expect(canScrollInDirection(0, 1000, -50)).toBe(false);
  });

  it("does not treat a non-overflowing axis as scrollable", () => {
    expect(canScrollInDirection(0, 0, 50)).toBe(false);
    expect(canScrollInDirection(0, 0.5, 50)).toBe(false);
  });
});
