import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  LinkInternalCertSchema,
  RequestACMECertSchema,
  SetSslAutoRenewSchema,
  SSLCertListQuerySchema,
  UploadCertSchema,
} from './ssl.schemas.js';

export const listSslCertificateFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['SSL Certificates'],
  summary: 'List SSL certificate folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createSslCertificateFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['SSL Certificates'],
  summary: 'Create an SSL certificate folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderSslCertificateFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['SSL Certificates'],
  summary: 'Reorder SSL certificate folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const moveSslCertificatesToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-certificates',
  tags: ['SSL Certificates'],
  summary: 'Move SSL certificates to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderSslCertificatesRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-certificates',
  tags: ['SSL Certificates'],
  summary: 'Reorder SSL certificates within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateSslCertificateFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['SSL Certificates'],
  summary: 'Rename an SSL certificate folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveSslCertificateFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['SSL Certificates'],
  summary: 'Move an SSL certificate folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteSslCertificateFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['SSL Certificates'],
  summary: 'Delete an SSL certificate folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listSslCertificatesRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['SSL Certificates'],
  summary: 'List SSL certificates',
  request: { query: SSLCertListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getSslCertificateRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['SSL Certificates'],
  summary: 'Get SSL certificate details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const requestAcmeCertificateRoute = appRoute({
  method: 'post',
  path: '/acme',
  tags: ['SSL Certificates'],
  summary: 'Request an ACME certificate',
  request: jsonBody(RequestACMECertSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const uploadSslCertificateRoute = appRoute({
  method: 'post',
  path: '/upload',
  tags: ['SSL Certificates'],
  summary: 'Upload an SSL certificate',
  request: jsonBody(UploadCertSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const linkInternalSslCertificateRoute = appRoute({
  method: 'post',
  path: '/internal',
  tags: ['SSL Certificates'],
  summary: 'Link an internal CA certificate for proxy use',
  request: jsonBody(LinkInternalCertSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const renewSslCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/renew',
  tags: ['SSL Certificates'],
  summary: 'Renew an SSL certificate',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const setSslCertificateAutoRenewRoute = appRoute({
  method: 'patch',
  path: '/{id}/auto-renew',
  tags: ['SSL Certificates'],
  summary: 'Update SSL certificate auto-renewal settings',
  request: { params: IdParamSchema, ...jsonBody(SetSslAutoRenewSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const verifyDnsSslCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/dns-verify',
  tags: ['SSL Certificates'],
  summary: 'Complete DNS-01 certificate verification',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const cancelPendingAcmeCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/acme-cancel',
  tags: ['SSL Certificates'],
  summary: 'Cancel a pending ACME certificate request',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const resyncSslCertificateDistributionRoute = appRoute({
  method: 'post',
  path: '/{id}/distribution/resync',
  tags: ['SSL Certificates'],
  summary: 'Retry SSL certificate deployment to ingress nodes used by active TLS routes',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteSslCertificateRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['SSL Certificates'],
  summary: 'Delete an SSL certificate',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});
