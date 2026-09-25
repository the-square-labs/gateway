/**
 * Mirrors the backend volume edit gate (modules/docker/docker-volume-access.ts): rename, label changes, resize and
 * adoption need `docker:volumes:edit` on `<nodeId>/<volume>`. Node and folder grants resolve to it.
 */
export const DOCKER_VOLUME_EDIT_SCOPE = "docker:volumes:edit";

export function canEditDockerVolume(
  hasScope: (scope: string) => boolean,
  nodeId: string | null | undefined,
  volumeId: string | null | undefined
): boolean {
  if (hasScope(DOCKER_VOLUME_EDIT_SCOPE)) return true;
  if (!nodeId) return false;
  return volumeId
    ? hasScope(`${DOCKER_VOLUME_EDIT_SCOPE}:${nodeId}/${volumeId}`)
    : hasScope(`${DOCKER_VOLUME_EDIT_SCOPE}:${nodeId}`);
}
