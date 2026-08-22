import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={checked}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 appearance-none items-center justify-start border border-border p-0 transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        checked ? "bg-primary" : "bg-muted-foreground/20"
      )}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span
        className={cn(
          "absolute top-px inline-block h-4 w-4 bg-background transition-[left]",
          checked ? "left-[17px]" : "left-px"
        )}
      />
    </button>
  );
}
