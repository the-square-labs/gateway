import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  LinkInternalCertSchema,
  RequestACMECertSchema,
  SetSslAutoRenewSchema,
  SSLCertListQuerySchema,
  UploadCertSchema,
} from './ssl.schemas.js';

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

export const resyncSslCertificateDistributionRoute = appRoute({
  method: 'post',
  path: '/{id}/distribution/resync',
  tags: ['SSL Certificates'],
  summary: 'Resynchronize SSL certificate distribution',
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
