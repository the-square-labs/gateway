import { z } from '@hono/zod-openapi';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CreateSiemDestinationSchema,
  SiemDeliveryListQuerySchema,
  SiemDestinationListQuerySchema,
  UpdateSiemDestinationSchema,
} from './siem.schemas.js';

export const listSiemDestinationsRoute = appRoute({
  method: 'get',
  path: '/destinations',
  tags: ['Audit'],
  summary: 'List SIEM audit export destinations',
  request: { query: SiemDestinationListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getSiemDestinationRoute = appRoute({
  method: 'get',
  path: '/destinations/{id}',
  tags: ['Audit'],
  summary: 'Get a SIEM audit export destination',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createSiemDestinationRoute = appRoute({
  method: 'post',
  path: '/destinations',
  tags: ['Audit'],
  summary: 'Create a SIEM audit export destination',
  request: jsonBody(CreateSiemDestinationSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateSiemDestinationRoute = appRoute({
  method: 'put',
  path: '/destinations/{id}',
  tags: ['Audit'],
  summary: 'Update a SIEM audit export destination',
  request: { params: IdParamSchema, ...jsonBody(UpdateSiemDestinationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteSiemDestinationRoute = appRoute({
  method: 'delete',
  path: '/destinations/{id}',
  tags: ['Audit'],
  summary: 'Soft-delete a SIEM destination and discard outstanding deliveries',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const testSiemDestinationRoute = appRoute({
  method: 'post',
  path: '/destinations/{id}/test',
  tags: ['Audit'],
  summary: 'Send a synthetic SIEM test event',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listSiemDeliveriesRoute = appRoute({
  method: 'get',
  path: '/deliveries',
  tags: ['Audit'],
  summary: 'List SIEM audit export delivery records',
  request: { query: SiemDeliveryListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getSiemDeliveryRoute = appRoute({
  method: 'get',
  path: '/deliveries/{id}',
  tags: ['Audit'],
  summary: 'Get SIEM delivery details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const requeueSiemDeliveryRoute = appRoute({
  method: 'post',
  path: '/deliveries/{id}/requeue',
  tags: ['Audit'],
  summary: 'Requeue a failed SIEM delivery',
  request: { params: IdParamSchema, ...jsonBody(z.object({}).default({})) },
  responses: okJson(UnknownDataResponseSchema),
});
