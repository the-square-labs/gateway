import { useEffect, useState } from "react";
import type { DockerBuild } from "@/types";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "./docker-build-status";

export function useDockerBuildClock(builds: DockerBuild[]): number {
  const [now, setNow] = useState(Date.now);
  const hasActiveBuilds = builds.some((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status));

  useEffect(() => {
    if (!hasActiveBuilds) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActiveBuilds]);

  return now;
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export function formatDockerBuildDuration(build: DockerBuild, now: number): string {
  const start = timestamp(build.startedAt ?? build.queuedAt);
  let elapsed: number;

  if (ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)) {
    elapsed = (now - start) / 1000;
  } else {
    const completed = timestamp(build.completedAt);
    const progress = build.progress.elapsedSeconds;
    const progressSeconds =
      typeof progress === "number" || (typeof progress === "string" && progress.trim())
        ? Number(progress)
        : Number.NaN;
    // updatedAt is returned by the API but is not yet declared on DockerBuild.
    const updated = timestamp("updatedAt" in build ? build.updatedAt : undefined);
    elapsed = Number.isFinite(completed)
      ? (completed - start) / 1000
      : Number.isFinite(progressSeconds) && progressSeconds >= 0
        ? progressSeconds
        : (updated - start) / 1000;
  }

  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.max(0, Math.round(elapsed));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
