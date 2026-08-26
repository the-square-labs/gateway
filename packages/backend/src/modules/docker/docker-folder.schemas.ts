import { z } from 'zod';

export const DockerFolderResourceTypeSchema = z.enum(['container', 'image', 'network', 'volume', 'compose']);

export const CreateDockerFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().optional(),
  resourceType: DockerFolderResourceTypeSchema.default('container'),
});

export const UpdateDockerFolderSchema = z.object({
  name: z.string().min(1).max(255),
});

export const DockerFolderContainerRefSchema = z.object({
  nodeId: z.string().uuid(),
  containerName: z.string().min(1).max(255),
});

export const DockerFolderResourceRefSchema = z.object({
  nodeId: z.string().uuid(),
  resourceKey: z.string().min(1).max(512),
});

export const MoveDockerContainersToFolderSchema = z.object({
  items: z.array(DockerFolderContainerRefSchema).min(1),
  folderId: z.string().uuid().nullable(),
});

export const MoveDockerResourcesToFolderSchema = z.object({
  resourceType: DockerFolderResourceTypeSchema,
  items: z.array(DockerFolderResourceRefSchema).min(1),
  folderId: z.string().uuid().nullable(),
});

export const ReorderDockerContainersSchema = z.object({
  items: z
    .array(
      DockerFolderContainerRefSchema.extend({
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export const ReorderDockerResourcesSchema = z.object({
  resourceType: DockerFolderResourceTypeSchema,
  items: z
    .array(
      DockerFolderResourceRefSchema.extend({
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export const DockerFolderPlacementsSchema = z.object({
  resourceType: DockerFolderResourceTypeSchema,
  items: z.array(DockerFolderResourceRefSchema).min(1),
});

export const ReorderDockerFoldersSchema = z.object({
  resourceType: DockerFolderResourceTypeSchema.default('container'),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export type CreateDockerFolderInput = z.infer<typeof CreateDockerFolderSchema>;
export type UpdateDockerFolderInput = z.infer<typeof UpdateDockerFolderSchema>;
export type DockerFolderResourceType = z.infer<typeof DockerFolderResourceTypeSchema>;
export type DockerFolderContainerRef = z.infer<typeof DockerFolderContainerRefSchema>;
export type DockerFolderResourceRef = z.infer<typeof DockerFolderResourceRefSchema>;
export type MoveDockerContainersToFolderInput = z.infer<typeof MoveDockerContainersToFolderSchema>;
export type MoveDockerResourcesToFolderInput = z.infer<typeof MoveDockerResourcesToFolderSchema>;
export type ReorderDockerContainersInput = z.infer<typeof ReorderDockerContainersSchema>;
export type ReorderDockerResourcesInput = z.infer<typeof ReorderDockerResourcesSchema>;
export type DockerFolderPlacementsInput = z.infer<typeof DockerFolderPlacementsSchema>;
export type ReorderDockerFoldersInput = z.infer<typeof ReorderDockerFoldersSchema>;
