import { create } from "zustand";
import { api } from "@/services/api";
import type { ResourceFolder, ResourceFolderTreeNode, ResourceFolderType } from "@/types";

type FolderResourceMap<T> = Record<ResourceFolderType, T>;

interface ResourceFolderState {
  foldersByType: FolderResourceMap<ResourceFolderTreeNode[]>;
  loadingByType: FolderResourceMap<boolean>;
  errorByType: FolderResourceMap<string | null>;
  expandedFolderIdsByType: FolderResourceMap<Set<string>>;
  savedExpandedFolderIdsByType: FolderResourceMap<Set<string>>;
  fetchFolders: (type: ResourceFolderType) => Promise<void>;
  createFolder: (
    type: ResourceFolderType,
    name: string,
    parentId?: string
  ) => Promise<ResourceFolder>;
  renameFolder: (type: ResourceFolderType, id: string, name: string) => Promise<void>;
  deleteFolder: (type: ResourceFolderType, id: string) => Promise<void>;
  reorderFolders: (
    type: ResourceFolderType,
    items: { id: string; sortOrder: number }[]
  ) => Promise<void>;
  moveResourcesToFolder: (
    type: ResourceFolderType,
    ids: string[],
    folderId: string | null
  ) => Promise<void>;
  reorderResources: (
    type: ResourceFolderType,
    items: { id: string; sortOrder: number }[]
  ) => Promise<void>;
  toggleFolder: (type: ResourceFolderType, id: string) => void;
}

const RESOURCE_TYPES: ResourceFolderType[] = [
  "node",
  "domain",
  "ssl-certificate",
  "database",
  "logging-environment",
  "logging-schema",
  "admin-user",
  "admin-group",
  "pages-project",
];
const EXPANDED_STORAGE_KEY = "resource-folder-expanded";

function resourceMap<T>(value: (type: ResourceFolderType) => T): FolderResourceMap<T> {
  return Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, value(type)])
  ) as FolderResourceMap<T>;
}

function storageKey(type: ResourceFolderType) {
  return `${EXPANDED_STORAGE_KEY}:${type}`;
}

function loadExpandedFolderIds(type: ResourceFolderType): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(type));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function saveExpandedFolderIds(type: ResourceFolderType, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(type), JSON.stringify(Array.from(ids)));
  } catch {}
}

function applyFolderOrder(
  nodes: ResourceFolderTreeNode[],
  items: { id: string; sortOrder: number }[]
): ResourceFolderTreeNode[] {
  const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));
  const visit = (current: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] => {
    const hasTarget = current.some((node) => orderMap.has(node.id));
    const next = current.map((node) => ({ ...node, children: visit(node.children) }));
    if (!hasTarget) return next;
    return [...next].sort((a, b) => {
      const aOrder = orderMap.get(a.id);
      const bOrder = orderMap.get(b.id);
      if (aOrder == null && bOrder == null) return 0;
      if (aOrder == null) return -1;
      if (bOrder == null) return 1;
      return aOrder - bOrder;
    });
  };
  return visit(nodes);
}

const fetchRequestIds = resourceMap(() => 0);

