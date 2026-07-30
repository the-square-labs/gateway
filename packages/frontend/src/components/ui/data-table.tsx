import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, type ReactNode, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  /** If true, cell content will truncate with ellipsis */
  truncate?: boolean;
  /** Fixed width (e.g. "100px", "8rem"). Without this, columns share remaining space equally. */
  width?: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface DataTableGroup {
  key: string;
  label: ReactNode;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  keyFn: (row: T) => string;
  onRowClick?: (row: T) => void;
  isRowClickable?: (row: T) => boolean;
  emptyContent?: ReactNode;
  emptyMessage?: string;
  /** Ref for scroll container (for infinite scroll sentinel) */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Extra content at the bottom of the scroll area (e.g. sentinel) */
  footer?: ReactNode;
  /** Group rows by a key. Returns group info or null for ungrouped rows. */
  groupBy?: (row: T) => DataTableGroup | null;
  /** Called when a group header is clicked */
  onGroupClick?: (group: DataTableGroup) => void;
  /** Allow horizontal scrolling when columns exceed the container width */
  horizontalScroll?: boolean;
  /** Minimum table width when horizontalScroll is enabled */
  minWidth?: string;
  /** Remove the outer card chrome when another shared shell owns the border. */
  embedded?: boolean;
}

type FlatItem<T> =
  | { kind: "group"; key: string; group: DataTableGroup }
  | { kind: "row"; key: string; row: T };

const ROW_HEIGHT = 49;
const GROUP_HEIGHT = 41;

export function DataTable<T>({
  columns,
  data,
  keyFn,
  onRowClick,
  isRowClickable,
  emptyContent,
  emptyMessage = "No data.",
  scrollRef,
  footer,
  groupBy,
  onGroupClick,
  horizontalScroll = false,
  minWidth,
  embedded = false,
}: DataTableProps<T>) {
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = scrollRef ?? internalRef;

  // Build the flat row model: walk data once and synthesize group headers
  // whenever the group key changes. This becomes the index space the
  // virtualizer iterates over.
  const items = useMemo<FlatItem<T>[]>(() => {
    const out: FlatItem<T>[] = [];
    let prevGroupKey: string | null = null;
    for (const row of data) {
      const group = groupBy?.(row) ?? null;
      if (group && group.key !== prevGroupKey) {
        out.push({ kind: "group", key: `__group:${group.key}`, group });
        prevGroupKey = group.key;
      } else if (!group) {
        prevGroupKey = null;
      }
      out.push({ kind: "row", key: keyFn(row), row });
    }
    return out;
  }, [data, groupBy, keyFn]);

  const gridTemplateColumns = useMemo(
    () => columns.map((c) => c.width ?? "1fr").join(" "),
    [columns]
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => (items[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  // Re-measure when the row count or composition changes — TanStack handles
  // this automatically via the count change, but we explicitly invalidate the
  // size cache so estimates re-pick the correct kind on group transitions.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer]);

  if (data.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-card py-16",
          !embedded && "rounded-lg border border-border"
        )}
      >
        {emptyContent ?? <p className="text-sm text-muted-foreground">{emptyMessage}</p>}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      className={cn(
        "flex min-h-0 max-h-full flex-col overflow-hidden bg-card",
        !embedded && "rounded-lg border border-border"
      )}
    >
      <div
        ref={containerRef}
        className={`${horizontalScroll ? "overflow-auto" : "overflow-y-auto"} min-h-0 -mb-px`}
      >
        <div
          className={horizontalScroll ? "min-w-max" : ""}
          style={horizontalScroll && minWidth ? { minWidth } : undefined}
        >
          {/* Sticky header — sibling of the virtualized body, sharing the same grid template */}
          <div
            className="sticky top-0 z-10 grid bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground shadow-[inset_0_-1px_0_var(--color-border)]"
            style={{ gridTemplateColumns }}
          >
            {columns.map((col) => (
              <div
                key={col.key}
                className={`${col.align === "right" ? "text-right" : "text-left"} px-4 py-3 font-medium`}
              >
                {col.header}
              </div>
            ))}
          </div>

          {/* Virtualized body */}
          <div style={{ height: totalSize, position: "relative" }}>
            {virtualItems.map((vi) => {
              const item = items[vi.index];
              if (!item) return null;
              const top = vi.start;

              if (item.kind === "group") {
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={vi.index}
                    className={`absolute inset-x-0 grid bg-muted/50 border-b border-border ${
                      onGroupClick ? "cursor-pointer hover:bg-muted transition-colors" : ""
                    }`}
                    style={{
                      transform: `translateY(${top}px)`,
                      gridTemplateColumns: "1fr",
                    }}
                    onClick={onGroupClick ? () => onGroupClick(item.group) : undefined}
                  >
                    <div className="px-4 py-2">{item.group.label}</div>
                  </div>
                );
              }

              const canClick = isRowClickable?.(item.row) ?? !!onRowClick;

              return (
                <Fragment key={item.key}>
                  <div
                    ref={virtualizer.measureElement}
                    data-index={vi.index}
                    className={`absolute inset-x-0 grid items-center border-b border-border transition-colors ${
                      canClick ? "cursor-pointer hover:bg-accent" : ""
                    }`}
                    style={{
                      transform: `translateY(${top}px)`,
                      gridTemplateColumns,
                    }}
                    onClick={canClick && onRowClick ? () => onRowClick(item.row) : undefined}
                  >
                    {columns.map((col) => (
                      <div
                        key={col.key}
                        className={`min-w-0 overflow-hidden px-4 py-3 text-sm ${col.align === "right" ? "text-right" : ""} ${
                          col.truncate ? "text-ellipsis whitespace-nowrap" : ""
                        } ${col.className ?? ""}`}
                      >
                        {col.render(item.row)}
                      </div>
                    ))}
                  </div>
                </Fragment>
              );
            })}
          </div>
          {footer}
        </div>
      </div>
    </div>
  );
}
