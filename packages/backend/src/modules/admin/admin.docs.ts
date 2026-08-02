import { z } from '@hono/zod-openapi';
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
  CreateUserSchema,
  RestoreUserSchema,
  UpdateAuthProvisioningSettingsSchema,
  UpdateBlockSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserGroupSchema,
} from './admin.schemas.js';

export const listAdminUsersRoute = appRoute({
  method: 'get',
  path: '/users',
  tags: ['Admin'],
  summary: 'List users',
  responses: okJson(UnknownDataResponseSchema),
});

export const listDeletedAdminUsersRoute = appRoute({
  method: 'get',
  path: '/users/deleted',
  tags: ['Admin'],
  summary: 'List deleted users',
  responses: okJson(UnknownDataResponseSchema),
});

export const listAdminUserFoldersRoute = appRoute({
  method: 'get',
  path: '/user-folders',
  tags: ['Admin Folders'],
  summary: 'List user folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createAdminUserFolderRoute = appRoute({
  method: 'post',
  path: '/user-folders',
  tags: ['Admin Folders'],
  summary: 'Create a user folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderAdminUserFoldersRoute = appRoute({
  method: 'put',
  path: '/user-folders/reorder',
  tags: ['Admin Folders'],
  summary: 'Reorder user folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const moveAdminUsersToFolderRoute = appRoute({
  method: 'post',
  path: '/user-folders/move-users',
  tags: ['Admin Folders'],
  summary: 'Move users to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderAdminUsersRoute = appRoute({
  method: 'put',
  path: '/user-folders/reorder-users',
  tags: ['Admin Folders'],
  summary: 'Reorder users',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAdminUserFolderRoute = appRoute({
  method: 'put',
  path: '/user-folders/{id}',
  tags: ['Admin Folders'],
  summary: 'Update a user folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveAdminUserFolderRoute = appRoute({
  method: 'put',
  path: '/user-folders/{id}/move',
  tags: ['Admin Folders'],
  summary: 'Move a user folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAdminUserFolderRoute = appRoute({
  method: 'delete',
  path: '/user-folders/{id}',
  tags: ['Admin Folders'],
  summary: 'Delete a user folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAuthSettingsRoute = appRoute({
  method: 'get',
  path: '/auth-settings',
  tags: ['Admin'],
  summary: 'Get Gateway settings',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAuthSettingsRoute = appRoute({
  method: 'put',
  path: '/auth-settings',
  tags: ['Admin'],
  summary: 'Update Gateway settings',
  request: jsonBody(UpdateAuthProvisioningSettingsSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const createAdminUserRoute = appRoute({
  method: 'post',
  path: '/users',
  tags: ['Admin'],
  summary: 'Create a user',
  request: jsonBody(CreateUserSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateUserGroupRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/group',
  tags: ['Admin'],
  summary: 'Update a user permission group',
  request: { params: IdParamSchema, ...jsonBody(UpdateUserGroupSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserAdditionalPermissionsRoute = appRoute({
  method: 'put',
  path: '/users/{id}/additional-permissions',
  tags: ['Admin'],
  summary: "Replace a user's additional permissions",
  request: { params: IdParamSchema, ...jsonBody(UpdateUserAdditionalPermissionsSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserBlockRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/block',
  tags: ['Admin'],
  summary: 'Block or unblock a user',
  request: { params: IdParamSchema, ...jsonBody(UpdateBlockSchema) },
  responses: okJson(z.object({ message: z.string() })),
});

export const deleteAdminUserRoute = appRoute({
  method: 'delete',
  path: '/users/{id}',
  tags: ['Admin'],
  summary: 'Delete a user',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});

export const restoreAdminUserRoute = appRoute({
  method: 'post',
  path: '/users/{id}/restore',
  tags: ['Admin'],
  summary: 'Restore a deleted user in blocked state',
  request: { params: IdParamSchema, ...jsonBody(RestoreUserSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
