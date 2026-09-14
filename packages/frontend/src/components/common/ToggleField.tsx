import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";

export function ToggleField({
  title,
  description,
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-border bg-muted/30 p-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={ariaLabel} disabled={disabled} />
    </div>
  );
}
