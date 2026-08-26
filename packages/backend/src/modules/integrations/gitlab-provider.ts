import type { IntegrationConnectorCapabilities } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { GitLabClient } from './gitlab-client.js';
import type {
  VcsAllowlistSearchResult,
  VcsArchiveResult,
  VcsArchiveStream,
  VcsBranchAccess,
  VcsCiLintResult,
  VcsCommitRequest,
  VcsCommitResult,
  VcsConnectorAuth,
  VcsConnectorProvider,
  VcsDeployTokenInput,
  VcsDeployTokenResult,
  VcsFileReadRequest,
  VcsFileReadResult,
  VcsJobLogResult,
  VcsPipelineJobRef,
  VcsPipelineRef,
  VcsProjectAccess,
  VcsProjectRef,
  VcsProjectSettingsInput,
  VcsProjectSettingsResult,
  VcsProjectVariableInput,
  VcsProjectVariableRef,
  VcsProjectWebhookInput,
  VcsProjectWebhookRef,
  VcsRegistryDiscoveryResult,
  VcsRegistryRef,
  VcsRegistryRepositoryRef,
  VcsTreeEntry,
  VcsUserTokenIdentity,
} from './integration-provider.types.js';

interface GitLabUser {
  id: number;
  username: string;
}

interface GitLabTokenSelf {
  scopes?: string[];
  expires_at?: string | null;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  name: string;
  web_url?: string;
  visibility?: string;
  default_branch?: string | null;
  archived?: boolean;
  container_registry_access_level?: string | null;
  permissions?: {
    project_access?: { access_level?: number | null } | null;
    group_access?: { access_level?: number | null } | null;
  } | null;
}

interface GitLabGroup {
  id: number;
  full_path: string;
  name: string;
  web_url?: string;
}

interface GitLabRegistryRepository {
  id: number;
  path?: string;
  location?: string;
  name?: string;
}

interface GitLabRepositoryTreeEntry {
  id?: string;
  name: string;
  type: 'tree' | 'blob' | 'commit';
  path: string;
  mode?: string;
}

interface GitLabRepositoryFile {
  file_path: string;
  ref: string;
  blob_id?: string;
  commit_id?: string;
  size: number;
  encoding: 'base64' | string;
  content: string;
}

interface GitLabCommit {
  id: string;
  web_url?: string;
}

interface GitLabBranch {
  can_push?: boolean;
  commit?: {
    id?: string;
  } | null;
}

interface GitLabCiLintResponse {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  merged_yaml?: string | null;
}

interface GitLabPipeline {
  id: number;
  iid?: number;
  ref?: string;
  sha?: string;
  status?: string;
  source?: string;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface GitLabJob {
  id: number;
  name: string;
  stage?: string;
  status?: string;
  ref?: string;
  web_url?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
}

interface GitLabVariable {
  key: string;
  variable_type?: string;
  protected?: boolean;
  masked?: boolean;
  raw?: boolean;
  environment_scope?: string;
  description?: string;
}

interface GitLabProjectHook {
  id: number;
  url: string;
  push_events?: boolean;
  merge_requests_events?: boolean;
  tag_push_events?: boolean;
  job_events?: boolean;
  pipeline_events?: boolean;
  enable_ssl_verification?: boolean;
  created_at?: string;
}

interface GitLabDeployToken {
  id: number | string;
  name: string;
  username: string;
  token: string;
  scopes?: string[];
  expires_at?: string | null;
}

const CAPABILITY_KEYS = [
  'apiReachable',
  'tokenSelf',
  'projectsView',
  'groupsView',
  'repoRead',
  'repoWrite',
  'ciView',
  'ciLint',
  'ciEdit',
  'pipelineRead',
  'variablesView',
  'variablesEdit',
  'variablesDelete',
  'registryView',
  'registryUse',
  'webhooksManage',
  'deployTokensManage',
] as const;

export class GitLabProvider implements VcsConnectorProvider {
  readonly provider = 'gitlab' as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async validateUserToken(auth: VcsConnectorAuth): Promise<VcsUserTokenIdentity> {
    const client = this.client(auth);
    const user = await client.request<GitLabUser>('/user');
    const token = await this.getTokenMetadata(client);
    return {
      userId: String(user.id),
      username: user.username,
      scopes: token?.scopes ?? [],
      expiresAt: token?.expires_at ? new Date(`${token.expires_at}T00:00:00.000Z`) : null,
    };
  }

