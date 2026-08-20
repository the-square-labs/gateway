import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
} from './cert.schemas.js';

export const listCertificatesRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Certificates'],
  summary: 'List issued certificates',
  request: { query: CertificateListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getCertificateRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Certificates'],
  summary: 'Get certificate details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const issueCertificateRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Certificates'],
  summary: 'Issue a certificate with server-side key generation',
  request: jsonBody(IssueCertificateSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const issueCertificateFromCSRRoute = appRoute({
  method: 'post',
  path: '/from-csr',
  tags: ['Certificates'],
  summary: 'Issue a certificate from a CSR',
  request: jsonBody(IssueCertFromCSRSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const revokeCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/revoke',
  tags: ['Certificates'],
  summary: 'Revoke a certificate',
  request: { params: IdParamSchema, ...jsonBody(RevokeCertificateSchema) },
  responses: okJson(),
});

export const exportCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/export',
  tags: ['Certificates'],
  summary: 'Export a certificate, PEM chain, private key, or PEM bundle',
  request: { params: IdParamSchema, ...jsonBody(ExportCertificateQuerySchema) },
  responses: { 200: { description: 'Certificate export payload' } },
});

export const certificateChainRoute = appRoute({
  method: 'get',
  path: '/{id}/chain',
  tags: ['Certificates'],
  summary: 'Download certificate chain',
  request: { params: IdParamSchema },
  responses: { 200: { description: 'PEM certificate chain' } },
});
