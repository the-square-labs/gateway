import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { EnvironmentSettingsUpdateSchema } from './environment-settings.schemas.js';

export const getEnvironmentSettingsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Settings'],
  summary: 'Get runtime environment settings',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateEnvironmentSettingsRoute = appRoute({
  method: 'patch',
  path: '/',
  tags: ['Settings'],
  summary: 'Update runtime environment settings',
  request: jsonBody(EnvironmentSettingsUpdateSchema),
  responses: okJson(UnknownDataResponseSchema),
});
