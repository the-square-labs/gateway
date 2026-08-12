import { create } from "zustand";
import { api } from "@/services/api";
import type {
  DockerContainerFolder,
  DockerFolderResourceType,
  DockerFolderTreeNode,
} from "@/types";

type FolderResourceMap<T> = Record<DockerFolderResourceType, T>;

interface DockerFolderState {
  folders: DockerFolderTreeNode[];
  foldersByType: FolderResourceMap<DockerFolderTreeNode[]>;
  isLoading: boolean;
  loadingByType: FolderResourceMap<boolean>;
  error: string | null;
  errorByType: FolderResourceMap<string | null>;
  expandedFolderIds: Set<string>;
  expandedFolderIdsByType: FolderResourceMap<Set<string>>;
  savedExpandedFolderIds: Set<string>;
  savedExpandedFolderIdsByType: FolderResourceMap<Set<string>>;

  fetchFolders: (resourceType?: DockerFolderResourceType) => Promise<void>;
  createFolder: (
    name: string,
    parentId?: string,
    resourceType?: DockerFolderResourceType
  ) => Promise<DockerContainerFolder>;
  renameFolder: (
    id: string,
    name: string,
    resourceType?: DockerFolderResourceType
  ) => Promise<void>;
  deleteFolder: (id: string, resourceType?: DockerFolderResourceType) => Promise<void>;
  reorderFolders: (
    items: { id: string; sortOrder: number }[],
    resourceType?: DockerFolderResourceType
  ) => Promise<void>;
  moveContainersToFolder: (
    items: Array<{ nodeId: string; containerName: string }>,
    folderId: string | null
  ) => Promise<void>;
  reorderContainers: (
    items: Array<{ nodeId: string; containerName: string; sortOrder: number }>
  ) => Promise<void>;
  moveResourcesToFolder: (
    resourceType: DockerFolderResourceType,
    items: Array<{ nodeId: string; resourceKey: string }>,
    folderId: string | null
  ) => Promise<void>;
  reorderResources: (
    resourceType: DockerFolderResourceType,
    items: Array<{ nodeId: string; resourceKey: string; sortOrder: number }>
  ) => Promise<void>;
  toggleFolder: (id: string, resourceType?: DockerFolderResourceType) => void;
  expandAll: (resourceType?: DockerFolderResourceType) => void;
  collapseAll: (resourceType?: DockerFolderResourceType) => void;
}

const RESOURCE_TYPES: DockerFolderResourceType[] = ["container", "image", "network", "volume"];
const EXPANDED_DOCKER_FOLDERS_STORAGE_KEY = "docker-folder-expanded";

function folderRequestCacheKey(resourceType: DockerFolderResourceType) {
  return `req:/api/docker/folders?resourceType=${resourceType}`;
}

function resourceMap<T>(value: (type: DockerFolderResourceType) => T): FolderResourceMap<T> {
  return Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, value(type)])
  ) as FolderResourceMap<T>;
}

function storageKey(resourceType: DockerFolderResourceType) {
  return resourceType === "container"
    ? EXPANDED_DOCKER_FOLDERS_STORAGE_KEY
    : `${EXPANDED_DOCKER_FOLDERS_STORAGE_KEY}:${resourceType}`;
}

function loadExpandedFolderIds(resourceType: DockerFolderResourceType): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(resourceType));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveExpandedFolderIds(resourceType: DockerFolderResourceType, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(resourceType), JSON.stringify(Array.from(ids)));
  } catch {}
}

function collectFolderIds(nodes: DockerFolderTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    ids.push(...collectFolderIds(node.children));
  }
  return ids;
}

