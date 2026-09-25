import { useContentLoading } from "@/components/common/reveal-gate";

/**
 * Reports a load to the enclosing page, tab or dialog while mounted. Prefer
 * `useContentLoading(isLoading)` in new code.
 */
function Skeleton(_props: React.HTMLAttributes<HTMLDivElement>) {
  useContentLoading(true);
  return null;
}

export { Skeleton };
