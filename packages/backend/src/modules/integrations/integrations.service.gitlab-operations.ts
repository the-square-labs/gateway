import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { User } from '@/types.js';
import { IntegrationsGitLabToolService } from './integrations.service.gitlab-tools.js';

// Public contract only. The commercial package supplies paid implementations.
export class IntegrationsGitLabOperationService extends IntegrationsGitLabToolService {
  async gitLabListPipelines(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      ref?: string;
      limit?: number;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsPipelineRef[];
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabGetPipeline(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      pipelineId: number;
    }
  ): Promise<import('./integration-provider.types.js').VcsPipelineRef> {
    return commercialModuleUnavailable();
  }
  async gitLabGetPipelineJobs(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      pipelineId: number;
      limit?: number;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsPipelineJobRef[];
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabGetJobLog(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      jobId: number;
      limitBytes?: number;
    }
  ): Promise<import('./integration-provider.types.js').VcsJobLogResult> {
    return commercialModuleUnavailable();
  }
  async gitLabListProjectVariables(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsProjectVariableRef[];
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabSetProjectVariable(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      key: string;
      value: string;
      variableType?: 'env_var' | 'file';
      protected?: boolean;
      masked?: boolean;
      raw?: boolean;
      environmentScope?: string;
      description?: string;
    }
  ): Promise<import('./integration-provider.types.js').VcsProjectVariableRef> {
    return commercialModuleUnavailable();
  }
  async gitLabDeleteProjectVariable(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      key: string;
      environmentScope?: string;
    }
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabListProjectWebhooks(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsProjectWebhookRef[];
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabCreateOrUpdateProjectWebhook(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      id?: number;
      url: string;
      token?: string;
      pushEvents?: boolean;
      mergeRequestsEvents?: boolean;
      tagPushEvents?: boolean;
      jobEvents?: boolean;
      pipelineEvents?: boolean;
      enableSslVerification?: boolean;
    }
  ): Promise<import('./integration-provider.types.js').VcsProjectWebhookRef> {
    return commercialModuleUnavailable();
  }
  async gitLabDeleteProjectWebhook(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      hookId: number;
    }
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabListRegistryRepositories(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsRegistryRepositoryRef[];
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabCreateDeployToken(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      name: string;
      scopes: string[];
      expiresAt?: string;
      registryUrl?: string;
    }
  ): Promise<{
    credentialId: string;
    name: string;
    username: string;
    tokenMasked: string;
    scopes: string[];
    expiresAt: string | null;
    project: string;
    registryUrl: string | null;
  }> {
    return commercialModuleUnavailable();
  }
}
