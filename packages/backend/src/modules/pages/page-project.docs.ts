import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
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
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from './page-project.schemas.js';

const tags = ['Pages'];

export const listPageProjectFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags,
  summary: 'List Page Project folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createPageProjectFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags,
  summary: 'Create a Page Project folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderPageProjectFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags,
  summary: 'Reorder Page Project folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const movePageProjectsToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-projects',
  tags,
  summary: 'Move Page Projects to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderPageProjectsRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-projects',
  tags,
  summary: 'Reorder Page Projects within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updatePageProjectFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags,
  summary: 'Rename a Page Project folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const movePageProjectFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags,
  summary: 'Move a Page Project folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deletePageProjectFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags,
  summary: 'Delete a Page Project folder and ungroup its Projects',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listPageProjectsRoute = appRoute({
  method: 'get',
  path: '/',
  tags,
  summary: 'List Page Projects',
  request: { query: PageProjectListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createPageProjectRoute = appRoute({
  method: 'post',
  path: '/',
  tags,
  summary: 'Create a Page Project',
  request: jsonBody(CreatePageProjectSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const listPageProjectPlacementOptionsRoute = appRoute({
  method: 'get',
  path: '/placement-options',
  tags,
  summary: 'List eligible Page Project placement nodes',
  responses: okJson(UnknownDataResponseSchema),
});

export const getPageProjectRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags,
  summary: 'Get a Page Project',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getPageProjectBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags,
  summary: 'Resolve a Page Project by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const updatePageProjectRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags,
  summary: 'Update a Page Project',
  request: { params: IdParamSchema, ...jsonBody(UpdatePageProjectSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const migratePageProjectRoute = appRoute({
  method: 'post',
  path: '/{id}/migrate',
  tags,
  summary: 'Migrate a Page Project to another Nginx node',
  request: { params: IdParamSchema, ...jsonBody(MigratePageProjectSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deletePageProjectRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags,
  summary: 'Delete an empty Page Project',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
