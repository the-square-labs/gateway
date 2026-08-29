export interface GitLabUser {
  id: number;
  username: string;
}

export interface GitLabTokenSelf {
  scopes?: string[];
  expires_at?: string | null;
}

export interface GitLabProject {
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

export interface GitLabGroup {
  id: number;
  full_path: string;
  name: string;
  web_url?: string;
}

export interface GitLabRegistryRepository {
  id: number;
  path?: string;
  location?: string;
  name?: string;
}

export interface GitLabRepositoryTreeEntry {
  id?: string;
  name: string;
  type: 'tree' | 'blob' | 'commit';
  path: string;
  mode?: string;
}

export interface GitLabRepositoryFile {
  file_path: string;
  ref: string;
  blob_id?: string;
  commit_id?: string;
  size: number;
  encoding: 'base64' | string;
  content: string;
}

export interface GitLabCommit {
  id: string;
  web_url?: string;
}

export interface GitLabBranch {
  can_push?: boolean;
  commit?: {
    id?: string;
  } | null;
}

export interface GitLabCiLintResponse {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  merged_yaml?: string | null;
}

export interface GitLabPipeline {
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

export interface GitLabJob {
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

export interface GitLabVariable {
  key: string;
  variable_type?: string;
  protected?: boolean;
  masked?: boolean;
  raw?: boolean;
  environment_scope?: string;
  description?: string;
}

export interface GitLabProjectHook {
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

export interface GitLabDeployToken {
  id: number | string;
  name: string;
  username: string;
  token: string;
  scopes?: string[];
  expires_at?: string | null;
}

export const CAPABILITY_KEYS = [
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
