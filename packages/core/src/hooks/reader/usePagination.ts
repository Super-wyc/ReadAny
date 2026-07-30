/**
 * usePagination — handles page flip and scroll navigation via
 * mouse events from the host container and iframe bridge.
 *
 * Strategy: Leading-edge throttle with "idle unlock".
 */
import { useCallback, useEffect, useRef } from "react";
import type { FoliateView } from "./useFoliateView";
import {
  FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX,
  accumulateDirectionalDelta,
  canScrollInDirection,
  wheelDeltaToPixels,
} from "./wheel-navigation";

interface UsePaginationOptions {
  bookKey: string;
  viewRef: React.RefObject<FoliateView | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isFixedLayout?: boolean;
}

/** Minimum cooldown after a page turn (ms) */
const WHEEL_MIN_COOLDOWN_MS = 350;

/** After the last wheel event, wait this long before unlocking (ms). */
const WHEEL_IDLE_MS = 200;

/** The first fixed-layout edge gesture must settle before paging is armed. */
const FIXED_LAYOUT_EDGE_ARM_IDLE_MS = 150;

/** Forget partial edge pressure after this idle gap (ms). */
const FIXED_LAYOUT_EDGE_RESET_MS = 250;

/** Prevent one unusually large wheel event from satisfying the whole edge threshold. */
const FIXED_LAYOUT_EDGE_EVENT_CAP_PX = 80;

type FixedLayoutScrollResult = "not-applicable" | "scrolled" | "edge";

function getScrollableDistance(element: HTMLElement, axis: "x" | "y") {
  return axis === "x"
    ? Math.max(0, element.scrollWidth - element.clientWidth)
    : Math.max(0, element.scrollHeight - element.clientHeight);
}

function scrollFixedLayoutPage(
  view: FoliateView,
  deltaY: number,
  deltaX = 0,
): FixedLayoutScrollResult {
  const renderer = view.renderer as HTMLElement | undefined;
  if (!renderer) return "not-applicable";

  const maxY = getScrollableDistance(renderer, "y");
  const maxX = getScrollableDistance(renderer, "x");
  const canScrollY = canScrollInDirection(renderer.scrollTop, maxY, deltaY);
  const canScrollX = canScrollInDirection(renderer.scrollLeft, maxX, deltaX);
  if (!canScrollY && !canScrollX) return "edge";

  renderer.scrollBy({
    top: canScrollY ? deltaY : 0,
    left: canScrollX ? deltaX : 0,
    behavior: "auto",
  });
  return "scrolled";
}

export function usePagination({
  bookKey,
  viewRef,
  containerRef,
  isFixedLayout = false,
}: UsePaginationOptions) {
  const wheelLocked = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTime = useRef(0);
  const fixedLayoutEdgeDelta = useRef(0);
  const fixedLayoutEdgeArmed = useRef(false);
  const fixedLayoutEdgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetFixedLayoutEdge = useCallback(() => {
    fixedLayoutEdgeDelta.current = 0;
    fixedLayoutEdgeArmed.current = false;
    if (fixedLayoutEdgeTimer.current) {
      clearTimeout(fixedLayoutEdgeTimer.current);
      fixedLayoutEdgeTimer.current = null;
    }
  }, []);

  const scheduleWheelUnlock = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      const elapsed = Date.now() - lockTime.current;
      if (elapsed >= WHEEL_MIN_COOLDOWN_MS) {
        wheelLocked.current = false;
        idleTimer.current = null;
      } else {
        idleTimer.current = setTimeout(() => {
          wheelLocked.current = false;
          idleTimer.current = null;
        }, WHEEL_MIN_COOLDOWN_MS - elapsed);
      }
    }, WHEEL_IDLE_MS);
  }, []);

  const handleWheel = useCallback(
    (deltaY: number, deltaX = 0, deltaMode = 0) => {
      const view = viewRef.current;
      if (!view) return;

      if (view.renderer?.scrolled) return;

      const renderer = view.renderer as HTMLElement | undefined;
      const pixelDeltaY = wheelDeltaToPixels(deltaY, deltaMode, renderer?.clientHeight);
      const pixelDeltaX = wheelDeltaToPixels(deltaX, deltaMode, renderer?.clientWidth);
      const absDY = Math.abs(pixelDeltaY);
      const absDX = Math.abs(pixelDeltaX);
      if (absDY < 2 && absDX < 2) return;

      const fixedLayoutScroll = isFixedLayout
        ? scrollFixedLayoutPage(view, pixelDeltaY, pixelDeltaX)
        : "not-applicable";
      if (fixedLayoutScroll === "scrolled") {
        resetFixedLayoutEdge();
        return;
      }

      if (wheelLocked.current) {
        resetFixedLayoutEdge();
        scheduleWheelUnlock();
        return;
      }

      const dominantDelta = absDY >= absDX ? pixelDeltaY : pixelDeltaX;
      if (fixedLayoutScroll === "edge") {
        if (!fixedLayoutEdgeArmed.current) {
          if (fixedLayoutEdgeTimer.current) clearTimeout(fixedLayoutEdgeTimer.current);
          fixedLayoutEdgeTimer.current = setTimeout(() => {
            fixedLayoutEdgeArmed.current = true;
            fixedLayoutEdgeTimer.current = null;
          }, FIXED_LAYOUT_EDGE_ARM_IDLE_MS);
          return;
        }

        const cappedDominantDelta =
          Math.sign(dominantDelta) *
          Math.min(Math.abs(dominantDelta), FIXED_LAYOUT_EDGE_EVENT_CAP_PX);
        fixedLayoutEdgeDelta.current = accumulateDirectionalDelta(
          fixedLayoutEdgeDelta.current,
          cappedDominantDelta,
        );
        if (fixedLayoutEdgeTimer.current) clearTimeout(fixedLayoutEdgeTimer.current);
        fixedLayoutEdgeTimer.current = setTimeout(() => {
          fixedLayoutEdgeDelta.current = 0;
          fixedLayoutEdgeTimer.current = null;
        }, FIXED_LAYOUT_EDGE_RESET_MS);
        if (Math.abs(fixedLayoutEdgeDelta.current) < FIXED_LAYOUT_EDGE_TURN_THRESHOLD_PX) {
          return;
        }
        resetFixedLayoutEdge();
      } else {
        resetFixedLayoutEdge();
      }

      let direction: "next" | "prev";
      if (absDY >= absDX) {
        direction = pixelDeltaY > 0 ? "next" : "prev";
      } else {
        direction = pixelDeltaX > 0 ? "next" : "prev";
      }

      if (direction === "next") {
        view.next();
      } else {
        view.prev();
      }

      wheelLocked.current = true;
      lockTime.current = Date.now();
      scheduleWheelUnlock();
    },
    [isFixedLayout, resetFixedLayoutEdge, scheduleWheelUnlock, viewRef],
  );

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (fixedLayoutEdgeTimer.current) clearTimeout(fixedLayoutEdgeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data?.type || data.bookKey !== bookKey) return;

      switch (data.type) {
        case "iframe-wheel":
          if (viewRef.current?.renderer?.scrolled) return;
          handleWheel(data.deltaY, data.deltaX, data.deltaMode);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [bookKey, handleWheel, viewRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (viewRef.current?.renderer?.scrolled) return;
      e.preventDefault();
      handleWheel(e.deltaY, e.deltaX, e.deltaMode);
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [containerRef, handleWheel, viewRef]);

  return { handleWheel };
}
