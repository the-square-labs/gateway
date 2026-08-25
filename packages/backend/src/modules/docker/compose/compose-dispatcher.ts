import type { DockerComposeNormalizedModel, DockerComposeOperationAction } from '@/db/schema/index.js';

export interface DockerComposeDispatchInput {
  operationId: string;
  projectId: string;
  projectName: string;
  revisionId: string | null;
  configDigest: string | null;
  yaml: string | null;
  normalizedModel: DockerComposeNormalizedModel | null;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  action: DockerComposeOperationAction;
  options: { removeOrphans?: boolean; volumeNames?: string[] };
}

export interface DockerComposeDispatchResult {
  success: boolean;
  message?: string;
  detail?: string;
}

export interface DockerComposeDispatcher {
  execute(nodeId: string, input: DockerComposeDispatchInput): Promise<DockerComposeDispatchResult>;
}
