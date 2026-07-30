export const FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX = 120;

const WHEEL_LINE_HEIGHT_PX = 16;
const DEFAULT_PAGE_SIZE_PX = 800;

export function wheelDeltaToPixels(delta: number, deltaMode = 0, pageSize = DEFAULT_PAGE_SIZE_PX) {
  const finiteDelta = Number.isFinite(delta) ? delta : 0;
  if (deltaMode === 1) return finiteDelta * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) {
    const finitePageSize =
      Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE_PX;
    return finiteDelta * finitePageSize;
  }
  return finiteDelta;
}

export function accumulateDirectionalDelta(current: number, delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return current;
  const normalizedCurrent = Number.isFinite(current) ? current : 0;
  const continued = Math.sign(normalizedCurrent) === Math.sign(delta) ? normalizedCurrent : 0;
  return continued + delta;
}

export function canScrollInDirection(
  position: number,
  maxDistance: number,
  delta: number,
  tolerance = 1,
) {
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(maxDistance) ||
    !Number.isFinite(delta) ||
    maxDistance <= tolerance ||
    Math.abs(delta) < 1
  ) {
    return false;
  }
  return delta > 0 ? position < maxDistance - tolerance : position > tolerance;
}
