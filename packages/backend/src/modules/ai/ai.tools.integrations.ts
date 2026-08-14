import type { AIToolDefinition } from './ai.types.js';

const repositoryFields = {
  name: { type: 'string', description: 'Connector name.' },
  baseUrl: { type: 'string', description: 'Provider or Git host base URL.' },
  repositoryMode: { type: 'string', enum: ['single_repository', 'multi_repository'] },
  repositoryUrl: { type: 'string', description: 'Required for single_repository.' },
  repositoryUrls: {
    type: 'array',
    items: { type: 'string' },
    description: 'Explicit repository URLs for multi_repository.',
  },
};

export const INTEGRATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'github_list_connectors',
    description: 'List GitHub connectors without exposing credentials.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'GitHub',
    requiredScope: 'integrations:github:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'git_list_connectors',
    description: 'List generic Git connectors without exposing credentials.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Git',
    requiredScope: 'integrations:git:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'github_list_repository_tree',
    description:
      'List files or directories in an allowed GitHub repository. Use an exact connector UUID from github_list_connectors and an allowed repository URL.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        repositoryUrl: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['connectorId', 'repositoryUrl'],
    },
    destructive: false,
    category: 'GitHub',
    requiredScope: 'integrations:github:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'github_read_repository_file',
    description:
      'Read one text file up to 256 KiB from an allowed GitHub repository. Use an exact connector UUID and repository URL.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        repositoryUrl: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['connectorId', 'repositoryUrl', 'path'],
    },
    destructive: false,
    category: 'GitHub',
    requiredScope: 'integrations:github:view',
    invalidateStores: [],
    historyRetention: { mode: 'recent_full', maxBytes: 262144 },
  },
  {
    name: 'github_upsert_repository_file',
    description:
      'Create or update one text file up to 512 KiB in an allowed GitHub repository. Use for an explicitly requested, approved repository or CI configuration change.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        repositoryUrl: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        message: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['connectorId', 'repositoryUrl', 'path', 'branch', 'message', 'content'],
    },
    destructive: true,
    category: 'GitHub',
    requiredScope: 'integrations:github:manage',
    invalidateStores: ['integrations'],
    effect: 'write',
    approvalClass: 'update',
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'git_list_remote_refs',
    description:
      'Check an allowed generic Git repository and list its advertised branches and tags without exposing connector credentials.',
    parameters: {
      type: 'object',
      properties: { connectorId: { type: 'string' }, repositoryUrl: { type: 'string' } },
      required: ['connectorId', 'repositoryUrl'],
    },
    destructive: false,
    category: 'Git',
    requiredScope: 'integrations:git:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'create_github_token_connector',
    description:
      'Create a GitHub PAT connector only when the user already supplied every field, including the token. If credentials or repository scope are missing, use open_connector_setup instead. OAuth always uses open_connector_setup.',
    parameters: {
      type: 'object',
      properties: {
        ...repositoryFields,
        username: { type: 'string', description: 'Optional GitHub username.' },
        token: { type: 'string', description: 'GitHub personal access token.' },
      },
      required: ['name', 'baseUrl', 'repositoryMode', 'token'],
    },
    destructive: true,
    category: 'GitHub',
    requiredScope: 'integrations:github:manage',
    invalidateStores: ['integrations'],
    effect: 'write',
    approvalClass: 'create',
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'create_git_connector',
    description:
      'Create a generic HTTPS Git connector only when the user already supplied every field, including username and token/password. If anything is missing, use open_connector_setup instead.',
    parameters: {
      type: 'object',
      properties: {
        ...repositoryFields,
        username: { type: 'string', description: 'Git HTTP username.' },
        token: { type: 'string', description: 'Git access token or HTTP password.' },
      },
      required: ['name', 'baseUrl', 'repositoryMode', 'username', 'token'],
    },
    destructive: true,
    category: 'Git',
    requiredScope: 'integrations:git:manage',
    invalidateStores: ['integrations'],
    effect: 'write',
    approvalClass: 'create',
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'create_gitlab_connector',
    description:
      'Create an instance-scoped GitLab connector only when name, base URL, and PAT are already known. If credentials are missing or the user may prefer repository-scoped generic Git, ask first and then use open_connector_setup.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        baseUrl: { type: 'string' },
        token: { type: 'string' },
      },
      required: ['name', 'baseUrl', 'token'],
    },
    destructive: true,
    category: 'GitLab',
    requiredScope: 'integrations:gitlab:manage',
    invalidateStores: ['integrations'],
    effect: 'write',
    approvalClass: 'create',
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'create_cloudflare_connector',
    description:
      'Create a Cloudflare connector only when the user already supplied its name and API token. If the token is missing, use open_connector_setup instead.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, token: { type: 'string' } },
      required: ['name', 'token'],
    },
    destructive: true,
    category: 'Cloudflare',
    requiredScope: 'integrations:cloudflare:manage',
    invalidateStores: ['integrations'],
    effect: 'write',
    approvalClass: 'create',
    historyRetention: { mode: 'never_full' },
  },
];
