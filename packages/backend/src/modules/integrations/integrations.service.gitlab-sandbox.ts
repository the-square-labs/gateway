import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { User } from '@/types.js';
import { GITLAB_AUDIT_ACTIONS } from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import { IntegrationsGitLabOperationService } from './integrations.service.gitlab-operations.js';

export class IntegrationsGitLabSandboxService extends IntegrationsGitLabOperationService {
  async gitLabCloneRepositoryToSandbox(
    user: User,
    input: { connectorId: string; project: string; ref?: string; targetPath?: string; ttlSeconds?: number },
    sandboxService: AISandboxService,
    conversationId?: string
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:sandbox:clone',
      requiredCapability: 'repoRead',
    });
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'repository.clone.sandbox',
      requiredScope: 'ai:sandbox:use',
      connectorId: context.connector.id,
      connectorName: context.connector.name,
    });
    const targetPath = this.safeRelativePath(input.targetPath || this.slugPath(context.project.name || 'repository'));
    const archivePath = `.gateway/gitlab-${Date.now()}.tar.gz`;
    const archiveReadyPath = `${archivePath}.ready`;
    if (!('streamRepositoryArchive' in context.provider)) {
      throw new AppError(
        501,
        'CONNECTOR_VCS_PROVIDER_UNAVAILABLE',
        'The gitlab VCS provider cannot stream repository archives'
      );
    }
    const connectorSettings = this.gitLabSettings(context.connector);
    const cloneTimeoutSeconds = Math.max(10, connectorSettings.cloneTimeoutSeconds);
    const effectiveTtlSeconds = Math.min(input.ttlSeconds ?? cloneTimeoutSeconds, cloneTimeoutSeconds);
    const processTtlSeconds = effectiveTtlSeconds + cloneTimeoutSeconds;
    const command = [
      'sh',
      '-lc',
      [
        'set -eu',
        `while [ ! -f ${this.shellQuote(`/workspace/${archiveReadyPath}`)} ]; do sleep 0.2; done`,
        `mkdir -p ${this.shellQuote(`/workspace/${targetPath}`)}`,
        `tar -xzf ${this.shellQuote(`/workspace/${archivePath}`)} -C ${this.shellQuote(`/workspace/${targetPath}`)} --strip-components=1`,
        `rm -f ${this.shellQuote(`/workspace/${archivePath}`)} ${this.shellQuote(`/workspace/${archiveReadyPath}`)}`,
        'echo CLONE_READY',
        `sleep ${effectiveTtlSeconds}`,
      ].join('; '),
    ];
    const process = await sandboxService.runProcess(user, {
      runtime: 'alpine',
      command,
      ttlSeconds: processTtlSeconds,
      conversationId,
    });
    let archiveBytes = 0;
    try {
      const archive = await context.provider.streamRepositoryArchive(
        context.auth,
        this.toProviderProject(context.project),
        input.ref,
        {
          maxBytes: connectorSettings.cloneMaxSizeMb * 1024 * 1024,
          timeoutMs: cloneTimeoutSeconds * 1000,
        }
      );
      const uploaded = await sandboxService.uploadArtifactStream(user, {
        processId: process.processId,
        path: archivePath,
        chunks: archive.chunks,
        maxBytes: connectorSettings.cloneMaxSizeMb * 1024 * 1024,
      });
      await sandboxService.uploadArtifact(user, {
        processId: process.processId,
        path: archiveReadyPath,
        contentBase64: '',
      });
      archiveBytes = uploaded.sizeBytes;
    } catch (error) {
      await sandboxService.killProcess(user, process.processId).catch(() => {});
      throw error;
    }
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.repositoryClone, {
      project: context.project.fullPath,
      ref: input.ref ?? null,
      targetPath,
      archiveBytes,
      processId: process.processId,
    });
    return {
      processId: process.processId,
      jobId: process.jobId,
      path: targetPath,
      ref: input.ref ?? context.project.defaultBranch ?? null,
      archiveBytes,
      status: 'extracting',
      nextStep:
        'Call read_process_output for CLONE_READY, then use list_artifact_files with this processId/path for repository structure and read_artifact for specific files. Do not start another sandbox process just to list or read cloned files.',
    };
  }
}
