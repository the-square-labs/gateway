import { create } from "zustand";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type { Certificate, CertificateStatus, CertificateType } from "@/types";

interface CertificateFilters {
  search: string;
  status: CertificateStatus | "all";
  type: CertificateType | "all";
  caId: string | "all";
}

interface CertificatesState {
  certificates: Certificate[];
  selectedCertificate: Certificate | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  filters: CertificateFilters;
  limit: number;
  total: number;
  hasMore: boolean;
  nextPage: number;

  fetchCertificates: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
  selectCertificate: (id: string) => Promise<void>;
  clearSelected: () => void;
  setFilters: (filters: Partial<CertificateFilters>) => void;
  resetFilters: () => void;
}

const defaultFilters: CertificateFilters = {
  search: "",
  status: "active",
  type: "all",
  caId: "all",
};

let fetchCertificatesRequestId = 0;

export const useCertificatesStore = create<CertificatesState>()((set, get) => ({
  certificates: [],
  selectedCertificate: null,
  isLoading: true,
  isLoadingMore: false,
  error: null,
  filters: { ...defaultFilters },
  limit: 25,
  total: 0,
  hasMore: false,
  nextPage: 1,

  fetchCertificates: async () => {
    const requestId = ++fetchCertificatesRequestId;
    const { filters, limit } = get();
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    const isDefault =
      !filters.search &&
      filters.status === "active" &&
      filters.type === "all" &&
      filters.caId === "all";
    const cacheKey = `certificates:list:${showSystem ? "system" : "default"}`;

    // Show cached data instantly for default view
    const cached = isDefault
      ? api.getCached<{
          data: Certificate[];
          pagination: { total: number; totalPages: number };
        }>(cacheKey)
      : undefined;
    const hasCachedSnapshot = cached !== undefined;
    if (get().certificates.length === 0 && cached) {
      set({
        certificates: cached.data || [],
        total: cached.pagination?.total ?? 0,
        hasMore: (cached.pagination?.totalPages ?? 0) > 1,
        nextPage: 2,
      });
    }

    const hasData = get().certificates.length > 0;
    set({ isLoading: !hasCachedSnapshot && !hasData, isLoadingMore: false, error: null });
    try {
      const response = await api.listCertificates({
        page: 1,
        limit,
        search: filters.search || undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        caId: filters.caId !== "all" ? filters.caId : undefined,
        showSystem,
      });
      if (requestId !== fetchCertificatesRequestId) return;
      if (isDefault) api.setCache(cacheKey, response);
      set({
        certificates: response.data || [],
        total: response.pagination?.total ?? 0,
        hasMore: (response.pagination?.page ?? 1) < (response.pagination?.totalPages ?? 0),
        nextPage: (response.pagination?.page ?? 1) + 1,
        isLoading: false,
        isLoadingMore: false,
      });
    } catch (err) {
      if (requestId !== fetchCertificatesRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch certificates";
      set({ error: message, isLoading: false, isLoadingMore: false });
    }
  },

  fetchNextPage: async () => {
    const { filters, limit, hasMore, isLoading, isLoadingMore, nextPage } = get();
    if (!hasMore || isLoading || isLoadingMore) return;

    const requestId = ++fetchCertificatesRequestId;
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    set({ isLoadingMore: true, error: null });
    try {
      const response = await api.listCertificates({
        page: nextPage,
        limit,
        search: filters.search || undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        caId: filters.caId !== "all" ? filters.caId : undefined,
        showSystem,
      });
      if (requestId !== fetchCertificatesRequestId) return;
      set((state) => {
        const knownIds = new Set(state.certificates.map((certificate) => certificate.id));
        const nextCertificates = (response.data || []).filter(
          (certificate) => !knownIds.has(certificate.id)
        );
        return {
          certificates: [...state.certificates, ...nextCertificates],
          total: response.pagination?.total ?? state.total,
          hasMore: (response.pagination?.page ?? nextPage) < (response.pagination?.totalPages ?? 0),
          nextPage: (response.pagination?.page ?? nextPage) + 1,
          isLoadingMore: false,
        };
      });
    } catch (err) {
      if (requestId !== fetchCertificatesRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch more certificates";
      set({ error: message, isLoadingMore: false });
    }
  },

  selectCertificate: async (id: string) => {
    try {
      const cert = await api.getCertificate(id);
      set({ selectedCertificate: cert });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch certificate";
      set({ error: message });
    }
  },

  clearSelected: () => set({ selectedCertificate: null }),

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
      certificates: [],
      hasMore: false,
      nextPage: 1,
      isLoadingMore: false,
    }));
    get().fetchCertificates();
  },

  resetFilters: () => {
    set({
      filters: { ...defaultFilters },
      certificates: [],
      hasMore: false,
      nextPage: 1,
      isLoadingMore: false,
    });
    get().fetchCertificates();
  },
}));
