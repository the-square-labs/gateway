import { PageTransition } from "@/components/common/PageTransition";
import { Skeleton } from "@/components/ui/skeleton";

interface DetailPageSkeletonProps {
  label: string;
  tabs?: number;
  panels?: number;
}

/**
 * Permission-gated detail routes know their page geometry before the resource
 * payload arrives. Keep that geometry visible instead of replacing the whole
 * route with a spinner and mounting it again after the request resolves.
 */
export function DetailPageSkeleton({ label }: DetailPageSkeletonProps) {
  return (
    <PageTransition>
      <div className="h-full" aria-busy="true" aria-label={label}>
        <Skeleton />
      </div>
    </PageTransition>
  );
}
