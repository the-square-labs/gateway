import { and, eq, isNull } from 'drizzle-orm';
import { integrationConnectorProjects } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { buildGitLabFileCommitAuditDetails, GITLAB_AUDIT_ACTIONS, hashGitLabDiff } from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import type { VcsCommitFileChange, VcsProjectRef } from './integration-provider.types.js';
import { IntegrationsCloudflareService } from './integrations.service.cloudflare.js';

export class IntegrationsGitLabToolService extends IntegrationsCloudflareService {
  async searchGitLabAllowlist(id: string, query: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const provider = this.getProvider(row.provider);
    return provider.searchAllowlist(this.systemAuthFor(row), query);
  }

  async listGitLabAllowlistOptions(id: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const projects = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(
        and(eq(integrationConnectorProjects.connectorId, row.id), isNull(integrationConnectorProjects.inaccessibleAt))
      )
      .orderBy(integrationConnectorProjects.fullPath);
    return projects.map((project) => this.projectToAllowlistEntry(project));
  }

  async refreshGitLabAllowlistOptions(id: string, userId: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const provider = this.getProvider(row.provider);
    const projects = await provider.listProjects(this.systemAuthFor(row));
    await this.persistProjects(id, projects);

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.projectList,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, source: 'settings', refreshed: true, projectCount: projects.length },
    });

    return this.listGitLabAllowlistOptions(id);
  }

  async searchGitLabAllowlistPreview(input: { baseUrl: string; token: string; q: string }) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    return this.getProvider('gitlab').searchAllowlist({ baseUrl, token: input.token }, input.q);
  }

  async testGitLabConnectorPreview(input: { baseUrl: string; token: string }) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const auth = { baseUrl, token: input.token };
    const provider = this.getProvider('gitlab');
    const [capabilities, projects] = await Promise.all([provider.testConnection(auth), provider.listProjects(auth)]);
    return {
      capabilities,
      allowlistEntries: projects.map((project) => ({
        entryType: 'project' as const,
        remoteId: project.remoteId,
        fullPath: project.fullPath,
        name: project.name,
        webUrl: project.webUrl,
      })),
    };
  }

  async listGitLabConnectorsForTool(user: User) {
    await this.assertGitLabConnectorAccess(user, 'integrations:gitlab:view', 'project.list', {
      auditAction: GITLAB_AUDIT_ACTIONS.projectList,
    });
    const rows = await this.listGitLabConnectors({ enabled: true });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      allowlistMode: row.allowlistMode,
      capabilities: row.capabilities,
      syncStatus: row.syncStatus,
      syncFinishedAt: row.syncFinishedAt,
    }));
  }

  async listGitLabProjectsForTool(user: User, input: { connectorId: string; search?: string; limit?: number }) {
    const row = await this.getConnectorRow(input.connectorId, 'gitlab');
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'project.list',
      requiredScope: 'integrations:gitlab:projects:view',
      capabilities: row.capabilities,
      requiredCapability: 'projectsView',
      connectorId: row.id,
      connectorName: row.name,
    });
    const limit = this.toolLimit(input.limit, 25, 100);
    const projects = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(eq(integrationConnectorProjects.connectorId, row.id))
      .orderBy(integrationConnectorProjects.fullPath)
      .limit(500);
    const allowlistRows = await this.listAllowlistRows(row.id);
    let allowedProjects = this.filterAllowedProjects(row, allowlistRows, projects);
    const credential = await this.resolveGitLabCredential(user, row);
    if (credential.source === 'personal') {
      const provider = this.gitLabProviderForCredential(user, row, credential);
      const visibleProjects = await provider.listProjects(credential.auth);
      const visibleIds = new Set(visibleProjects.map((project) => project.remoteId));
      allowedProjects = allowedProjects.filter((project) => visibleIds.has(project.remoteId));
    }
    const search = input.search?.trim().toLowerCase();
    const filtered = search
      ? allowedProjects.filter(
          (project) => project.fullPath.toLowerCase().includes(search) || project.name.toLowerCase().includes(search)
        )
      : allowedProjects;
    await this.auditGitLabTool(user, row, GITLAB_AUDIT_ACTIONS.projectList, {
      search: input.search ?? null,
      returned: Math.min(filtered.length, limit),
      totalMatched: filtered.length,
    });
    return {
      data: filtered.slice(0, limit).map((project) => this.toSafeProject(project)),
      total: filtered.length,
      truncated: filtered.length > limit,
    };
  }

  async getGitLabProjectForTool(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:projects:view',
      requiredCapability: 'projectsView',
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.projectList, {
      project: context.project.fullPath,
    });
    return this.toSafeProject(context.project);
  }

  async gitLabSyncConnectorForTool(user: User, input: { connectorId: string }) {
    await this.assertGitLabConnectorAccess(user, 'integrations:gitlab:sync', 'connector.sync');
    return this.syncGitLabConnector(input.connectorId, user.id);
  }

  async gitLabAddConnectorProjects(
    user: User,
    input: { connectorId: string; projects: string[]; syncAfter?: boolean }
  ) {
    const connector = await this.getConnectorRow(input.connectorId, 'gitlab');
    if (!connector.enabled) {
      throw new AppError(409, 'CONNECTOR_DISABLED', 'GitLab connector is disabled');
    }
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'connector.allowlist.update',
      requiredScope: 'integrations:gitlab:manage',
      capabilities: connector.capabilities,
      requiredCapability: 'projectsView',
      connectorId: connector.id,
      connectorName: connector.name,
    });

    const requested = [...new Set(input.projects.map((project) => project.trim()).filter(Boolean))];
    if (requested.length === 0) {
      throw new AppError(400, 'GITLAB_PROJECTS_REQUIRED', 'At least one GitLab project path or remote ID is required');
    }
    const provider = this.getProvider(connector.provider);
    const visibleProjects = await provider.listProjects(this.systemAuthFor(connector));
    await this.persistProjects(connector.id, visibleProjects);
    const visibleByKey = new Map<string, VcsProjectRef>();
    for (const project of visibleProjects) {
      visibleByKey.set(project.remoteId, project);
      visibleByKey.set(project.fullPath.toLowerCase(), project);
    }

    const missing = requested.filter(
      (project) => !visibleByKey.has(project) && !visibleByKey.has(project.toLowerCase())
    );
    if (missing.length > 0) {
      throw new AppError(
        404,
        'GITLAB_PROJECT_NOT_VISIBLE',
        'One or more GitLab projects are not visible to this connector',
        {
          missing,
        }
      );
    }

    const allowlistRows = await this.listAllowlistRows(connector.id);
    const matchedProjects = requested.map(
      (project) => visibleByKey.get(project) ?? visibleByKey.get(project.toLowerCase())!
    );
    const alreadyAllowed = matchedProjects.filter(
      (project) => connector.allowlistMode === 'all_visible' || this.isGitLabProjectAllowed(project, allowlistRows)
    );
    const toAdd = matchedProjects.filter(
      (project) => connector.allowlistMode !== 'all_visible' && !this.isGitLabProjectAllowed(project, allowlistRows)
    );

    if (toAdd.length > 0) {
      await this.replaceAllowlistEntries(connector.id, [
        ...allowlistRows.map((entry) => ({
          entryType: entry.entryType,
          remoteId: entry.remoteId,
          fullPath: entry.fullPath,
          name: entry.name ?? undefined,
          webUrl: entry.webUrl,
        })),
        ...toAdd.map((project) => ({
          entryType: 'project' as const,
          remoteId: project.remoteId,
          fullPath: project.fullPath,
          name: project.name,
          webUrl: project.webUrl ?? null,
        })),
      ]);
      this.emitConnector(connector.id, 'updated');
    }

    await this.auditGitLabTool(user, connector, GITLAB_AUDIT_ACTIONS.connectorAllowlistUpdate, {
      addedProjects: toAdd.map((project) => project.fullPath),
      alreadyAllowedProjects: alreadyAllowed.map((project) => project.fullPath),
      allowlistMode: connector.allowlistMode,
    });

    const syncResult = input.syncAfter ? await this.syncGitLabConnector(connector.id, user.id) : null;
    return {
      connectorId: connector.id,
      allowlistMode: connector.allowlistMode,
      added: toAdd.map((project) => this.toSafeProjectRef(connector.id, project)),
      alreadyAllowed: alreadyAllowed.map((project) => this.toSafeProjectRef(connector.id, project)),
      sync: syncResult,
    };
  }

  async gitLabUpdateProjectSettings(
    user: User,
    input: {
      connectorId: string;
      project: string;
      containerRegistryAccessLevel: 'enabled' | 'private' | 'disabled';
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:registry:manage',
      requiredCapability: 'deployTokensManage',
    });
    const result = await context.provider.updateProjectSettings(context.auth, this.toProviderProject(context.project), {
      containerRegistryAccessLevel: input.containerRegistryAccessLevel,
    });
    let syncResult: Awaited<ReturnType<IntegrationsCloudflareService['syncGitLabConnector']>> | null = null;
    let syncError: { code: string; message: string; statusCode?: number } | null = null;
    try {
      syncResult = await this.syncGitLabConnector(context.connector.id, user.id);
    } catch (error) {
      syncError =
        error instanceof AppError
          ? { code: error.code, message: error.message, statusCode: error.statusCode }
          : { code: 'CONNECTOR_SYNC_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.projectSettingsUpdate, {
      project: context.project.fullPath,
      settings: { containerRegistryAccessLevel: input.containerRegistryAccessLevel },
      syncStatus: syncResult?.status ?? 'error',
      syncError,
    });
    return { ...result, sync: syncResult, syncError };
  }

  async gitLabListRepositoryTree(
    user: User,
    input: { connectorId: string; project: string; path?: string; ref?: string; limit?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:read',
      requiredCapability: 'repoRead',
    });
    const entries = await context.provider.listTree(
      context.auth,
      this.toProviderProject(context.project),
      input.path ?? '',
      input.ref
    );
    const limit = this.toolLimit(input.limit, 100, 500);
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.repositoryTree, {
      project: context.project.fullPath,
      path: input.path ?? '',
      ref: input.ref ?? null,
      returned: Math.min(entries.length, limit),
    });
    return { data: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
  }

  async gitLabReadFile(
    user: User,
    input: { connectorId: string; project: string; path: string; ref?: string; offset?: number; length?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:read',
      requiredCapability: 'repoRead',
    });
    const result = await context.provider.readFile(context.auth, {
      project: this.toProviderProject(context.project),
      path: input.path,
      ref: input.ref,
      offset: input.offset,
      length: input.length,
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.fileRead, {
      project: context.project.fullPath,
      path: input.path,
      ref: input.ref ?? null,
      offset: result.offset,
      bytesRead: result.bytesRead,
      truncated: result.truncated,
    });
    return result;
  }

  async gitLabCommitFiles(
    user: User,
    input: {
      connectorId: string;
      project: string;
      branch: string;
      commitMessage: string;
      changes: VcsCommitFileChange[];
      startBranch?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:write',
      requiredCapability: 'repoWrite',
    });
    const createdBranch = await this.assertPersonalGitLabWriteAccess(context, input.branch, input.startBranch);
    const result = await context.provider.commitFiles(context.auth, {
      project: this.toProviderProject(context.project),
      branch: input.branch,
      commitMessage: input.commitMessage,
      changes: input.changes,
      startBranch: createdBranch ? undefined : input.startBranch,
    });
    await this.auditGitLabTool(
      user,
      context.connector,
      GITLAB_AUDIT_ACTIONS.fileCommit,
      buildGitLabFileCommitAuditDetails({
        connectorId: context.connector.id,
        connectorName: context.connector.name,
        projectRemoteId: context.project.remoteId,
        projectFullPath: context.project.fullPath,
        branch: input.branch,
        actionCount: input.changes.length,
        filePaths: input.changes.map((change) => change.path),
        commitSha: result.commitSha,
      }) as Record<string, unknown>
    );
    return result;
  }

  async gitLabLintCiConfig(user: User, input: { connectorId: string; project: string; content: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'ciLint',
    });
    const result = await context.provider.lintCiConfig(
      context.auth,
      this.toProviderProject(context.project),
      input.content
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciLint, {
      project: context.project.fullPath,
      contentHash: hashGitLabDiff(input.content),
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
    });
    return result;
  }

  async gitLabUpdateCiConfig(
    user: User,
    input: {
      connectorId: string;
      project: string;
      branch: string;
      content: string;
      commitMessage: string;
      startBranch?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:edit',
      requiredCapability: 'ciEdit',
    });
    const lint = await context.provider.lintCiConfig(
      context.auth,
      this.toProviderProject(context.project),
      input.content
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciLint, {
      project: context.project.fullPath,
      contentHash: hashGitLabDiff(input.content),
      valid: lint.valid,
      errorCount: lint.errors.length,
      warningCount: lint.warnings.length,
    });
    if (!lint.valid) {
      throw new AppError(
        400,
        'GITLAB_CI_LINT_FAILED',
        'GitLab CI config lint failed; refusing to commit invalid config',
        {
          errors: lint.errors,
          warnings: lint.warnings,
        }
      );
    }
    const createdBranch = await this.assertPersonalGitLabWriteAccess(context, input.branch, input.startBranch);
    const result = await context.provider.commitFiles(context.auth, {
      project: this.toProviderProject(context.project),
      branch: input.branch,
      startBranch: createdBranch ? undefined : input.startBranch,
      commitMessage: input.commitMessage,
      changes: [{ action: 'update', path: '.gitlab-ci.yml', content: input.content }],
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciUpdate, {
      project: context.project.fullPath,
      branch: input.branch,
      contentHash: hashGitLabDiff(input.content),
      commitSha: result.commitSha,
    });
    return { ...result, lint };
  }
}
