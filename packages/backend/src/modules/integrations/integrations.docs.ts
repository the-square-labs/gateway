import { z } from 'zod';
import {
  appRoute,
  createdJson,
  dataResponseSchema,
  jsonBody,
  listResponseSchema,
  okJson,
  pathParamSchema,
  successJson,
} from '@/lib/openapi.js';
import {
  GitHubScopeTargetsSchema,
  GitLabScopeTargetsSchema,
  ScopeTargetParamsSchema,
  ScopeTargetResolutionSchema,
  ScopeTargetResolveQuerySchema,
  ScopeTargetSearchQuerySchema,
} from './git-scope-targets.js';
import {
  CloudflareConnectorCreateSchema,
  CloudflareConnectorListQuerySchema,
  CloudflareConnectorPreviewTestSchema,
  CloudflareConnectorRotateTokenSchema,
  CloudflareConnectorUpdateSchema,
  GitLabAllowlistPreviewSearchSchema,
  GitLabAllowlistSearchQuerySchema,
  GitLabConnectorCreateSchema,
  GitLabConnectorListQuerySchema,
  GitLabConnectorPreviewTestSchema,
  GitLabConnectorRotateTokenSchema,
  GitLabConnectorUpdateSchema,
  GitLabUserCredentialAuthorizeSchema,
} from './integrations.schemas.js';

const connectorParams = pathParamSchema('id');

const GitLabConnectorSettingsResponseSchema = z.object({
  autoSyncEnabled: z.boolean(),
  autoSyncIntervalSeconds: z.number(),
  cloneShallow: z.boolean(),
  cloneDepth: z.number(),
  cloneLfs: z.boolean(),
  cloneSubmodules: z.boolean(),
  cloneMaxSizeMb: z.number(),
  cloneTimeoutSeconds: z.number(),
});

const GitLabConnectorResponseSchema = z.object({
  id: z.string().uuid(),
  provider: z.literal('gitlab'),
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  allowlistMode: z.enum(['selected', 'all_visible']),
  settings: GitLabConnectorSettingsResponseSchema,
  capabilities: z.record(z.boolean()),
  syncStatus: z.enum(['never', 'idle', 'running', 'success', 'error']),
  syncLastError: z.string().nullable().optional(),
  syncFailureCount: z.number(),
  syncStartedAt: z.string().nullable().optional(),
  syncFinishedAt: z.string().nullable().optional(),
  syncLastOverlapAt: z.string().nullable().optional(),
  syncNextRetryAt: z.string().nullable().optional(),
  testedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasToken: z.boolean(),
  tokenMasked: z.string().nullable(),
});

const GitLabAllowlistEntryResponseSchema = z.object({
  entryType: z.enum(['group', 'project']),
  remoteId: z.string(),
  fullPath: z.string(),
  name: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
});

const GitLabConnectorWithAllowlistResponseSchema = GitLabConnectorResponseSchema.extend({
  allowlistEntries: z.array(GitLabAllowlistEntryResponseSchema),
});

const GitLabSyncResponseSchema = z.object({
  status: z.string(),
  projectCount: z.number().optional(),
  registryCount: z.number().optional(),
  reason: z.string().optional(),
});

const GitLabPreviewTestResponseSchema = z.object({
  capabilities: z.record(z.boolean()),
  allowlistEntries: z.array(GitLabAllowlistEntryResponseSchema),
});

const GitLabUserCredentialResponseSchema = z.object({
  connectorId: z.string().uuid(),
  connectorName: z.string(),
  baseUrl: z.string().url(),
  patCreationUrl: z.string().url(),
  authorized: z.boolean(),
  status: z.enum(['missing', 'valid', 'invalid']),
  tokenMasked: z.string().nullable(),
  gitlabUserId: z.string().nullable(),
  gitlabUsername: z.string().nullable(),
  tokenScopes: z.array(z.string()),
  tokenExpiresAt: z.string().nullable(),
  lastValidatedAt: z.string().nullable(),
});

const CloudflareConnectorSettingsResponseSchema = z.object({
  autoSyncEnabled: z.boolean(),
  autoSyncIntervalSeconds: z.number(),
  defaultTtl: z.number(),
  defaultProxied: z.boolean(),
});

