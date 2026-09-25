import { AlertTriangle, ArrowRight } from "lucide-react";
import type { ComponentProps, ElementType, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export type DashboardNoticeTone = "destructive" | "warning" | "info";

const TONE_CLASSES: Record<DashboardNoticeTone, { border: string; text: string }> = {
  destructive: { border: "border-destructive/60", text: "text-destructive" },
  warning: { border: "border-warning/60", text: "text-warning" },
  info: { border: "border-link/55", text: "text-link" },
};

/** A dashboard banner: an icon, a coloured title, a summary and actions on the right. */
export function DashboardNotice({
  tone,
  icon: Icon = AlertTriangle,
  title,
  children,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  tone: DashboardNoticeTone;
  icon?: ElementType;
  title: ReactNode;
  /** Summary lines under the title. */
  children?: ReactNode;
  /** Usually one or more `DashboardNoticeAction`. */
  actions?: ReactNode;
}) {
  const toneClasses = TONE_CLASSES[tone];
  return (
    <div className={cn("border bg-card", toneClasses.border, className)} {...props}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className={cn("h-4 w-4 shrink-0", toneClasses.text)} />
          <div className="min-w-0">
            <p className={cn("text-sm font-semibold", toneClasses.text)}>{title}</p>
            {children}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
      </div>
    </div>
  );
}

const actionClassName = "flex shrink-0 items-center gap-1 text-sm font-medium hover:underline";

/**
 * A text action of a notice: a link when `to` is set, otherwise a button. It
 * reads as part of the banner rather than as a separate button.
 */
export function DashboardNoticeAction({
  tone,
  children,
  to,
  state,
  onClick,
  disabled,
  muted = false,
  arrow = true,
}: {
  tone: DashboardNoticeTone;
  children: ReactNode;
  to?: string;
  state?: unknown;
  onClick?: () => void;
  disabled?: boolean;
  /** A secondary action, such as Hide, in the muted text colour. */
  muted?: boolean;
  arrow?: boolean;
}) {
  const className = cn(
    actionClassName,
    muted ? "text-muted-foreground hover:text-foreground" : TONE_CLASSES[tone].text,
    "disabled:pointer-events-none disabled:opacity-50"
  );
  const content = (
    <>
      {children}
      {arrow ? <ArrowRight className="h-3.5 w-3.5" /> : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} state={state} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled}>
      {content}
    </button>
  );
}
