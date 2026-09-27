import type { ReactNode } from "react";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";

/**
 * How upstream controls are laid out: `rows` are settings rows inside a panel
 * (route settings, the Create Route target step); `form` stacks labelled
 * fields for form dialogs.
 */
export type UpstreamFieldLayout = "rows" | "form";

/**
 * One upstream control. In a form the title labels the control (`id`) and the
 * description reads as helper text below it; without an `id` the value is
 * read-only and the title is plain text.
 */
export function UpstreamField({
  layout,
  id,
  title,
  description,
  controlsClassName,
  children,
}: {
  layout: UpstreamFieldLayout;
  id?: string;
  title: string;
  description?: ReactNode;
  controlsClassName?: string;
  children: ReactNode;
}) {
  if (layout === "rows") {
    return (
      <SettingsControlRow
        title={title}
        description={description}
        controlsClassName={controlsClassName}
      >
        {children}
      </SettingsControlRow>
    );
  }
  return (
    <div className="space-y-1.5">
      {id ? (
        <label htmlFor={id} className="block text-sm font-medium">
          {title}
        </label>
      ) : (
        <p className="text-sm font-medium">{title}</p>
      )}
      {children}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** Short fields (port, scheme) side by side in a form; rows need no wrapper. */
export function UpstreamFieldPair({
  layout,
  children,
}: {
  layout: UpstreamFieldLayout;
  children: ReactNode;
}) {
  if (layout === "rows") return <>{children}</>;
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}
