import { FOLDER_SCOPABLE } from '@/lib/scopes.js';

/**
 * Folder grants that make the node inventory listable (GET /nodes and the list_nodes tool). A granted node folder
 * lists its nodes and, while still empty, lists nothing instead of failing.
 */
export const NODE_LIST_FOLDER_BASES: readonly string[] = FOLDER_SCOPABLE.filter(
  (base) => base.startsWith('nodes:') && base !== 'nodes:backups:execute'
);

/** A granted Docker folder with no workload yet lists no Docker nodes rather than failing the Docker pages. */
export const DOCKER_LIST_FOLDER_BASES: readonly string[] = FOLDER_SCOPABLE.filter((base) => base.startsWith('docker:'));