  async getProjectAccess(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectAccess> {
    const resolved = await this.client(auth).request<GitLabProject>(this.projectPath(project, ''));
    const levels = [
      resolved.permissions?.project_access?.access_level,
      resolved.permissions?.group_access?.access_level,
    ].filter((level): level is number => typeof level === 'number');
    return {
      project: this.toProjectRef(resolved),
      accessLevel: levels.length > 0 ? Math.max(...levels) : null,
    };
  }

  async testConnection(auth: VcsConnectorAuth): Promise<IntegrationConnectorCapabilities> {
    const client = this.client(auth);
    const capabilities = this.emptyCapabilities();
    await client.request<GitLabUser>('/user');
    capabilities.apiReachable = true;

    const scopes = await this.getTokenScopes(client);
    capabilities.tokenSelf = scopes !== null;
    this.applyScopeCapabilities(capabilities, scopes ?? []);

    const projects = await this.tryListProjects(client, 1);
    capabilities.projectsView = projects !== null;
    const groups = await this.tryListGroups(client, 1);
    capabilities.groupsView = groups !== null;

    const sampleProject = projects?.[0];
    if (!sampleProject) return capabilities;

    await this.detectProjectCapabilities(client, sampleProject, capabilities);
    return capabilities;
  }

  async searchAllowlist(auth: VcsConnectorAuth, query: string): Promise<VcsAllowlistSearchResult[]> {
    const client = this.client(auth);
    const [groups, projects] = await Promise.all([
      client.paginate<GitLabGroup>('/groups', { search: query, per_page: 20 }, 1),
      client.paginate<GitLabProject>('/projects', { search: query, simple: true, per_page: 20 }, 1),
    ]);

    return [
      ...groups.map((group) => ({
        entryType: 'group' as const,
        remoteId: String(group.id),
        fullPath: group.full_path,
        name: group.name,
        webUrl: group.web_url ?? null,
      })),
      ...projects.map((project) => ({
        entryType: 'project' as const,
        remoteId: String(project.id),
        fullPath: project.path_with_namespace,
        name: project.name,
        webUrl: project.web_url ?? null,
      })),
    ];
  }

  async listProjects(auth: VcsConnectorAuth): Promise<VcsProjectRef[]> {
    const projects = await this.client(auth).paginate<GitLabProject>(
      '/projects',
      { simple: true, order_by: 'last_activity_at', sort: 'desc', per_page: 100 },
      10
    );
    return projects.map((project) => this.toProjectRef(project));
  }

  async listRegistries(auth: VcsConnectorAuth, projectsToScan?: VcsProjectRef[]): Promise<VcsRegistryDiscoveryResult> {
    const client = this.client(auth);
    const projects = projectsToScan ?? (await this.listProjects(auth));
    const registries: VcsRegistryRef[] = [];
    const skippedProjects: VcsRegistryDiscoveryResult['skippedProjects'] = [];
    for (const project of projects.slice(0, 100)) {
      const path = `/projects/${encodeURIComponent(project.remoteId)}/registry/repositories`;
      let entries: GitLabRegistryRepository[] | null = null;
      try {
        entries = await client.request<GitLabRegistryRepository[]>(path, {
          query: { per_page: 100 },
          allowNotFound: true,
        });
      } catch (error) {
        if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404)) {
          skippedProjects.push({
            remoteId: project.remoteId,
            fullPath: project.fullPath,
            reason: error.statusCode === 403 ? 'forbidden' : 'not_found',
          });
          continue;
        }
        throw error;
      }
      for (const entry of entries ?? []) {
        if (!entry.location) continue;
        registries.push({
          remoteRegistryId: String(entry.id),
          projectRemoteId: project.remoteId,
          projectFullPath: project.fullPath,
          registryUrl: entry.location,
          name: entry.name || entry.path || project.name,
        });
      }
    }
    return { registries, skippedProjects };
  }

  async listTree(auth: VcsConnectorAuth, project: VcsProjectRef, path: string, ref?: string): Promise<VcsTreeEntry[]> {
    const entries = await this.client(auth).paginate<GitLabRepositoryTreeEntry>(
      this.projectPath(project, '/repository/tree'),
      { path: path || undefined, ref, per_page: 100 },
      5
    );
    return entries.map((entry) => ({
      id: entry.id ?? null,
      name: entry.name,
      path: entry.path,
      type: entry.type,
      mode: entry.mode ?? null,
    }));
  }

