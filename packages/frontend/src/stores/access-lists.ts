import { create } from "zustand";
import { api } from "@/services/api";
import type { AccessList, CreateAccessListRequest } from "@/types";

interface AccessListsState {
  accessLists: AccessList[];
  selectedAccessList: AccessList | null;
  isLoading: boolean;
  error: string | null;

  fetchAccessLists: () => Promise<void>;
  selectAccessList: (id: string) => Promise<void>;
  clearSelected: () => void;
  createAccessList: (data: CreateAccessListRequest) => Promise<AccessList>;
  updateAccessList: (id: string, data: Partial<CreateAccessListRequest>) => Promise<AccessList>;
  deleteAccessList: (id: string) => Promise<void>;
}

export const useAccessListsStore = create<AccessListsState>()((set, get) => ({
  accessLists: [],
  selectedAccessList: null,
  isLoading: true,
  error: null,

  fetchAccessLists: async () => {
    const cached =
      api.getCached<Awaited<ReturnType<typeof api.listAccessLists>>>("access-lists:list");
    const hasCachedSnapshot = cached !== undefined;
    if (cached && get().accessLists.length === 0) {
      set({ accessLists: cached.data || [] });
    }
    set({ isLoading: !hasCachedSnapshot && get().accessLists.length === 0, error: null });
    try {
      const response = await api.listAccessLists();
      api.setCache("access-lists:list", response);
      set({ accessLists: response.data || [], isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch access lists";
      set({ error: message, isLoading: false });
    }
  },

  selectAccessList: async (id: string) => {
    const existing = get().accessLists.find((al) => al.id === id);
    if (existing) {
      set({ selectedAccessList: existing });
    }
    try {
      const accessList = await api.getAccessList(id);
      set({ selectedAccessList: accessList });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch access list";
      set({ error: message });
    }
  },

  clearSelected: () => set({ selectedAccessList: null }),

  createAccessList: async (data: CreateAccessListRequest) => {
    const accessList = await api.createAccessList(data);
    get().fetchAccessLists();
    return accessList;
  },

  updateAccessList: async (id: string, data: Partial<CreateAccessListRequest>) => {
    const accessList = await api.updateAccessList(id, data);
    set((state) => ({
      accessLists: state.accessLists.map((al) => (al.id === id ? accessList : al)),
      selectedAccessList:
        state.selectedAccessList?.id === id ? accessList : state.selectedAccessList,
    }));
    return accessList;
  },

  deleteAccessList: async (id: string) => {
    await api.deleteAccessList(id);
    set((state) => ({
      accessLists: state.accessLists.filter((al) => al.id !== id),
      selectedAccessList: state.selectedAccessList?.id === id ? null : state.selectedAccessList,
    }));
  },
}));
