import { AppError } from '@/middleware/error-handler.js';

/**
 * Label namespaces Gateway and Docker Compose read to place, group or hide a container. A caller who
 * sets one can move a container out of its folder (a Compose project label re-homes it into that
 * project's root-level system folder) or hide it from every user (Gateway implementation markers), so
 * user-supplied labels never carry them.
 */
const RESERVED_DOCKER_LABEL_PREFIXES = [
  'com.docker.compose.',
  'wiolett.gateway.',
  'net.wiolett.gateway.',
  'com.wiolett.gateway.',
] as const;
const RESERVED_DOCKER_LABELS = new Set(['gateway.sandbox']);

export function isReservedDockerLabel(key: string): boolean {
  return RESERVED_DOCKER_LABELS.has(key) || RESERVED_DOCKER_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Reserved labels a caller asks to add or change; `current` holds the container's labels (none for a new one). */
export function changedReservedDockerLabels(
  requested: Record<string, string> | undefined,
  current: Record<string, unknown> = {}
): string[] {
  return Object.entries(requested ?? {})
    .filter(([key, value]) => isReservedDockerLabel(key) && current[key] !== value)
    .map(([key]) => key);
}

export function reservedDockerLabelsMessage(keys: readonly string[]): string {
  return `Labels ${keys.join(', ')} are reserved for Gateway and Docker Compose`;
}

export function assertNoReservedDockerLabelChanges(
  requested: Record<string, string> | undefined,
  current?: Record<string, unknown>
): void {
  const keys = changedReservedDockerLabels(requested, current);
  if (keys.length > 0) throw new AppError(400, 'RESERVED_DOCKER_LABEL', reservedDockerLabelsMessage(keys));
}
