import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const MAX_BARS = 192;
const DEFAULT_BAR_WIDTH = 6; // px target per bar
const DEFAULT_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

type BarStatus = "ok" | "warn" | "error" | "none";

interface HealthEntry {
  ts: string;
  status: string;
  slow?: boolean;
}

function currentStatusToBarStatus(status?: string): BarStatus {
  if (!status || status === "unknown" || status === "disabled" || status === "pending") {
    return "none";
  }
  if (status === "online") return "ok";
  if (status === "recovering" || status === "degraded") return "warn";
  return "error";
}

function mergeLatestBar(existing: BarStatus, current: BarStatus): BarStatus {
  if (current === "none") return existing;
  if (existing === "none") return current;
  if (current === "error") return "error";
  if (current === "warn") return "warn";
  return existing === "ok" ? "ok" : "warn";
}

export interface HealthBarsProps {
  /** Health check entries with timestamp + status */
  history?: HealthEntry[];
  /** Current status used for the rightmost bar when no data in that bucket */
  currentStatus?: string;
  /** Bucket duration in ms (default: 5 min) */
  bucketMs?: number;
  /** Target width per bar in px (default: 4) */
  barWidth?: number;
  /** Bar height class (default: h-6) */
  barHeight?: string;
  /** Show time labels below (default: true) */
  showLabels?: boolean;
  className?: string;
}

export function HealthBars({
  history,
  currentStatus,
  bucketMs = DEFAULT_BUCKET_MS,
  barWidth = DEFAULT_BAR_WIDTH,
  barHeight = "h-6",
  showLabels = true,
  className,
}: HealthBarsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(0);

  // Measure container width and compute bar count
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const width = el.clientWidth;
      // Each bar takes barWidth + 1px gap
      const count = Math.min(MAX_BARS, Math.max(1, Math.floor(width / (barWidth + 1))));
      setBarCount(count);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [barWidth]);

  // Snap to bucket boundary so bars don't shift on every render
  const now = Math.floor(Date.now() / bucketMs) * bucketMs + bucketMs;

  const bars = useMemo(() => {
    if (barCount === 0) return [];

    // Filter out legacy entries that lack a valid ts field
    const checks = (history ?? []).filter((c) => c.ts);
    const rangeStart = now - barCount * bucketMs;
    const result: BarStatus[] = [];

    for (let i = barCount - 1; i >= 0; i--) {
      const bucketStart = now - (i + 1) * bucketMs;
      const bucketEnd = now - i * bucketMs;

      const inBucket = checks.filter((c) => {
        const t = new Date(c.ts).getTime();
        return t >= bucketStart && t < bucketEnd;
      });

      if (inBucket.length === 0) {
        result.push("none");
      } else {
        const offlineCount = inBucket.filter((c) => c.status === "offline").length;
        const hasSlow = inBucket.some((c) => c.slow);

        if (offlineCount === inBucket.length) {
          result.push("error"); // all failed
        } else if (offlineCount > 0 || hasSlow) {
          result.push("warn"); // mixed or slow responses
        } else {
          result.push("ok"); // all online, not slow
        }
      }
    }

    // Reflect current status on the newest bar immediately, then backfill any
    // empty buckets leading up to it.
    const currentBar = currentStatusToBarStatus(currentStatus);
    if (currentBar !== "none") {
      result[result.length - 1] = mergeLatestBar(result[result.length - 1], currentBar);
      const recentChecks = checks.filter((c) => {
        const t = new Date(c.ts).getTime();
        return t >= rangeStart && t < now;
      });

      if (recentChecks.length > 0) {
        // Have in-range data — fill only empty buckets between the latest
        // known sample and the newest bar, never the older history to the left.
        let latestKnownIndex = -1;
        for (let j = result.length - 1; j >= 0; j--) {
          if (result[j] !== "none") {
            latestKnownIndex = j;
            break;
          }
        }

        if (latestKnownIndex >= 0) {
          for (let j = latestKnownIndex + 1; j < result.length - 1; j++) {
            if (result[j] === "none") {
              result[j] = currentBar;
            }
          }
        }
      } else {
        result[result.length - 1] = currentBar;
      }
    }

    return result;
  }, [history, barCount, now, currentStatus, bucketMs]);

  const totalMs = barCount * bucketMs;
  const totalHours = Math.round(totalMs / 3600000);
  const totalLabel =
    totalHours >= 1
      ? `${totalHours} hour${totalHours > 1 ? "s" : ""} ago`
      : `${Math.round(totalMs / 60000)} min ago`;

  return (
    <div ref={containerRef} className={cn("shrink-0", className)}>
      <div className="flex gap-[1px]">
        {bars.map((status, i) => (
          <div
            key={i}
            className={cn(
              "flex-1",
              barHeight,
              status === "ok"
                ? "bg-emerald-500"
                : status === "warn"
                  ? "bg-warning"
                  : status === "error"
                    ? "bg-red-400"
                    : "bg-muted"
            )}
            title={new Date(now - (barCount - 1 - i) * bucketMs).toLocaleString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          />
        ))}
      </div>
      {showLabels && barCount > 0 && (
        <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
          <span>{totalLabel}</span>
          <span>Now</span>
        </div>
      )}
    </div>
  );
}
