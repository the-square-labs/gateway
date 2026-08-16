import type { DockerRuntimeProfile } from "@/types";

export const DEFAULT_DOCKER_RUNTIME_DESCRIPTION =
  "Standard Docker runtime (runc). Best compatibility, including GPU.";
export const SECURE_DOCKER_RUNTIME_DESCRIPTION =
  "Runs with gVisor (runsc) for stronger host isolation. GPU unavailable.";
export const SECURE_DOCKER_RUNTIME_UNAVAILABLE_DESCRIPTION =
  "Secure Runtime is not set up on this node. Open Node Details to configure it.";

export function getSecureDockerRuntimeDescription(available: boolean): string {
  return available
    ? SECURE_DOCKER_RUNTIME_DESCRIPTION
    : SECURE_DOCKER_RUNTIME_UNAVAILABLE_DESCRIPTION;
}

export function normalizeDockerRuntimeProfile(
  runtimeName: string | null | undefined
): DockerRuntimeProfile | "legacy" {
  if (runtimeName === "runsc") return "secure";
  if (!runtimeName || runtimeName === "runc") return "default";
  return "legacy";
}