export const useResourceFolderStore = create<ResourceFolderState>()((set, get) => {
  const initialExpanded = resourceMap((type) => new Set(loadExpandedFolderIds(type)));

  return {
    foldersByType: resourceMap(() => []),
    loadingByType: resourceMap(() => true),
    errorByType: resourceMap(() => null),
    expandedFolderIdsByType: initialExpanded,
    savedExpandedFolderIdsByType: initialExpanded,

    fetchFolders: async (type) => {
      const requestId = ++fetchRequestIds[type];
      set((state) => ({
        loadingByType: {
          ...state.loadingByType,
          [type]: state.foldersByType[type].length === 0,
        },
        errorByType: { ...state.errorByType, [type]: null },
      }));
      try {
        const folders = await listFolders(type);
        if (requestId !== fetchRequestIds[type]) return;
        set((state) => ({
          foldersByType: { ...state.foldersByType, [type]: folders },
          loadingByType: { ...state.loadingByType, [type]: false },
          expandedFolderIdsByType: {
            ...state.expandedFolderIdsByType,
            [type]: new Set(state.savedExpandedFolderIdsByType[type]),
          },
        }));
      } catch (err) {
        if (requestId !== fetchRequestIds[type]) return;
        set((state) => ({
          errorByType: {
            ...state.errorByType,
            [type]: err instanceof Error ? err.message : "Failed to fetch folders",
          },
          loadingByType: { ...state.loadingByType, [type]: false },
        }));
      }
    },

    createFolder: async (type, name, parentId) => {
      const folder = await createFolderByType(type, { name, parentId });
      if (parentId) {
        set((state) => {
          const next = new Set(state.savedExpandedFolderIdsByType[type]);
          next.add(parentId);
          saveExpandedFolderIds(type, next);
          return {
            expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
            savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
          };
        });
      }
      await get().fetchFolders(type);
      return folder;
    },

    renameFolder: async (type, id, name) => {
      await updateFolderByType(type, id, { name });
      await get().fetchFolders(type);
    },

    deleteFolder: async (type, id) => {
      await deleteFolderByType(type, id);
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[type]);
        next.delete(id);
        saveExpandedFolderIds(type, next);
        return {
          expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
          savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
        };
      });
      await get().fetchFolders(type);
    },

    reorderFolders: async (type, items) => {
      const previous = get().foldersByType[type];
      set((state) => ({
        foldersByType: { ...state.foldersByType, [type]: applyFolderOrder(previous, items) },
      }));
      try {
        await reorderFoldersByType(type, items);
        await get().fetchFolders(type);
      } catch (err) {
        set((state) => ({ foldersByType: { ...state.foldersByType, [type]: previous } }));
        throw err;
      }
    },

    moveResourcesToFolder: async (type, ids, folderId) => {
      await moveResourcesToFolderByType(type, ids, folderId);
      await get().fetchFolders(type);
    },

    reorderResources: async (type, items) => {
      await reorderResourcesByType(type, items);
    },

    toggleFolder: (type, id) => {
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[type]);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveExpandedFolderIds(type, next);
        return {
          expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
          savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
        };
      });
    },
  };
});

function listFolders(type: ResourceFolderType): Promise<ResourceFolderTreeNode[]> {
  switch (type) {
    case "node":
      return api.listNodeFolders();
    case "domain":
      return api.listDomainFolders();
    case "ssl-certificate":
      return api.listSSLCertificateFolders();
    case "database":
      return api.listDatabaseFolders();
    case "logging-environment":
      return api.listLoggingEnvironmentFolders();
    case "logging-schema":
      return api.listLoggingSchemaFolders();
    case "admin-user":
      return api.listAdminUserFolders();
    case "admin-group":
      return api.listAdminGroupFolders();
    case "pages-project":
      return api.listPageProjectFolders();
  }
}

function createFolderByType(
  type: ResourceFolderType,
  data: { name: string; parentId?: string }
): Promise<ResourceFolder> {
  switch (type) {
    case "node":
      return api.createNodeFolder(data);
    case "domain":
      return api.createDomainFolder(data);
    case "ssl-certificate":
      return api.createSSLCertificateFolder(data);
    case "database":
      return api.createDatabaseFolder(data);
    case "logging-environment":
      return api.createLoggingEnvironmentFolder(data);
    case "logging-schema":
      return api.createLoggingSchemaFolder(data);
    case "admin-user":
      return api.createAdminUserFolder(data);
    case "admin-group":
      return api.createAdminGroupFolder(data);
    case "pages-project":
      return api.createPageProjectFolder(data);
  }
}

