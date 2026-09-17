import { GwcaContainerSchema, GwcaManifestSchema, stripReservedGwcaLabels } from './docker-container-archive-format.js';
export const dockerArchiveCommercialRuntime = { GwcaContainerSchema, GwcaManifestSchema, stripReservedGwcaLabels };

export type DockerArchiveOperations = Pick<
  typeof import('./docker-container-archive.js'),
  'openGwcaExport' | 'importGwca'
>;
