import { Loader2 } from "lucide-react";

export function LoadingSpinner({
  className = "py-16",
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center ${className}`}
      role="status"
      aria-label={label}
    >
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}
