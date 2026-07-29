export type ReaderTapAction = "prev" | "next" | "toggle-controls";

export interface ReaderTapBounds {
  left: number;
  width: number;
}

export interface ResolveReaderTapActionOptions {
  fraction: number;
  isDoublePage: boolean;
  isFixedLayout?: boolean;
  isScrollMode: boolean;
}

export function getReaderTapThresholds(isDoublePage: boolean, isFixedLayout = false) {
  if (isFixedLayout) {
    return { leftNavEnd: 1 / 3, rightNavStart: 2 / 3 };
  }

  return isDoublePage
    ? { leftNavEnd: 0.33, rightNavStart: 0.67 }
    : { leftNavEnd: 0.4, rightNavStart: 0.6 };
}

export function getRelativeXFraction(clientX: number, bounds: ReaderTapBounds): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(bounds.left) || bounds.width <= 0) {
    return null;
  }

  const fraction = (clientX - bounds.left) / bounds.width;
  return Math.max(0, Math.min(1, fraction));
}

export function resolveReaderTapAction({
  fraction,
  isDoublePage,
  isFixedLayout = false,
  isScrollMode,
}: ResolveReaderTapActionOptions): ReaderTapAction {
  if (isScrollMode) return "toggle-controls";

  const { leftNavEnd, rightNavStart } = getReaderTapThresholds(isDoublePage, isFixedLayout);
  if (fraction > leftNavEnd && fraction < rightNavStart) {
    return "toggle-controls";
  }

  return fraction <= leftNavEnd ? "prev" : "next";
}
