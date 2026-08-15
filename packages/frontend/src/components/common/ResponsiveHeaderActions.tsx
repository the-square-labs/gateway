import { EllipsisVertical } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRegisterCommandPalettePageActions } from "@/hooks/use-command-palette-page-actions";

export interface ResponsiveHeaderAction {
  id?: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

const MIN_HEADER_CONTENT_WIDTH_PX = 320;
const HEADER_ACTION_GAP_PX = 8;

export function getHeaderActionOverflowCount(
  headerWidth: number,
  actionWidths: number[],
  overflowWidth: number,
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX,
  gapWidth = HEADER_ACTION_GAP_PX
): number {
  if (
    headerWidth <= 0 ||
    overflowWidth <= 0 ||
    actionWidths.length === 0 ||
    actionWidths.some((width) => width <= 0)
  ) {
    return 0;
  }

  const availableWidth = headerWidth - reservedContentWidth;
  const fullWidth =
    actionWidths.reduce((total, width) => total + width, 0) +
    Math.max(0, actionWidths.length - 1) * gapWidth;

  if (fullWidth <= availableWidth) return 0;

  for (let overflowCount = 1; overflowCount <= actionWidths.length; overflowCount += 1) {
    const visibleWidths = actionWidths.slice(overflowCount);
    const visibleWidth = visibleWidths.reduce((total, width) => total + width, 0);
    const renderedItemCount = visibleWidths.length + 1;
    const requiredWidth =
      overflowWidth + visibleWidth + Math.max(0, renderedItemCount - 1) * gapWidth;

    if (requiredWidth <= availableWidth) return overflowCount;
  }

  return actionWidths.length;
}

export function shouldCollapseHeaderActions(
  headerWidth: number,
  actionsWidth: number,
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX
): boolean {
  return headerWidth > 0 && actionsWidth > 0 && headerWidth < actionsWidth + reservedContentWidth;
}

export function HeaderOverflowMenu({
  actions,
  disabled = false,
  ariaLabel = "More page actions",
}: {
  actions: ResponsiveHeaderAction[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" disabled={disabled} aria-label={ariaLabel}>
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action, index) => (
          <ResponsiveHeaderActionItem
            key={action.id ?? `${action.label}:${index}`}
            action={action}
            showSeparator={index > 0 && action.separatorBefore}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ResponsiveHeaderActions({
  children,
  actions,
  className = "",
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX,
}: {
  children: ReactNode;
  actions: ResponsiveHeaderAction[];
  className?: string;
  reservedContentWidth?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const overflowMeasureRef = useRef<HTMLDivElement>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  const actionChildren = useMemo(() => flattenActionChildren(children), [children]);
  const actionSignature = actions.map((action) => `${action.id ?? ""}:${action.label}`).join("|");
  const effectiveOverflowCount = Math.min(overflowCount, actionChildren.length);
  const overflowActions =
    effectiveOverflowCount === actionChildren.length
      ? actions
      : actions.slice(0, effectiveOverflowCount);

  useRegisterCommandPalettePageActions(
    actions.map((action, index) => ({
      id:
        action.id ??
        `header:${action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "action"}:${index}`,
      label: action.label,
      icon: action.icon,
      action: action.onClick,
      disabled: action.disabled,
    }))
  );

  useLayoutEffect(() => {
    if (!actionSignature) return;

    const root = rootRef.current;
    const header = root?.parentElement;
    if (!root || !header) return;

    const updateLayout = () => {
      const actionWidths = Array.from(
        actionsRef.current?.querySelectorAll<HTMLElement>("[data-header-action-item]") ?? []
      ).map((element) => element.getBoundingClientRect().width);
      const overflowWidth = overflowMeasureRef.current?.getBoundingClientRect().width ?? 0;
      const measuredGap = Number.parseFloat(
        actionsRef.current ? window.getComputedStyle(actionsRef.current).columnGap : ""
      );
      const nextOverflowCount = getHeaderActionOverflowCount(
        header.getBoundingClientRect().width,
        actionWidths,
        overflowWidth,
        reservedContentWidth,
        Number.isFinite(measuredGap) ? measuredGap : HEADER_ACTION_GAP_PX
      );
      setOverflowCount((current) => (current === nextOverflowCount ? current : nextOverflowCount));
    };

    updateLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateLayout);
    observer.observe(header);
    if (overflowMeasureRef.current) observer.observe(overflowMeasureRef.current);
    for (const element of actionsRef.current?.children ?? []) observer.observe(element);
    return () => observer.disconnect();
  }, [actionSignature, reservedContentWidth]);

  if (actions.length === 0) return null;

  return (
    <div ref={rootRef} className="ml-auto flex shrink-0 self-center">
      <div ref={actionsRef} className={`flex items-center gap-2 ${className}`}>
        {actionChildren.map((child, index) => {
          const isOverflowed = index < effectiveOverflowCount;
          return (
            <div
              key={actions[index]?.id ?? actions[index]?.label ?? index}
              data-header-action-item=""
              aria-hidden={isOverflowed || undefined}
              className={
                isOverflowed
                  ? "pointer-events-none fixed -left-full top-0 invisible w-max"
                  : "shrink-0"
              }
            >
              {child}
            </div>
          );
        })}
        {effectiveOverflowCount > 0 ? (
          <HeaderOverflowMenu actions={overflowActions} ariaLabel="Page actions" />
        ) : null}
      </div>
      <div
        ref={overflowMeasureRef}
        data-header-overflow-measure=""
        aria-hidden="true"
        className="pointer-events-none fixed -left-full top-0 invisible w-max"
      >
        <Button variant="outline" size="icon" tabIndex={-1}>
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function flattenActionChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return flattenActionChildren(child.props.children);
    }
    return [child];
  });
}

function ResponsiveHeaderActionItem({
  action,
  showSeparator = action.separatorBefore,
}: {
  action: ResponsiveHeaderAction;
  showSeparator?: boolean;
}) {
  return (
    <>
      {showSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        disabled={action.disabled}
        title={action.disabled ? action.disabledReason : undefined}
        onClick={action.onClick}
        className={action.destructive ? "text-destructive" : undefined}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
}
