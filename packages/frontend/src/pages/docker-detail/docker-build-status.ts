import type { DockerBuildStatus } from "@/types";

export const ACTIVE_DOCKER_BUILD_STATUSES = new Set<DockerBuildStatus>([
  "queued",
  "claimed",
  "checking_out",
  "building",
  "scanning",
  "pushing",
  "deploying",
]);

/** Badge variant of each build status, in the order the status filter lists them. */
export const DOCKER_BUILD_STATUS_VARIANT: Record<
  DockerBuildStatus,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  queued: "secondary",
  claimed: "secondary",
  checking_out: "default",
  building: "default",
  scanning: "default",
  pushing: "default",
  deploying: "warning",
  succeeded: "success",
  failed: "destructive",
  cancelled: "secondary",
  superseded: "secondary",
};
