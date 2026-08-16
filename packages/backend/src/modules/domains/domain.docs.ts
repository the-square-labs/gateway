import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  optionalJsonBody,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  CreateDomainSchema,
  DeleteDomainSchema,
  DomainIngressMigrationSchema,
  DomainListQuerySchema,
  PreviewDomainSchema,
  ResolveCloudflareMigrationSchema,
  UpdateDomainSchema,
} from './domain.schemas.js';

export const listDomainFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['Domains'],
  summary: 'List domain folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createDomainFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['Domains'],
  summary: 'Create a domain folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderDomainFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['Domains'],
  summary: 'Reorder domain folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const moveDomainsToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-domains',
  tags: ['Domains'],
  summary: 'Move domains to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderDomainsRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-domains',
  tags: ['Domains'],
  summary: 'Reorder domains within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDomainFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['Domains'],
  summary: 'Rename a domain folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveDomainFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['Domains'],
  summary: 'Move a domain folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDomainFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['Domains'],
  summary: 'Delete a domain folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listDomainsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Domains'],
  summary: 'List domains',
  request: { query: DomainListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const searchDomainsRoute = appRoute({
  method: 'get',
  path: '/search',
  tags: ['Domains'],
  summary: 'Search domains for autocomplete',
  responses: okJson(UnknownDataResponseSchema),
});

export const listDomainNginxNodesRoute = appRoute({
  method: 'get',
  path: '/nginx-nodes',
  tags: ['Domains'],
  summary: 'List eligible Nginx ingress nodes for domains',
  responses: okJson(UnknownDataResponseSchema),
});

export const getDomainRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Get domain details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createDomainRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Domains'],
  summary: 'Create a domain',
  request: jsonBody(CreateDomainSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const previewDomainRoute = appRoute({
  method: 'post',
  path: '/preview',
  tags: ['Domains'],
  summary: 'Preview DNS readiness for a domain',
  request: jsonBody(PreviewDomainSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDomainRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Update a domain',
  request: { params: IdParamSchema, ...jsonBody(UpdateDomainSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDomainRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Delete a domain',
  request: { params: IdParamSchema, ...optionalJsonBody(DeleteDomainSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const checkDomainDnsRoute = appRoute({
  method: 'post',
  path: '/{id}/check-dns',
  tags: ['Domains'],
  summary: 'Run a DNS check for a domain',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const resolveCloudflareMigrationRoute = appRoute({
  method: 'post',
  path: '/{id}/cloudflare-migration/resolve',
  tags: ['Domains'],
  summary: 'Resolve a Cloudflare migration conflict',
  request: { params: IdParamSchema, ...jsonBody(ResolveCloudflareMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const previewDomainIngressMigrationRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-migration/preview',
  tags: ['Domains'],
  summary: 'Preview a domain ingress migration',
  request: { params: IdParamSchema, ...jsonBody(DomainIngressMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const migrateDomainIngressRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-migration',
  tags: ['Domains'],
  summary: 'Move a domain and its routes to another nginx ingress node',
  request: { params: IdParamSchema, ...jsonBody(DomainIngressMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const issueDomainCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/issue-cert',
  tags: ['Domains'],
  summary: 'Issue an ACME certificate for a domain',
  request: { params: IdParamSchema },
  responses: createdJson(UnknownDataResponseSchema),
});
