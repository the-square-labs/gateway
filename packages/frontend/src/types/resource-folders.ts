export type ResourceFolderType =
  | "node"
  | "domain"
  | "ssl-certificate"
  | "database"
  | "logging-environment"
  | "logging-schema"
  | "admin-user"
  | "admin-group"
  | "pages-project";

export interface ResourceFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceFolderTreeNode extends ResourceFolder {
  children: ResourceFolderTreeNode[];
}

export interface FolderedResourceItem {
  folderId?: string | null;
  sortOrder?: number;
}
