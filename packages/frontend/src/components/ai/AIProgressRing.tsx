import { cn } from "@/lib/utils";

export function AIProgressRing({
  value,
  className,
  ariaLabel = "In progress",
}: {
  value?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const normalizedValue = value == null ? null : Math.max(0, Math.min(100, value));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset =
    normalizedValue == null
      ? circumference * 0.72
      : circumference - (circumference * normalizedValue) / 100;

  return (
    <svg
      className={cn(
        "h-4 w-4 shrink-0 -rotate-90 text-primary",
        normalizedValue == null && "animate-spin",
        className
      )}
      viewBox="0 0 20 20"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={normalizedValue == null ? undefined : 0}
      aria-valuemax={normalizedValue == null ? undefined : 100}
      aria-valuenow={normalizedValue == null ? undefined : Math.round(normalizedValue)}
    >
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className="stroke-current transition-[stroke-dashoffset]"
      />
    </svg>
  );
}