function updateFolderByType(
  type: ResourceFolderType,
  id: string,
  data: { name: string }
): Promise<ResourceFolder> {
  switch (type) {
    case "node":
      return api.updateNodeFolder(id, data);
    case "domain":
      return api.updateDomainFolder(id, data);
    case "ssl-certificate":
      return api.updateSSLCertificateFolder(id, data);
    case "database":
      return api.updateDatabaseFolder(id, data);
    case "logging-environment":
      return api.updateLoggingEnvironmentFolder(id, data);
    case "logging-schema":
      return api.updateLoggingSchemaFolder(id, data);
    case "admin-user":
      return api.updateAdminUserFolder(id, data);
    case "admin-group":
      return api.updateAdminGroupFolder(id, data);
    case "pages-project":
      return api.updatePageProjectFolder(id, data);
  }
}

function deleteFolderByType(type: ResourceFolderType, id: string): Promise<void> {
  switch (type) {
    case "node":
      return api.deleteNodeFolder(id);
    case "domain":
      return api.deleteDomainFolder(id);
    case "ssl-certificate":
      return api.deleteSSLCertificateFolder(id);
    case "database":
      return api.deleteDatabaseFolder(id);
    case "logging-environment":
      return api.deleteLoggingEnvironmentFolder(id);
    case "logging-schema":
      return api.deleteLoggingSchemaFolder(id);
    case "admin-user":
      return api.deleteAdminUserFolder(id);
    case "admin-group":
      return api.deleteAdminGroupFolder(id);
    case "pages-project":
      return api.deletePageProjectFolder(id);
  }
}

function reorderFoldersByType(
  type: ResourceFolderType,
  items: { id: string; sortOrder: number }[]
): Promise<void> {
  switch (type) {
    case "node":
      return api.reorderNodeFolders(items);
    case "domain":
      return api.reorderDomainFolders(items);
    case "ssl-certificate":
      return api.reorderSSLCertificateFolders(items);
    case "database":
      return api.reorderDatabaseFolders(items);
    case "logging-environment":
      return api.reorderLoggingEnvironmentFolders(items);
    case "logging-schema":
      return api.reorderLoggingSchemaFolders(items);
    case "admin-user":
      return api.reorderAdminUserFolders(items);
    case "admin-group":
      return api.reorderAdminGroupFolders(items);
    case "pages-project":
      return api.reorderPageProjectFolders(items);
  }
}

function moveResourcesToFolderByType(
  type: ResourceFolderType,
  ids: string[],
  folderId: string | null
): Promise<void> {
  switch (type) {
    case "node":
      return api.moveNodesToFolder(ids, folderId);
    case "domain":
      return api.moveDomainsToFolder(ids, folderId);
    case "ssl-certificate":
      return api.moveSSLCertificatesToFolder(ids, folderId);
    case "database":
      return api.moveDatabasesToFolder(ids, folderId);
    case "logging-environment":
      return api.moveLoggingEnvironmentsToFolder(ids, folderId);
    case "logging-schema":
      return api.moveLoggingSchemasToFolder(ids, folderId);
    case "admin-user":
      return api.moveAdminUsersToFolder(ids, folderId);
    case "admin-group":
      return api.moveAdminGroupsToFolder(ids, folderId);
    case "pages-project":
      return api.movePageProjectsToFolder(ids, folderId);
  }
}

function reorderResourcesByType(
  type: ResourceFolderType,
  items: { id: string; sortOrder: number }[]
): Promise<void> {
  switch (type) {
    case "node":
      return api.reorderNodes(items);
    case "domain":
      return api.reorderDomains(items);
    case "ssl-certificate":
      return api.reorderSSLCertificates(items);
    case "database":
      return api.reorderDatabases(items);
    case "logging-environment":
      return api.reorderLoggingEnvironments(items);
    case "logging-schema":
      return api.reorderLoggingSchemas(items);
    case "admin-user":
      return api.reorderAdminUsers(items);
    case "admin-group":
      return api.reorderAdminGroups(items);
    case "pages-project":
      return api.reorderPageProjects(items);
  }
}