const CloudflareZoneResponseSchema = z.object({
  id: z.string().uuid().optional(),
  connectorId: z.string().uuid().optional(),
  remoteId: z.string(),
  name: z.string(),
  status: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  accountName: z.string().nullable().optional(),
  lastSeenAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const CloudflareConnectorResponseSchema = z.object({
  id: z.string().uuid(),
  provider: z.literal('cloudflare'),
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  allowlistMode: z.enum(['selected', 'all_visible']),
  settings: CloudflareConnectorSettingsResponseSchema,
  capabilities: z.record(z.boolean()),
  syncStatus: z.enum(['never', 'idle', 'running', 'success', 'error']),
  syncLastError: z.string().nullable().optional(),
  syncFailureCount: z.number(),
  syncStartedAt: z.string().nullable().optional(),
  syncFinishedAt: z.string().nullable().optional(),
  syncLastOverlapAt: z.string().nullable().optional(),
  syncNextRetryAt: z.string().nullable().optional(),
  testedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasToken: z.boolean(),
  tokenMasked: z.string().nullable(),
});

const CloudflareConnectorWithZonesResponseSchema = CloudflareConnectorResponseSchema.extend({
  zones: z.array(CloudflareZoneResponseSchema),
});

const CloudflarePreviewTestResponseSchema = z.object({
  capabilities: z.record(z.boolean()),
  zones: z.array(CloudflareZoneResponseSchema),
});

const CloudflareSyncResponseSchema = z.object({
  status: z.string(),
  zoneCount: z.number().optional(),
  reason: z.string().optional(),
});

export const listGitLabConnectorsRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors',
  tags: ['Integrations'],
  summary: 'List GitLab connectors',
  description: 'Lists configured GitLab connectors. PATs are never returned; token metadata is masked as ****last4.',
  request: { query: GitLabConnectorListQuerySchema },
  responses: okJson(listResponseSchema(GitLabConnectorResponseSchema)),
});

export const createGitLabConnectorRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors',
  tags: ['Integrations'],
  summary: 'Create a GitLab connector',
  description:
    'Creates a system-level GitLab connector backed by an encrypted PAT. The raw PAT is accepted only on write and is never returned.',
  request: jsonBody(GitLabConnectorCreateSchema),
  responses: createdJson(dataResponseSchema(GitLabConnectorWithAllowlistResponseSchema)),
});

export const previewGitLabAllowlistRoute = appRoute({
  method: 'post',
  path: '/gitlab/allowlist/preview-search',
  tags: ['Integrations'],
  summary: 'Search GitLab projects and groups before saving a connector',
  description:
    'Uses the submitted GitLab URL and PAT for a one-time allowlist search. The PAT is not stored and is never returned.',
  request: jsonBody(GitLabAllowlistPreviewSearchSchema),
  responses: okJson(listResponseSchema(GitLabAllowlistEntryResponseSchema)),
});

export const previewGitLabConnectorTestRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors/preview-test',
  tags: ['Integrations'],
  summary: 'Test GitLab connection before saving a connector',
  description:
    'Uses the submitted GitLab URL and PAT for a one-time connection test and project preview. The PAT is not stored and is never returned.',
  request: jsonBody(GitLabConnectorPreviewTestSchema),
  responses: okJson(dataResponseSchema(GitLabPreviewTestResponseSchema)),
});

export const getGitLabConnectorRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Get a GitLab connector',
  description: 'Returns connector settings, masked token metadata, capabilities, sync status, and allowlist entries.',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(GitLabConnectorWithAllowlistResponseSchema)),
});

export const updateGitLabConnectorRoute = appRoute({
  method: 'patch',
  path: '/gitlab/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Update a GitLab connector',
  description:
    'Updates connector metadata, allowlist, database-backed runtime settings, and optionally replaces the PAT.',
  request: { params: connectorParams, ...jsonBody(GitLabConnectorUpdateSchema) },
  responses: okJson(dataResponseSchema(GitLabConnectorWithAllowlistResponseSchema)),
});

export const deleteGitLabConnectorRoute = appRoute({
  method: 'delete',
  path: '/gitlab/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Delete a GitLab connector',
  request: { params: connectorParams },
  responses: successJson,
});

export const rotateGitLabConnectorTokenRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors/{id}/token',
  tags: ['Integrations'],
  summary: 'Rotate a GitLab connector token',
  description: 'Replaces the encrypted PAT. The raw token is accepted only in this request and is never returned.',
  request: { params: connectorParams, ...jsonBody(GitLabConnectorRotateTokenSchema) },
  responses: okJson(dataResponseSchema(GitLabConnectorResponseSchema)),
});

export const getGitLabConnectorCapabilitiesRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors/{id}/capabilities',
  tags: ['Integrations'],
  summary: 'Get detected GitLab connector capabilities',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(z.record(z.boolean()))),
});

export const testGitLabConnectorRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors/{id}/test',
  tags: ['Integrations'],
  summary: 'Test a GitLab connector',
  description: 'Tests the stored PAT and updates detected capabilities without returning the token.',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(GitLabConnectorResponseSchema)),
});

export const syncGitLabConnectorRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors/{id}/sync',
  tags: ['Integrations'],
  summary: 'Sync a GitLab connector',
  description:
    'Synchronizes allowed GitLab projects and registries. Registry credentials remain connector-backed and are not returned.',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(GitLabSyncResponseSchema)),
});

export const getGitLabUserCredentialRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors/{id}/user-credential',
  tags: ['Integrations'],
  summary: 'Get current user GitLab authorization status',
  description: 'Returns only masked metadata for the authenticated browser user. The PAT is never returned.',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(GitLabUserCredentialResponseSchema)),
});

export const authorizeGitLabUserCredentialRoute = appRoute({
  method: 'put',
  path: '/gitlab/connectors/{id}/user-credential',
  tags: ['Integrations'],
  summary: 'Authorize the current user for a GitLab connector',
  description: 'Validates the submitted PAT against GitLab and stores it encrypted for this user and connector.',
  request: { params: connectorParams, ...jsonBody(GitLabUserCredentialAuthorizeSchema) },
  responses: okJson(dataResponseSchema(GitLabUserCredentialResponseSchema)),
});

export const disconnectGitLabUserCredentialRoute = appRoute({
  method: 'delete',
  path: '/gitlab/connectors/{id}/user-credential',
  tags: ['Integrations'],
  summary: 'Disconnect the current user from a GitLab connector',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(z.object({ disconnected: z.boolean() }))),
});

export const searchGitLabAllowlistRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors/{id}/allowlist/search',
  tags: ['Integrations'],
  summary: 'Search GitLab projects and groups for allowlist selection',
  request: { params: connectorParams, query: GitLabAllowlistSearchQuerySchema },
  responses: okJson(listResponseSchema(GitLabAllowlistEntryResponseSchema)),
});

export const listGitLabAllowlistOptionsRoute = appRoute({
  method: 'get',
  path: '/gitlab/connectors/{id}/allowlist/options',
  tags: ['Integrations'],
  summary: 'List GitLab projects available for allowlist selection',
  request: { params: connectorParams },
  responses: okJson(listResponseSchema(GitLabAllowlistEntryResponseSchema)),
});

export const refreshGitLabAllowlistOptionsRoute = appRoute({
  method: 'post',
  path: '/gitlab/connectors/{id}/allowlist/options/refresh',
  tags: ['Integrations'],
  summary: 'Refresh cached GitLab projects for allowlist selection',
  request: { params: connectorParams },
  responses: okJson(listResponseSchema(GitLabAllowlistEntryResponseSchema)),
});

export const listCloudflareConnectorsRoute = appRoute({
  method: 'get',
  path: '/cloudflare/connectors',
  tags: ['Integrations'],
  summary: 'List Cloudflare connectors',
  description: 'Lists configured Cloudflare DNS connectors. API tokens are never returned.',
  request: { query: CloudflareConnectorListQuerySchema },
  responses: okJson(listResponseSchema(CloudflareConnectorResponseSchema)),
});

export const createCloudflareConnectorRoute = appRoute({
  method: 'post',
  path: '/cloudflare/connectors',
  tags: ['Integrations'],
  summary: 'Create a Cloudflare connector',
  description:
    'Creates a system-level Cloudflare connector backed by an encrypted API token and syncs available DNS zones.',
  request: jsonBody(CloudflareConnectorCreateSchema),
  responses: createdJson(dataResponseSchema(CloudflareConnectorWithZonesResponseSchema)),
});

export const previewCloudflareConnectorTestRoute = appRoute({
  method: 'post',
  path: '/cloudflare/connectors/preview-test',
  tags: ['Integrations'],
  summary: 'Test Cloudflare connection before saving a connector',
  description: 'Uses the submitted Cloudflare token for a one-time connection test. The token is not stored.',
  request: jsonBody(CloudflareConnectorPreviewTestSchema),
  responses: okJson(dataResponseSchema(CloudflarePreviewTestResponseSchema)),
});

