import { create } from "zustand";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type { CA } from "@/types";

interface CAState {
  cas: CA[];
  selectedCA: CA | null;
  isLoading: boolean;
  error: string | null;

  fetchCAs: () => Promise<void>;
  selectCA: (id: string) => Promise<void>;
  clearSelected: () => void;
  setCAs: (cas: CA[]) => void;
}

export const useCAStore = create<CAState>()((set, get) => ({
  cas: [],
  selectedCA: null,
  isLoading: true,
  error: null,

  fetchCAs: async () => {
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    const cacheKey = `cas:list:${showSystem ? "system" : "default"}`;
    // Show cached data instantly
    const cached = api.getCached<CA[]>(cacheKey);
    const hasCachedSnapshot = cached !== undefined;
    if (hasCachedSnapshot && get().cas.length === 0) set({ cas: cached });

    const hasData = get().cas.length > 0;
    set({ isLoading: !hasCachedSnapshot && !hasData, error: null });
    try {
      const cas = await api.listCAs({ showSystem });
      api.setCache(cacheKey, cas);
      set({ cas, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch CAs";
      set({ error: message, isLoading: false });
    }
  },

  selectCA: async (id: string) => {
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    // First check if we already have it
    const existing = get().cas.find((ca) => ca.id === id);
    if (existing) {
      set({ selectedCA: existing });
    }
    try {
      const ca = await api.getCA(id, { showSystem });
      set({ selectedCA: ca });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch CA";
      set({ error: message });
    }
  },

  clearSelected: () => set({ selectedCA: null }),

  setCAs: (cas) => set({ cas }),
}));
