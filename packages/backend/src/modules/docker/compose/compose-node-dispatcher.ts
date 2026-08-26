import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type {
  DockerComposeDispatcher,
  DockerComposeDispatchInput,
  DockerComposeDispatchResult,
} from './compose-dispatcher.js';

export class DockerComposeNodeDispatcher implements DockerComposeDispatcher {
  constructor(private nodeDispatch: NodeDispatchService) {}

  async execute(nodeId: string, input: DockerComposeDispatchInput): Promise<DockerComposeDispatchResult> {
    const result = await this.nodeDispatch.sendDockerComposeCommand(nodeId, input.action, {
      operationId: input.operationId,
      projectId: input.projectId,
      projectName: input.projectName,
      revisionId: input.revisionId ?? undefined,
      configDigest: input.configDigest ?? undefined,
      composeYaml: input.yaml == null ? undefined : Buffer.from(input.yaml, 'utf8'),
      normalizedModelJson: input.normalizedModel == null ? undefined : JSON.stringify(input.normalizedModel),
      variables: input.variables,
      secrets: input.secrets,
      removeOrphans: input.options.removeOrphans ?? false,
      volumeNames: input.options.volumeNames ?? [],
    });

    return {
      success: result.success,
      message: result.error || undefined,
      detail: result.detail || undefined,
    };
  }
}
