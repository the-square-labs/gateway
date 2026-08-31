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
