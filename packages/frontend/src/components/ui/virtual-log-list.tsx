import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface VirtualLogListProps<T> {
  lines: T[];
  /** Render one line into a row's content. Wrap your own per-row styling here. */
  renderLine: (line: T, index: number) => ReactNode;
  keyFn: (line: T, index: number) => string | number;
  /** Increment when older history has been prepended to lines. */
  prependVersion?: number;
  /** Estimated row height in pixels (default 18 — matches `text-xs leading-5`) */
  estimateLineHeight?: number;
  /** Called when the user scrolls near the top — page in older history. */
  onLoadMore?: () => void;
  /** Whether more history is available; gates onLoadMore. */
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Forced empty state shown when lines.length === 0. */
  emptyState?: ReactNode;
  /** Scroll to the newest line when this viewport first receives content. */
  initialScrollToEnd?: boolean;
  className?: string;
}

const BOTTOM_THRESHOLD = 40;
const TOP_LOAD_THRESHOLD = 20;

export function VirtualLogList<T>({
  lines,
  renderLine,
  keyFn,
  prependVersion = 0,
  estimateLineHeight = 18,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  emptyState,
  initialScrollToEnd = false,
  className,
}: VirtualLogListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  /**
   * Snapshot taken before lines change so we can preserve the user's
   * apparent scroll position when older history is prepended.
   */
  const prependFix = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const getRowsHeight = useCallback(() => {
    const rowsHeight = rowsRef.current?.offsetHeight ?? 0;
    return rowsHeight > 0 ? rowsHeight : (scrollRef.current?.scrollHeight ?? 0);
  }, []);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateLineHeight,
    overscan: 30,
    getItemKey: (index) => keyFn(lines[index], index),
  });

  // Track whether the viewport is glued to the bottom. Update on every scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
      isAtBottomRef.current = atBottom;
      // Trigger load-more when the topmost virtual item is close to index 0
      if (hasMore && !loadingMore && onLoadMore) {
        const items = virtualizer.getVirtualItems();
        if (items.length > 0 && items[0].index < TOP_LOAD_THRESHOLD) {
          // Snapshot scroll geometry so we can compensate after the prepend
          prependFix.current = {
            prevHeight: getRowsHeight(),
            prevTop: el.scrollTop,
          };
          onLoadMore();
        }
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [getRowsHeight, hasMore, loadingMore, onLoadMore, virtualizer]);

  // Auto-follow: when new lines append AND we were at the bottom, stick.
  // When older lines prepend, restore the user's apparent scroll position.
  const prevLineCountRef = useRef(lines.length);
  const prevPrependVersionRef = useRef(prependVersion);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = prevLineCountRef.current;
    const cur = lines.length;
    prevLineCountRef.current = cur;
    const didPrepend = prependVersion !== prevPrependVersionRef.current;
    prevPrependVersionRef.current = prependVersion;

    if (initialScrollToEnd && !initialScrollDoneRef.current && cur > 0) {
      initialScrollDoneRef.current = true;
      isAtBottomRef.current = true;
      virtualizer.scrollToIndex(cur - 1, { align: "end" });
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
      return;
    }

    if (didPrepend && prependFix.current) {
      // History was prepended — keep the viewport visually pinned where it was
      const fix = prependFix.current;
      prependFix.current = null;
      const delta = getRowsHeight() - fix.prevHeight;
      el.scrollTop = fix.prevTop + delta;
      return;
    }

    if (!didPrepend && prependFix.current) {
      prependFix.current = {
        prevHeight: getRowsHeight(),
        prevTop: el.scrollTop,
      };
    }

    if (cur > prev && isAtBottomRef.current && cur > 0) {
      // New tail — keep the bottom glued. Use the virtualizer API so it
      // handles deferred row measurement; fall back to a brute-force
      // scrollTop = scrollHeight on the next two frames in case the
      // virtualizer hasn't materialized the final row yet.
      virtualizer.scrollToIndex(cur - 1, { align: "end" });
      requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          if (!isAtBottomRef.current) return;
          el.scrollTop = el.scrollHeight;
        });
      });
    }

    if (cur === 0) {
      isAtBottomRef.current = true;
    }
  }, [getRowsHeight, initialScrollToEnd, lines.length, prependVersion, virtualizer]);

  if (lines.length === 0 && emptyState) {
    return (
      <div ref={scrollRef} className={className ?? "flex-1 min-h-0 overflow-auto"}>
        {emptyState}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div ref={scrollRef} className={className ?? "flex-1 min-h-0 overflow-auto"}>
      {loadingMore && hasMore && (
        <div className="text-center text-xs text-muted-foreground py-2">Loading more…</div>
      )}
      <div ref={rowsRef} style={{ height: totalSize, position: "relative" }}>
        {virtualItems.map((vi) => {
          const line = lines[vi.index];
          if (line === undefined) return null;
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {renderLine(line, vi.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
