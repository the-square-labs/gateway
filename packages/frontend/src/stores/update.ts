import { create } from "zustand";
import { applyForcedGatewayUpdateStatus } from "@/lib/dev-force-updates";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import type { UpdateStatus } from "@/types";

interface UpdateState {
  status: UpdateStatus | null;
  isChecking: boolean;
  isUpdating: boolean;
  updatingComponent: "gateway" | "relay" | null;
  updatingTargetVersion: string | null;

  fetchStatus: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  triggerUpdate: (version: string) => Promise<void>;
  triggerRelayUpdate: (version: string) => Promise<void>;
  setUpdating: (
    component: "gateway" | "relay",
    active: boolean,
    targetVersion?: string | null
  ) => void;
  clearUpdating: () => void;
}

function normalizeVersion(value: string | null | undefined) {
  return value?.replace(/^v/, "") ?? null;
}

function relayStatusState(status: UpdateStatus, state: UpdateState): Partial<UpdateState> {
  if (status.relay.operation?.status === "updating") {
    return {
      isUpdating: true,
      updatingComponent: "relay",
      updatingTargetVersion: status.relay.operation.targetVersion,
    };
  }
  if (state.updatingComponent !== "relay") return {};
  const reachedTarget =
    state.updatingTargetVersion !== null &&
    normalizeVersion(status.relay.currentVersion) === normalizeVersion(state.updatingTargetVersion);
  if (status.relay.operation?.status === "failed" || reachedTarget) {
    return { isUpdating: false, updatingComponent: null, updatingTargetVersion: null };
  }
  // A status request can race the server-side operation record immediately
  // after the update request is accepted. Preserve the optimistic gate until
  // the operation appears, reaches its target, or emits an explicit stop event.
  return {};
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  status: null,
  isChecking: false,
  isUpdating: false,
  updatingComponent: null,
  updatingTargetVersion: null,

  fetchStatus: async () => {
    try {
      const status = applyForcedGatewayUpdateStatus(await api.getVersionInfo());
      api.setCache("system:version", status);
      set((state) => ({ status, ...relayStatusState(status, state) }));
    } catch {
      // ignore
    }
  },

  checkForUpdates: async () => {
    set({ isChecking: true });
    try {
      const status = applyForcedGatewayUpdateStatus(await api.checkForUpdates());
      api.setCache("system:version", status);
      set((state) => ({ status, ...relayStatusState(status, state) }));
    } catch {
      // ignore
    } finally {
      set({ isChecking: false });
    }
  },

  triggerUpdate: async (version: string) => {
    set({ isUpdating: true, updatingComponent: "gateway" });
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
      set({ isUpdating: false, updatingComponent: null, updatingTargetVersion: null });
    }
  },

  triggerRelayUpdate: async (version: string) => {
    set({ isUpdating: true, updatingComponent: "relay", updatingTargetVersion: version });
    try {
      await api.triggerRelayUpdate(version);
      await useUpdateStore.getState().fetchStatus();
    } catch {
      set({ isUpdating: false, updatingComponent: null, updatingTargetVersion: null });
    }
  },

  setUpdating: (component, active, targetVersion = null) =>
    set((state) => ({
      isUpdating: active,
      updatingComponent: active ? component : null,
      updatingTargetVersion:
        active && component === "relay" ? (targetVersion ?? state.updatingTargetVersion) : null,
    })),

  clearUpdating: () =>
    set({ isUpdating: false, updatingComponent: null, updatingTargetVersion: null }),
}));