  async readFile(auth: VcsConnectorAuth, request: VcsFileReadRequest): Promise<VcsFileReadResult> {
    const ref = request.ref || request.project.defaultBranch || 'HEAD';
    const file = await this.client(auth).request<GitLabRepositoryFile>(
      this.projectPath(request.project, `/repository/files/${encodeURIComponent(request.path)}`),
      { query: { ref } }
    );
    const decoded = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content);
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const length = Math.min(Math.max(1, Math.floor(request.length ?? 64_000)), 256_000);
    const bytes = decoded.subarray(offset, offset + length);
    const truncated = offset + bytes.byteLength < decoded.byteLength;
    return {
      path: file.file_path,
      ref: file.ref,
      content: bytes.toString('utf8'),
      encoding: 'utf8',
      size: file.size,
      offset,
      bytesRead: bytes.byteLength,
      truncated,
      nextOffset: truncated ? offset + bytes.byteLength : null,
      blobId: file.blob_id ?? null,
      commitId: file.commit_id ?? null,
    };
  }

  async getBranchAccess(auth: VcsConnectorAuth, project: VcsProjectRef, branch: string): Promise<VcsBranchAccess> {
    const result = await this.client(auth).request<GitLabBranch | null>(
      this.projectPath(project, `/repository/branches/${encodeURIComponent(branch)}`),
      { allowNotFound: true }
    );
    return result
      ? {
          exists: true,
          canPush: result.can_push === true,
          ...(result.commit?.id ? { commitSha: result.commit.id } : {}),
        }
      : { exists: false, canPush: false };
  }

  async createBranch(auth: VcsConnectorAuth, project: VcsProjectRef, branch: string, ref: string): Promise<void> {
    await this.client(auth).request(this.projectPath(project, '/repository/branches'), {
      method: 'POST',
      body: { branch, ref },
    });
  }

  async commitFiles(auth: VcsConnectorAuth, request: VcsCommitRequest): Promise<VcsCommitResult> {
    const commit = await this.client(auth).request<GitLabCommit>(
      this.projectPath(request.project, '/repository/commits'),
      {
        method: 'POST',
        body: {
          branch: request.branch,
          commit_message: request.commitMessage,
          start_branch: request.startBranch,
          actions: request.changes.map((change) => ({
            action: change.action,
            file_path: change.path,
            previous_path: change.previousPath,
            content: change.content,
            encoding: change.encoding === 'base64' ? 'base64' : undefined,
          })),
        },
      }
    );
    return { commitSha: commit.id, webUrl: commit.web_url ?? null };
  }

  async lintCiConfig(auth: VcsConnectorAuth, _project: VcsProjectRef, content: string): Promise<VcsCiLintResult> {
    const result = await this.client(auth).request<GitLabCiLintResponse>('/ci/lint', {
      method: 'POST',
      body: { content, include_merged_yaml: true },
    });
    return {
      valid: result.valid,
      errors: result.errors ?? [],
      warnings: result.warnings ?? [],
      mergedYaml: result.merged_yaml ?? null,
    };
  }

  async listPipelines(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    limit = 20
  ): Promise<VcsPipelineRef[]> {
    const pipelines = await this.client(auth).paginate<GitLabPipeline>(
      this.projectPath(project, '/pipelines'),
      { ref, per_page: Math.min(Math.max(limit, 1), 100) },
      1
    );
    return pipelines.slice(0, limit).map((pipeline) => this.toPipelineRef(pipeline));
  }

  async getPipeline(auth: VcsConnectorAuth, project: VcsProjectRef, pipelineId: number): Promise<VcsPipelineRef> {
    const pipeline = await this.client(auth).request<GitLabPipeline>(
      this.projectPath(project, `/pipelines/${pipelineId}`)
    );
    return this.toPipelineRef(pipeline);
  }

  async listPipelineJobs(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    pipelineId: number,
    limit = 50
  ): Promise<VcsPipelineJobRef[]> {
    const jobs = await this.client(auth).paginate<GitLabJob>(
      this.projectPath(project, `/pipelines/${pipelineId}/jobs`),
      { per_page: Math.min(Math.max(limit, 1), 100) },
      1
    );
    return jobs.slice(0, limit).map((job) => ({
      id: job.id,
      name: job.name,
      stage: job.stage ?? null,
      status: job.status ?? null,
      ref: job.ref ?? null,
      webUrl: job.web_url ?? null,
      createdAt: job.created_at ?? null,
      startedAt: job.started_at ?? null,
      finishedAt: job.finished_at ?? null,
    }));
  }

  async getJobLog(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    jobId: number,
    limitBytes: number
  ): Promise<VcsJobLogResult> {
    const { buffer } = await this.client(auth).requestBuffer(this.projectPath(project, `/jobs/${jobId}/trace`), {
      maxBytes: Math.min(Math.max(limitBytes, 1), 1_000_000),
    });
    return {
      jobId,
      output: buffer.toString('utf8'),
      bytesRead: buffer.byteLength,
      totalBytes: buffer.byteLength,
      truncated: false,
    };
  }

  async listProjectVariables(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectVariableRef[]> {
    const variables = await this.client(auth).paginate<GitLabVariable>(
      this.projectPath(project, '/variables'),
      { per_page: 100 },
      5
    );
    return variables.map((variable) => this.toVariableRef(variable));
  }

  async setProjectVariable(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectVariableInput
  ): Promise<VcsProjectVariableRef> {
    const body = this.toVariableBody(input);
    const query = input.environmentScope
      ? { filter: JSON.stringify({ environment_scope: input.environmentScope }) }
      : {};
    const keyPath = this.projectPath(project, `/variables/${encodeURIComponent(input.key)}`);
    const client = this.client(auth);
    const updated = await client
      .request<GitLabVariable>(keyPath, { method: 'PUT', query, body, allowNotFound: true })
      .catch((error) => {
        if (error instanceof AppError && error.statusCode === 404) return null;
        throw error;
      });
    if (updated) return this.toVariableRef(updated);
    const created = await client.request<GitLabVariable>(this.projectPath(project, '/variables'), {
      method: 'POST',
      body,
    });
    return this.toVariableRef(created);
  }

  async deleteProjectVariable(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    key: string,
    environmentScope?: string
  ): Promise<void> {
    const query = environmentScope ? { filter: JSON.stringify({ environment_scope: environmentScope }) } : {};
    await this.client(auth).request(this.projectPath(project, `/variables/${encodeURIComponent(key)}`), {
      method: 'DELETE',
      query,
    });
  }

  async listProjectWebhooks(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectWebhookRef[]> {
    const hooks = await this.client(auth).paginate<GitLabProjectHook>(
      this.projectPath(project, '/hooks'),
      { per_page: 100 },
      5
    );
    return hooks.map((hook) => this.toWebhookRef(hook));
  }

  async createOrUpdateProjectWebhook(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectWebhookInput
  ): Promise<VcsProjectWebhookRef> {
    const body = {
      url: input.url,
      token: input.token,
      push_events: input.pushEvents,
      merge_requests_events: input.mergeRequestsEvents,
      tag_push_events: input.tagPushEvents,
      job_events: input.jobEvents,
      pipeline_events: input.pipelineEvents,
      enable_ssl_verification: input.enableSslVerification,
    };
    const hook = await this.client(auth).request<GitLabProjectHook>(
      this.projectPath(project, input.id ? `/hooks/${input.id}` : '/hooks'),
      { method: input.id ? 'PUT' : 'POST', body }
    );
    return this.toWebhookRef(hook);
  }

  async deleteProjectWebhook(auth: VcsConnectorAuth, project: VcsProjectRef, hookId: number): Promise<void> {
    await this.client(auth).request(this.projectPath(project, `/hooks/${hookId}`), { method: 'DELETE' });
  }

  async listRegistryRepositories(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsRegistryRepositoryRef[]> {
    const repositories = await this.client(auth).paginate<GitLabRegistryRepository>(
      this.projectPath(project, '/registry/repositories'),
      { per_page: 100, tags_count: true },
      2
    );
    return repositories.map((repository) => ({
      id: String(repository.id),
      name: repository.name || repository.path || project.name,
      path: repository.path ?? null,
      location: repository.location ?? null,
      tagsCount: (repository as { tags_count?: number }).tags_count ?? null,
    }));
  }

  async createDeployToken(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsDeployTokenInput
  ): Promise<VcsDeployTokenResult> {
    const token = await this.client(auth).request<GitLabDeployToken>(this.projectPath(project, '/deploy_tokens'), {
      method: 'POST',
      body: {
        name: input.name,
        scopes: input.scopes,
        expires_at: input.expiresAt,
      },
    });
    return {
      id: token.id,
      name: token.name,
      username: token.username,
      token: token.token,
      scopes: token.scopes ?? input.scopes,
      expiresAt: token.expires_at ?? input.expiresAt ?? null,
    };
  }

  async updateProjectSettings(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectSettingsInput
  ): Promise<VcsProjectSettingsResult> {
    const updated = await this.client(auth).request<GitLabProject>(this.projectPath(project, ''), {
      method: 'PUT',
      body: {
        container_registry_access_level: input.containerRegistryAccessLevel,
      },
    });
    return {
      remoteId: String(updated.id),
      fullPath: updated.path_with_namespace,
      name: updated.name,
      webUrl: updated.web_url ?? null,
      containerRegistryAccessLevel: updated.container_registry_access_level ?? null,
    };
  }

  async downloadRepositoryArchive(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    options: { maxBytes?: number; timeoutMs?: number } = {}
  ): Promise<VcsArchiveResult> {
    const { buffer, contentType } = await this.client(auth).requestBuffer(
      this.projectPath(project, '/repository/archive.tar.gz'),
      {
        query: { sha: ref },
        timeoutMs: options.timeoutMs ?? 120_000,
        maxBytes: options.maxBytes ?? 200 * 1024 * 1024,
      }
    );
    return {
      filename: `${project.name || project.remoteId}.tar.gz`,
      contentType,
      bytes: buffer,
    };
  }

  async streamRepositoryArchive(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    options: { maxBytes?: number; timeoutMs?: number } = {}
  ): Promise<VcsArchiveStream> {
    const archive = await this.client(auth).requestStream(this.projectPath(project, '/repository/archive.tar.gz'), {
      query: { sha: ref },
      timeoutMs: options.timeoutMs ?? 120_000,
      maxBytes: options.maxBytes ?? 200 * 1024 * 1024,
    });
    return {
      filename: `${project.name || project.remoteId}.tar.gz`,
      contentType: archive.contentType,
      chunks: archive.chunks,
    };
  }

  private client(auth: VcsConnectorAuth) {
    return new GitLabClient(auth.baseUrl, auth.token, this.fetchImpl);
  }

  private projectPath(project: VcsProjectRef, suffix: string) {
    return `/projects/${encodeURIComponent(project.remoteId)}${suffix}`;
  }

  private emptyCapabilities(): IntegrationConnectorCapabilities {
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
  }

  private async getTokenScopes(client: GitLabClient): Promise<string[] | null> {
    const token = await this.getTokenMetadata(client);
    return Array.isArray(token?.scopes) ? token.scopes : null;
  }

  private async getTokenMetadata(client: GitLabClient): Promise<GitLabTokenSelf | null> {
    try {
      return await client.request<GitLabTokenSelf>('/personal_access_tokens/self', { allowNotFound: true });
    } catch {
      return null;
    }
  }

  private applyScopeCapabilities(capabilities: IntegrationConnectorCapabilities, scopes: string[]) {
    const has = (scope: string) => scopes.includes(scope);
    const api = has('api');
    const readApi = api || has('read_api');
    const readRepository = api || has('read_repository') || has('write_repository');
    const writeRepository = api || has('write_repository');
    const readRegistry = api || has('read_registry') || has('write_registry');
    const writeRegistry = api || has('write_registry');

    capabilities.projectsView = capabilities.projectsView || readApi;
    capabilities.groupsView = capabilities.groupsView || readApi;
    capabilities.repoRead = capabilities.repoRead || readRepository;
    capabilities.repoWrite = capabilities.repoWrite || writeRepository;
    capabilities.ciView = capabilities.ciView || readApi;
    capabilities.ciLint = capabilities.ciLint || readApi;
    capabilities.ciEdit = capabilities.ciEdit || (writeRepository && readApi);
    capabilities.pipelineRead = capabilities.pipelineRead || readApi;
    capabilities.variablesView = capabilities.variablesView || readApi;
    capabilities.variablesEdit = capabilities.variablesEdit || api;
    capabilities.variablesDelete = capabilities.variablesDelete || api;
    capabilities.registryView = capabilities.registryView || readRegistry;
    capabilities.registryUse = capabilities.registryUse || readRegistry || writeRegistry;
    capabilities.webhooksManage = capabilities.webhooksManage || api;
    capabilities.deployTokensManage = capabilities.deployTokensManage || api;
  }

  private async tryListProjects(client: GitLabClient, maxPages: number): Promise<GitLabProject[] | null> {
    try {
      return await client.paginate<GitLabProject>(
        '/projects',
        { membership: true, simple: true, per_page: 100 },
        maxPages
      );
    } catch {
      return null;
    }
  }

  private async tryListGroups(client: GitLabClient, maxPages: number): Promise<GitLabGroup[] | null> {
    try {
      return await client.paginate<GitLabGroup>('/groups', { per_page: 100 }, maxPages);
    } catch {
      return null;
    }
  }

  private async detectProjectCapabilities(
    client: GitLabClient,
    project: GitLabProject,
    capabilities: IntegrationConnectorCapabilities
  ) {
    const projectId = encodeURIComponent(String(project.id));
    capabilities.repoRead =
      capabilities.repoRead ||
      (await this.probe(() => client.request(`/projects/${projectId}/repository/tree`, { query: { per_page: 1 } })));
    capabilities.pipelineRead =
      capabilities.pipelineRead ||
      (await this.probe(() => client.request(`/projects/${projectId}/pipelines`, { query: { per_page: 1 } })));
    capabilities.ciView = capabilities.ciView || capabilities.pipelineRead;
    capabilities.variablesView =
      capabilities.variablesView ||
      (await this.probe(() => client.request(`/projects/${projectId}/variables`, { query: { per_page: 1 } })));
    capabilities.registryView =
      capabilities.registryView ||
      (await this.probe(() =>
        client.request(`/projects/${projectId}/registry/repositories`, { query: { per_page: 1 }, allowNotFound: true })
      ));
    capabilities.ciLint =
      capabilities.ciLint ||
      (await this.probe(() =>
        client.request('/ci/lint', {
          method: 'POST',
          body: { content: 'stages: [test]\nnoop:\n  stage: test\n  script: echo ok\n' },
        })
      ));
  }

  private async probe(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }

  private toProjectRef(project: GitLabProject): VcsProjectRef {
    return {
      remoteId: String(project.id),
      fullPath: project.path_with_namespace,
      name: project.name,
      webUrl: project.web_url ?? null,
      visibility: project.visibility ?? null,
      defaultBranch: project.default_branch ?? null,
      archived: project.archived ?? false,
    };
  }

  private toPipelineRef(pipeline: GitLabPipeline): VcsPipelineRef {
    return {
      id: pipeline.id,
      iid: pipeline.iid ?? null,
      ref: pipeline.ref ?? null,
      sha: pipeline.sha ?? null,
      status: pipeline.status ?? null,
      source: pipeline.source ?? null,
      webUrl: pipeline.web_url ?? null,
      createdAt: pipeline.created_at ?? null,
      updatedAt: pipeline.updated_at ?? null,
    };
  }

  private toVariableRef(variable: GitLabVariable): VcsProjectVariableRef {
    return {
      key: variable.key,
      variableType: variable.variable_type ?? null,
      protected: variable.protected ?? false,
      masked: variable.masked ?? false,
      raw: variable.raw ?? false,
      environmentScope: variable.environment_scope ?? null,
      description: variable.description ?? null,
    };
  }

  private toVariableBody(input: VcsProjectVariableInput) {
    return {
      key: input.key,
      value: input.value,
      variable_type: input.variableType ?? 'env_var',
      protected: input.protected,
      masked: input.masked,
      raw: input.raw,
      environment_scope: input.environmentScope,
      description: input.description,
    };
  }

  private toWebhookRef(hook: GitLabProjectHook): VcsProjectWebhookRef {
    return {
      id: hook.id,
      url: hook.url,
      pushEvents: hook.push_events ?? false,
      mergeRequestsEvents: hook.merge_requests_events ?? false,
      tagPushEvents: hook.tag_push_events ?? false,
      jobEvents: hook.job_events ?? false,
      pipelineEvents: hook.pipeline_events ?? false,
      enableSslVerification: hook.enable_ssl_verification ?? false,
      createdAt: hook.created_at ?? null,
    };
  }
}
