import { useContentLoading } from "@/components/common/reveal-gate";

/**
 * Reports a load to the enclosing page, tab or dialog while mounted.
 *
 * @deprecated Kept for compatibility only. Report loads with
 * `useContentLoading(isLoading)`, or `<ContentLoading loading={isLoading} />`
 * from `@/components/common/ContentLoading` inside a gate the component renders.
 */
function Skeleton(_props: React.HTMLAttributes<HTMLDivElement>) {
  useContentLoading(true);
  return null;
}

export { Skeleton };
