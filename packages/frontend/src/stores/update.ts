import { create } from "zustand";
import { applyForcedGatewayUpdateStatus } from "@/lib/dev-force-updates";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import type { UpdateStatus } from "@/types";

interface UpdateState {
  status: UpdateStatus | null;
  isChecking: boolean;
  isUpdating: boolean;
  updatingComponent: "gateway" | "gateway-relay" | "relay" | null;

  fetchStatus: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  triggerUpdate: (version: string, includeRelay?: boolean) => Promise<void>;
  triggerRelayUpdate: (version: string) => Promise<void>;
  setUpdating: (component: "gateway" | "gateway-relay" | "relay", active: boolean) => void;
  clearUpdating: () => void;
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  status: null,
  isChecking: false,
  isUpdating: false,
  updatingComponent: null,

  fetchStatus: async () => {
    try {
      const status = applyForcedGatewayUpdateStatus(await api.getVersionInfo());
      api.setCache("system:version", status);
      set({ status });
    } catch {
      // ignore
    }
  },

  checkForUpdates: async () => {
    set({ isChecking: true });
    try {
      const status = applyForcedGatewayUpdateStatus(await api.checkForUpdates());
      api.setCache("system:version", status);
      set({ status });
    } catch {
      // ignore
    } finally {
      set({ isChecking: false });
    }
  },

  triggerUpdate: async (version: string, includeRelay = false) => {
    set({ isUpdating: true, updatingComponent: includeRelay ? "gateway-relay" : "gateway" });
    try {
      useAppStatusStore.getState().setGatewayUpdatingActive(true, version);
      await api.triggerUpdate(version);
    } catch (error) {
      useAppStatusStore
        .getState()
        .setGatewayUpdateError(
          error instanceof Error ? error.message : "Gateway update could not be started",
          version
        );
      set({ isUpdating: false, updatingComponent: null });
    }
  },

  triggerRelayUpdate: async (version: string) => {
    set({ isUpdating: true, updatingComponent: "relay" });
    try {
      await api.triggerRelayUpdate(version);
    } catch {
      set({ isUpdating: false, updatingComponent: null });
    }
  },

  setUpdating: (component, active) =>
    set({ isUpdating: active, updatingComponent: active ? component : null }),

  clearUpdating: () => set({ isUpdating: false, updatingComponent: null }),
}));
