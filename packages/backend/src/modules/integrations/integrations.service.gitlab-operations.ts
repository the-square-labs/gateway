import { integrationConnectorCredentials } from '@/db/schema/index.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import { GITLAB_AUDIT_ACTIONS, hashGitLabDiff } from './integration-audit.js';
import { IntegrationsGitLabToolService } from './integrations.service.gitlab-tools.js';

export class IntegrationsGitLabOperationService extends IntegrationsGitLabToolService {
  async gitLabListPipelines(user: User, input: { connectorId: string; project: string; ref?: string; limit?: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const data = await context.provider.listPipelines(
      context.auth,
      this.toProviderProject(context.project),
      input.ref,
      this.toolLimit(input.limit, 20, 100)
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      ref: input.ref ?? null,
      returned: data.length,
    });
    return { data };
  }

  async gitLabGetPipeline(user: User, input: { connectorId: string; project: string; pipelineId: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const pipeline = await context.provider.getPipeline(
      context.auth,
      this.toProviderProject(context.project),
      input.pipelineId
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      pipelineId: input.pipelineId,
    });
    return pipeline;
  }

  async gitLabGetPipelineJobs(
    user: User,
    input: { connectorId: string; project: string; pipelineId: number; limit?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const data = await context.provider.listPipelineJobs(
      context.auth,
      this.toProviderProject(context.project),
      input.pipelineId,
      this.toolLimit(input.limit, 50, 100)
    );
    return { data };
  }

  async gitLabGetJobLog(
    user: User,
    input: { connectorId: string; project: string; jobId: number; limitBytes?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const result = await context.provider.getJobLog(
      context.auth,
      this.toProviderProject(context.project),
      input.jobId,
      Math.min(Math.max(input.limitBytes ?? 200_000, 1), 1_000_000)
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      jobId: input.jobId,
      bytesRead: result.bytesRead,
    });
    return result;
  }

  async gitLabListProjectVariables(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:view',
      requiredCapability: 'variablesView',
    });
    const data = await context.provider.listProjectVariables(context.auth, this.toProviderProject(context.project));
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableList, {
      project: context.project.fullPath,
      returned: data.length,
    });
    return { data };
  }

  async gitLabSetProjectVariable(
    user: User,
    input: {
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
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:edit',
      requiredCapability: 'variablesEdit',
    });
    const variable = await context.provider.setProjectVariable(
      context.auth,
      this.toProviderProject(context.project),
      input
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableUpsert, {
      project: context.project.fullPath,
      key: input.key,
      valueHash: hashGitLabDiff(input.value),
      environmentScope: input.environmentScope ?? null,
      masked: input.masked ?? null,
      protected: input.protected ?? null,
    });
    return variable;
  }

  async gitLabDeleteProjectVariable(
    user: User,
    input: { connectorId: string; project: string; key: string; environmentScope?: string }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:delete',
      requiredCapability: 'variablesDelete',
    });
    await context.provider.deleteProjectVariable(
      context.auth,
      this.toProviderProject(context.project),
      input.key,
      input.environmentScope
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableDelete, {
      project: context.project.fullPath,
      key: input.key,
      environmentScope: input.environmentScope ?? null,
    });
    return { success: true };
  }

  async gitLabListProjectWebhooks(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    const data = await context.provider.listProjectWebhooks(context.auth, this.toProviderProject(context.project));
    return { data };
  }

  async gitLabCreateOrUpdateProjectWebhook(
    user: User,
    input: {
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
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    const webhook = await context.provider.createOrUpdateProjectWebhook(
      context.auth,
      this.toProviderProject(context.project),
      input
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.webhookManage, {
      project: context.project.fullPath,
      webhookId: webhook.id,
      url: webhook.url,
      tokenProvided: Boolean(input.token),
    });
    return webhook;
  }

  async gitLabDeleteProjectWebhook(user: User, input: { connectorId: string; project: string; hookId: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    await context.provider.deleteProjectWebhook(context.auth, this.toProviderProject(context.project), input.hookId);
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.webhookManage, {
      project: context.project.fullPath,
      hookId: input.hookId,
      deleted: true,
    });
    return { success: true };
  }

  async gitLabListRegistryRepositories(user: User, input: { connectorId: string; project: string }) {
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('registry-discovery');
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'docker:registries:view',
      requiredCapability: 'registryView',
    });
    const data = await context.provider.listRegistryRepositories(context.auth, this.toProviderProject(context.project));
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.registryDiscover, {
      project: context.project.fullPath,
      returned: data.length,
    });
    return { data };
  }

  async gitLabCreateDeployToken(
    user: User,
    input: {
      connectorId: string;
      project: string;
      name: string;
      scopes: string[];
      expiresAt?: string;
      registryUrl?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:registry:manage',
      requiredCapability: 'deployTokensManage',
    });
    const deployToken = await context.provider.createDeployToken(
      context.auth,
      this.toProviderProject(context.project),
      {
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      }
    );
    const [credential] = await this.db
      .insert(integrationConnectorCredentials)
      .values({
        connectorId: context.connector.id,
        credentialType: 'gitlab_deploy_token',
        name: deployToken.name,
        encryptedSecret: this.encryptToken(deployToken.token),
        secretLast4: this.tokenLast4(deployToken.token),
        username: deployToken.username,
        projectRemoteId: context.project.remoteId,
        projectFullPath: context.project.fullPath,
        registryUrl: input.registryUrl ?? null,
        scopes: deployToken.scopes,
        expiresAt: deployToken.expiresAt ? new Date(deployToken.expiresAt) : null,
        createdBy: user.id,
        metadata: { remoteDeployTokenId: deployToken.id },
      })
      .returning();
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.deployTokenCreate, {
      project: context.project.fullPath,
      credentialId: credential.id,
      username: deployToken.username,
      tokenLast4: this.tokenLast4(deployToken.token),
      scopes: deployToken.scopes,
      expiresAt: deployToken.expiresAt ?? null,
    });
    return {
      credentialId: credential.id,
      name: deployToken.name,
      username: deployToken.username,
      tokenMasked: `****${this.tokenLast4(deployToken.token)}`,
      scopes: deployToken.scopes,
      expiresAt: deployToken.expiresAt ?? null,
      project: context.project.fullPath,
      registryUrl: input.registryUrl ?? null,
    };
  }
}
