/**
 * Daemon answers to an update that the node refused before it changed
 * anything: the disk has no room for the new size (counted against what its
 * instances are promised), the size is below the applied one or outside the
 * supported range, or the instance's disk is being repaired. The node still
 * runs the workload as before, so the update puts its previous status back
 * instead of marking it failed: a serving workload stays ready and keeps
 * its links, with the refusal as a warning.
 */
const REFUSED_BEFORE_CHANGE =
  /insufficient (?:database|managed) storage capacity|cannot be reduced|outside the supported range|disk is being repaired/i;

/**
 * How the lastError of an update the node refused before it changed anything starts. The commercial core answers such
 * an update 409 (MANAGED_STORAGE_UPDATE_REFUSED, MANAGED_DATABASE_UPDATE_REFUSED) by this prefix.
 */
export const UPDATE_REFUSED_PREFIX = 'The node refused the update and changed nothing: ';

export function isUpdateRefusedBeforeChange(detail: string | undefined): boolean {
  return Boolean(detail && REFUSED_BEFORE_CHANGE.test(detail));
}