export const getCloudflareConnectorRoute = appRoute({
  method: 'get',
  path: '/cloudflare/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Get a Cloudflare connector',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(CloudflareConnectorWithZonesResponseSchema)),
});

export const updateCloudflareConnectorRoute = appRoute({
  method: 'patch',
  path: '/cloudflare/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Update a Cloudflare connector',
  request: { params: connectorParams, ...jsonBody(CloudflareConnectorUpdateSchema) },
  responses: okJson(dataResponseSchema(CloudflareConnectorWithZonesResponseSchema)),
});

export const deleteCloudflareConnectorRoute = appRoute({
  method: 'delete',
  path: '/cloudflare/connectors/{id}',
  tags: ['Integrations'],
  summary: 'Delete a Cloudflare connector',
  request: { params: connectorParams },
  responses: successJson,
});

export const rotateCloudflareConnectorTokenRoute = appRoute({
  method: 'post',
  path: '/cloudflare/connectors/{id}/token',
  tags: ['Integrations'],
  summary: 'Rotate a Cloudflare connector token',
  request: { params: connectorParams, ...jsonBody(CloudflareConnectorRotateTokenSchema) },
  responses: okJson(dataResponseSchema(CloudflareConnectorWithZonesResponseSchema)),
});

export const testCloudflareConnectorRoute = appRoute({
  method: 'post',
  path: '/cloudflare/connectors/{id}/test',
  tags: ['Integrations'],
  summary: 'Test a Cloudflare connector',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(CloudflareConnectorResponseSchema)),
});

export const syncCloudflareConnectorRoute = appRoute({
  method: 'post',
  path: '/cloudflare/connectors/{id}/sync',
  tags: ['Integrations'],
  summary: 'Sync a Cloudflare connector',
  description: 'Synchronizes Cloudflare zones used for DNS autodetection.',
  request: { params: connectorParams },
  responses: okJson(dataResponseSchema(CloudflareSyncResponseSchema)),
});

export const listCloudflareZonesRoute = appRoute({
  method: 'get',
  path: '/cloudflare/connectors/{id}/zones',
  tags: ['Integrations'],
  summary: 'List cached Cloudflare zones',
  request: { params: connectorParams },
  responses: okJson(listResponseSchema(CloudflareZoneResponseSchema)),
});

export const listGitScopeTargetsRoute = appRoute({
  method: 'get',
  path: '/{provider}/{connectorId}/scope-targets',
  tags: ['Integrations'],
  summary: 'Search groups, projects, owners and repositories for Git scope restrictions',
  description:
    'Scope picker search for one GitLab or GitHub connector. GitLab returns groups and projects, GitHub owners and ' +
    'repositories; IDs are the stable provider IDs that qualifiers use (`<connectorId>/group/<id>`, ' +
    '`<connectorId>/project/<id>`, `<connectorId>/owner/<id>`, `<connectorId>/repo/<id>`). Needs ' +
    '`integrations:<provider>:view` on the connector or on anything in it; results only list what the caller ' +
    'may view. `search` filters by path or name and `limit` (1-100, default 50) caps each list. Provider results ' +
    'are cached briefly per connector.',
  request: { params: ScopeTargetParamsSchema, query: ScopeTargetSearchQuerySchema },
  responses: okJson(z.union([GitLabScopeTargetsSchema, GitHubScopeTargetsSchema])),
});

export const resolveGitScopeTargetsRoute = appRoute({
  method: 'get',
  path: '/{provider}/{connectorId}/scope-targets/resolve',
  tags: ['Integrations'],
  summary: 'Resolve labels for stored Git scope qualifiers',
  description:
    'Labels for qualifiers relative to the connector, passed as `ids=group/123,project/456` (GitLab) or ' +
    '`ids=owner/789,repo/1011` (GitHub), up to 100. `missing` is true when the target no longer exists. A target ' +
    'the caller may not view keeps its raw qualifier as the label. Needs `integrations:<provider>:view` on the ' +
    'connector or on anything in it.',
  request: { params: ScopeTargetParamsSchema, query: ScopeTargetResolveQuerySchema },
  responses: okJson(ScopeTargetResolutionSchema),
});
