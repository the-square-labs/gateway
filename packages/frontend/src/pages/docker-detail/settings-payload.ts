import { parseShellWords } from "@/lib/shell-words";
import type { PortMapping } from "./PortMappingsSection";
import type { MountEntry } from "./VolumeMountsSection";

export interface RecreateBaseline {
  imageTag: string;
  ports: string;
  mounts: string;
  entrypoint: string;
  command: string;
  stopTimeout: string;
  workingDir: string;
  user: string;
  hostname: string;
  labels: string;
  gpuDeviceIds: string;
}

export interface RecreatePayloadInputs {
  parsedImageName: string;
  imageTag: string;
  imageTagChanged: boolean;
  portsChanged: boolean;
  ports: PortMapping[];
  mountsChanged: boolean;
  mounts: MountEntry[];
  entrypoint: string;
  command: string;
  stopTimeout: string;
  workingDir: string;
  user: string;
  hostname: string;
  labelsChanged: boolean;
  labels: Array<{ key: string; value: string }>;
  gpuChanged: boolean;
  gpuDeviceIds: string[];
  hasRuntimeChanges: boolean;
  runtimePayload: Record<string, unknown> | null;
  recreateBaseline: RecreateBaseline;
}

export function buildRecreatePayloadFromForm({
  parsedImageName,
  imageTag,
  imageTagChanged,
  portsChanged,
  ports,
  mountsChanged,
  mounts,
  entrypoint,
  command,
  stopTimeout,
  workingDir,
  user,
  hostname,
  labelsChanged,
  labels,
  gpuChanged,
  gpuDeviceIds,
  hasRuntimeChanges,
  runtimePayload,
  recreateBaseline,
}: RecreatePayloadInputs) {
  const payload: Record<string, unknown> = {};

  if (imageTagChanged) {
    payload.image = imageTag.trim() ? `${parsedImageName}:${imageTag.trim()}` : parsedImageName;
  }
  if (portsChanged) {
    payload.ports = ports
      .filter((port) => port.containerPort)
      .map((port) => ({
        hostIp: port.hostIp || "0.0.0.0",
        hostPort: Number(port.hostPort) || 0,
        containerPort: Number(port.containerPort),
        protocol: port.protocol,
      }));
  }
  if (mountsChanged) {
    payload.mounts = mounts
      .filter((mount) => mount.containerPath)
      .map((mount) => ({
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        name: mount.name,
        readOnly: mount.readOnly,
      }));
  }
  if (entrypoint !== recreateBaseline.entrypoint) {
    const nextEntrypoint = entrypoint.trim();
    payload.entrypoint = nextEntrypoint ? parseShellWords(nextEntrypoint) : [];
  }
  if (command !== recreateBaseline.command) {
    const nextCommand = command.trim();
    payload.command = nextCommand ? parseShellWords(nextCommand) : [];
  }
  if (stopTimeout !== recreateBaseline.stopTimeout) {
    payload.stopTimeout = Number(stopTimeout);
  }
  if (workingDir !== recreateBaseline.workingDir) payload.workingDir = workingDir;
  if (user !== recreateBaseline.user) payload.user = user;
  if (hostname !== recreateBaseline.hostname) payload.hostname = hostname;
  if (labelsChanged) {
    const labelMap: Record<string, string> = {};
    for (const label of labels) {
      if (label.key.trim()) labelMap[label.key.trim()] = label.value;
    }
    payload.labels = labelMap;
  }
  if (gpuChanged) {
    payload.gpu = { deviceIds: gpuDeviceIds };
  }
  if (hasRuntimeChanges && runtimePayload) {
    Object.assign(payload, runtimePayload);
  }

  return payload;
}
