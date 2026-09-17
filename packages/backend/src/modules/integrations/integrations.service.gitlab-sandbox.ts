import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { User } from '@/types.js';
import { IntegrationsGitLabOperationService } from './integrations.service.gitlab-operations.js';

// Public contract only. The commercial package supplies paid implementations.
export class IntegrationsGitLabSandboxService extends IntegrationsGitLabOperationService {
  async gitLabCloneRepositoryToSandbox(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      ref?: string;
      targetPath?: string;
      ttlSeconds?: number;
    },
    _sandboxService: AISandboxService,
    _conversationId?: string
  ): Promise<{
    processId: string;
    jobId: string;
    path: string;
    ref: string | null;
    archiveBytes: number;
    status: string;
    nextStep: string;
  }> {
    return commercialModuleUnavailable();
  }
}
