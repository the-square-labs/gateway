import { create } from "zustand";
import { api } from "@/services/api";
import type { Node, NodeStatus, NodeType } from "@/types";

interface NodeFilters {
  search: string;
  status: NodeStatus | "all";
  type: NodeType | "all";
}

interface NodesState {
  nodes: Node[];
  isLoading: boolean;
  error: string | null;
  filters: NodeFilters;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** Incremented on every node.changed event — triggers refetch in consuming components */
  refreshTick: number;
  fetchNodes: () => Promise<void>;
  setFilters: (filters: Partial<NodeFilters>) => void;
  setPage: (page: number) => void;
  resetFilters: () => void;
  /** Called from RealtimeBridge when a node.changed event arrives */
  invalidate: () => void;
}

let fetchNodesRequestId = 0;

export const useNodesStore = create<NodesState>()((set, get) => ({
  nodes: [],
  isLoading: true,
  error: null,
  filters: { search: "", status: "all", type: "all" },
  page: 1,
  limit: 50,
  total: 0,
  totalPages: 0,
  refreshTick: 0,

  fetchNodes: async () => {
    const requestId = ++fetchNodesRequestId;
    const { filters, page, limit } = get();
    const isDefaultQuery =
      filters.search === "" && filters.status === "all" && filters.type === "all" && page === 1;
    const cached = isDefaultQuery
      ? api.getCached<{
          data: Node[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        }>("nodes:list:default")
      : undefined;
    if (cached) {
      set({
        nodes: cached.data,
        total: cached.total,
        totalPages: cached.totalPages,
        isLoading: false,
      });
    }
    const hasData = cached !== undefined || get().nodes.length > 0;
    set({ isLoading: !hasData, error: null });
    try {
      const result = await api.listNodes({
        search: filters.search || undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        page,
        limit,
      });
      if (requestId !== fetchNodesRequestId) return;
      if (isDefaultQuery) api.setCache("nodes:list:default", result);
      set({
        nodes: result.data,
        total: result.total,
        totalPages: result.totalPages,
        isLoading: false,
      });
    } catch (err) {
      if (requestId !== fetchNodesRequestId) return;
      set({
        error: err instanceof Error ? err.message : "Failed to fetch nodes",
        isLoading: false,
      });
    }
  },

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
      page: 1,
    }));
    get().fetchNodes();
  },

  setPage: (page) => {
    set({ page });
    get().fetchNodes();
  },

  resetFilters: () => {
    set({
      filters: { search: "", status: "all", type: "all" },
      page: 1,
    });
    get().fetchNodes();
  },

  invalidate: () => {
    api.invalidateCache("req:/api/nodes");
    set((s) => ({ refreshTick: s.refreshTick + 1 }));
    get().fetchNodes();
  },
}));
