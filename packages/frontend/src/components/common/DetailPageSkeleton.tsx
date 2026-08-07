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
export function DetailPageSkeleton({ label, tabs = 3, panels = 2 }: DetailPageSkeletonProps) {
  return (
    <PageTransition>
      <div className="h-full flex flex-col gap-4 overflow-hidden p-6" aria-label={label}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-9 w-9 shrink-0" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-56 max-w-[60vw]" />
              <Skeleton className="h-4 w-80 max-w-[75vw]" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-20" />
          </div>
        </div>
        <div className="flex shrink-0 gap-1 border border-border p-1">
          {Array.from({ length: tabs }, (_, index) => (
            <Skeleton key={index} className="h-9 w-24" />
          ))}
        </div>
        <div className="grid min-h-0 gap-4 overflow-hidden lg:grid-cols-2">
          {Array.from({ length: panels }, (_, index) => (
            <div key={index} className="space-y-3 border border-border bg-card p-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </PageTransition>
  );
}