function applyFolderOrder(
  nodes: DockerFolderTreeNode[],
  items: { id: string; sortOrder: number }[]
): DockerFolderTreeNode[] {
  const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));

  const visit = (current: DockerFolderTreeNode[]): DockerFolderTreeNode[] => {
    const hasTarget = current.some((node) => orderMap.has(node.id));
    const next = current.map((node) => ({
      ...node,
      children: visit(node.children),
    }));

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

function withContainerMirror(
  current: DockerFolderState,
  patch: Partial<DockerFolderState>,
  resourceType: DockerFolderResourceType
) {
  if (resourceType !== "container") return patch;
  const foldersByType = patch.foldersByType ?? current.foldersByType;
  const loadingByType = patch.loadingByType ?? current.loadingByType;
  const errorByType = patch.errorByType ?? current.errorByType;
  const expandedFolderIdsByType = patch.expandedFolderIdsByType ?? current.expandedFolderIdsByType;
  const savedExpandedFolderIdsByType =
    patch.savedExpandedFolderIdsByType ?? current.savedExpandedFolderIdsByType;
  return {
    ...patch,
    folders: foldersByType.container,
    isLoading: loadingByType.container,
    error: errorByType.container,
    expandedFolderIds: expandedFolderIdsByType.container,
    savedExpandedFolderIds: savedExpandedFolderIdsByType.container,
  };
}

const fetchDockerFoldersRequestIds = resourceMap(() => 0);

export const useDockerFolderStore = create<DockerFolderState>()((set, get) => {
  const initialExpanded = resourceMap((type) => new Set(loadExpandedFolderIds(type)));

  return {
    folders: [],
    foldersByType: resourceMap(() => []),
    isLoading: true,
    loadingByType: resourceMap(() => true),
    error: null,
    errorByType: resourceMap(() => null),
    expandedFolderIds: initialExpanded.container,
    expandedFolderIdsByType: initialExpanded,
    savedExpandedFolderIds: initialExpanded.container,
    savedExpandedFolderIdsByType: initialExpanded,

    fetchFolders: async (resourceType = "container") => {
      const requestId = ++fetchDockerFoldersRequestIds[resourceType];
      const cachedEnvelope = api.getCached<{ data: DockerFolderTreeNode[] }>(
        folderRequestCacheKey(resourceType),
        Number.POSITIVE_INFINITY
      );
      const cached = cachedEnvelope?.data;
      set((state) =>
        withContainerMirror(
          state,
          {
            foldersByType:
              cached === undefined
                ? state.foldersByType
                : { ...state.foldersByType, [resourceType]: cached },
            loadingByType: {
              ...state.loadingByType,
              [resourceType]:
                cached === undefined && state.foldersByType[resourceType].length === 0,
            },
            errorByType: { ...state.errorByType, [resourceType]: null },
          },
          resourceType
        )
      );
      try {
        const folders = await api.listDockerFolders(resourceType);
        if (requestId !== fetchDockerFoldersRequestIds[resourceType]) return;
        set((state) =>
          withContainerMirror(
            state,
            {
              foldersByType: { ...state.foldersByType, [resourceType]: folders },
              loadingByType: { ...state.loadingByType, [resourceType]: false },
              expandedFolderIdsByType: {
                ...state.expandedFolderIdsByType,
                [resourceType]: new Set(state.savedExpandedFolderIdsByType[resourceType]),
              },
            },
            resourceType
          )
        );
      } catch (err) {
        if (requestId !== fetchDockerFoldersRequestIds[resourceType]) return;
        const message = err instanceof Error ? err.message : "Failed to fetch Docker folders";
        set((state) =>
          withContainerMirror(
            state,
            {
              errorByType: { ...state.errorByType, [resourceType]: message },
              loadingByType: { ...state.loadingByType, [resourceType]: false },
            },
            resourceType
          )
        );
      }
    },

    createFolder: async (name, parentId, resourceType = "container") => {
      const folder = await api.createDockerFolder({ name, parentId, resourceType });
      if (parentId) {
        set((state) => {
          const next = new Set(state.savedExpandedFolderIdsByType[resourceType]);
          next.add(parentId);
          saveExpandedFolderIds(resourceType, next);
          return withContainerMirror(
            state,
            {
              expandedFolderIdsByType: {
                ...state.expandedFolderIdsByType,
                [resourceType]: new Set(next),
              },
              savedExpandedFolderIdsByType: {
                ...state.savedExpandedFolderIdsByType,
                [resourceType]: next,
              },
            },
            resourceType
          );
        });
      }
      await get().fetchFolders(resourceType);
      return folder;
    },

    renameFolder: async (id, name, resourceType = "container") => {
      await api.updateDockerFolder(id, { name });
      await get().fetchFolders(resourceType);
    },

    deleteFolder: async (id, resourceType = "container") => {
      await api.deleteDockerFolder(id);
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[resourceType]);
        next.delete(id);
        saveExpandedFolderIds(resourceType, next);
        return withContainerMirror(
          state,
          {
            expandedFolderIdsByType: {
              ...state.expandedFolderIdsByType,
              [resourceType]: new Set(next),
            },
            savedExpandedFolderIdsByType: {
              ...state.savedExpandedFolderIdsByType,
              [resourceType]: next,
            },
          },
          resourceType
        );
      });
      await get().fetchFolders(resourceType);
    },

    reorderFolders: async (items, resourceType = "container") => {
      const previousFolders = get().foldersByType[resourceType];
      set((state) =>
        withContainerMirror(
          state,
          {
            foldersByType: {
              ...state.foldersByType,
              [resourceType]: applyFolderOrder(previousFolders, items),
            },
          },
          resourceType
        )
      );
      try {
        await api.reorderDockerFolders(items, resourceType);
        await get().fetchFolders(resourceType);
      } catch (err) {
        set((state) =>
          withContainerMirror(
            state,
            { foldersByType: { ...state.foldersByType, [resourceType]: previousFolders } },
            resourceType
          )
        );
        throw err;
      }
    },

    moveContainersToFolder: async (items, folderId) => {
      await api.moveDockerContainersToFolder(items, folderId);
      await get().fetchFolders("container");
    },

    reorderContainers: async (items) => {
      await api.reorderDockerContainers(items);
    },

    moveResourcesToFolder: async (resourceType, items, folderId) => {
      await api.moveDockerResourcesToFolder(resourceType, items, folderId);
      await get().fetchFolders(resourceType);
    },

    reorderResources: async (resourceType, items) => {
      await api.reorderDockerResources(resourceType, items);
    },

    toggleFolder: (id, resourceType = "container") => {
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[resourceType]);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveExpandedFolderIds(resourceType, next);
        return withContainerMirror(
          state,
          {
            expandedFolderIdsByType: {
              ...state.expandedFolderIdsByType,
              [resourceType]: new Set(next),
            },
            savedExpandedFolderIdsByType: {
              ...state.savedExpandedFolderIdsByType,
              [resourceType]: next,
            },
          },
          resourceType
        );
      });
    },

    expandAll: (resourceType = "container") => {
      const next = new Set(collectFolderIds(get().foldersByType[resourceType]));
      saveExpandedFolderIds(resourceType, next);
      set((state) =>
        withContainerMirror(
          state,
          {
            expandedFolderIdsByType: {
              ...state.expandedFolderIdsByType,
              [resourceType]: new Set(next),
            },
            savedExpandedFolderIdsByType: {
              ...state.savedExpandedFolderIdsByType,
              [resourceType]: next,
            },
          },
          resourceType
        )
      );
    },

    collapseAll: (resourceType = "container") => {
      const next = new Set<string>();
      saveExpandedFolderIds(resourceType, next);
      set((state) =>
        withContainerMirror(
          state,
          {
            expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [resourceType]: next },
            savedExpandedFolderIdsByType: {
              ...state.savedExpandedFolderIdsByType,
              [resourceType]: next,
            },
          },
          resourceType
        )
      );
    },
  };
});
