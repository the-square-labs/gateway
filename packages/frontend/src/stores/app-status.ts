import { create } from "zustand";
import { persist } from "zustand/middleware";

export const APP_STATUS_STORAGE_KEY = "gateway-app-status";

export interface GatewayUpdateError {
  message: string;
  targetVersion: string | null;
  /** The update restarted Gateway, which came back on the previous version. */
  rolledBack?: boolean;
}

interface AppStatusState {
  maintenanceActive: boolean;
  gatewayUpdatingActive: boolean;
  gatewayUpdatingTargetVersion: string | null;
  /** When this browser entered the update screen (epoch ms); bounds how long it waits. */
  gatewayUpdatingStartedAt: number | null;
  gatewayRestartingActive: boolean;
  gatewayRestartTargetUrl: string | null;
  gatewayUpdateError: GatewayUpdateError | null;
  rateLimitedUntil: number | null;
  setMaintenanceActive: (active: boolean) => void;
  setGatewayUpdatingActive: (active: boolean, targetVersion?: string | null) => void;
  setGatewayRestartingActive: (active: boolean, targetUrl?: string | null) => void;
  setGatewayUpdateError: (
    message: string,
    targetVersion?: string | null,
    options?: { rolledBack?: boolean }
  ) => void;
  clearGatewayUpdating: () => void;
  clearGatewayRestarting: () => void;
  clearGatewayUpdateError: () => void;
  activateRateLimit: (seconds?: number) => void;
  clearRateLimit: () => void;
}

export const useAppStatusStore = create<AppStatusState>()(
  persist(
    (set) => ({
      maintenanceActive: false,
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayUpdatingStartedAt: null,
      gatewayRestartingActive: false,
      gatewayRestartTargetUrl: null,
      gatewayUpdateError: null,
      rateLimitedUntil: null,

      setMaintenanceActive: (maintenanceActive) =>
        set((state) => {
          if (maintenanceActive && (state.gatewayUpdatingActive || state.gatewayRestartingActive)) {
            return {};
          }
          return { maintenanceActive };
        }),

      setGatewayUpdatingActive: (gatewayUpdatingActive, gatewayUpdatingTargetVersion = null) =>
        set((state) => ({
          gatewayUpdatingActive,
          gatewayUpdatingTargetVersion,
          // Re-announcing the same update keeps its start; a new one starts the clock.
          gatewayUpdatingStartedAt: gatewayUpdatingActive
            ? state.gatewayUpdatingActive &&
              state.gatewayUpdatingStartedAt != null &&
              (state.gatewayUpdatingTargetVersion === gatewayUpdatingTargetVersion ||
                gatewayUpdatingTargetVersion == null)
              ? state.gatewayUpdatingStartedAt
              : Date.now()
            : null,
          gatewayRestartingActive: false,
          gatewayRestartTargetUrl: null,
          gatewayUpdateError: null,
          ...(gatewayUpdatingActive ? { maintenanceActive: false } : {}),
        })),

      setGatewayRestartingActive: (gatewayRestartingActive, gatewayRestartTargetUrl = null) =>
        set((state) => {
          if (gatewayRestartingActive && state.gatewayUpdatingActive) return {};
          return {
            gatewayRestartingActive,
            gatewayRestartTargetUrl,
            gatewayUpdateError: null,
            ...(gatewayRestartingActive ? { maintenanceActive: false } : {}),
          };
        }),

      setGatewayUpdateError: (message, targetVersion = null, options = {}) =>
        set({
          gatewayUpdatingActive: false,
          gatewayUpdatingTargetVersion: null,
          gatewayUpdatingStartedAt: null,
          gatewayRestartingActive: false,
          gatewayRestartTargetUrl: null,
          gatewayUpdateError: {
            message,
            targetVersion,
            ...(options.rolledBack ? { rolledBack: true } : {}),
          },
        }),

      clearGatewayUpdating: () =>
        set({
          gatewayUpdatingActive: false,
          gatewayUpdatingTargetVersion: null,
          gatewayUpdatingStartedAt: null,
        }),

      clearGatewayRestarting: () =>
        set({ gatewayRestartingActive: false, gatewayRestartTargetUrl: null }),

      clearGatewayUpdateError: () => set({ gatewayUpdateError: null }),

      activateRateLimit: (seconds = 60) =>
        set({
          rateLimitedUntil: Date.now() + Math.max(1, seconds) * 1000,
        }),

      clearRateLimit: () => set({ rateLimitedUntil: null }),
    }),
    {
      name: APP_STATUS_STORAGE_KEY,
      partialize: (state) => ({
        gatewayUpdatingActive: state.gatewayUpdatingActive,
        gatewayUpdatingTargetVersion: state.gatewayUpdatingTargetVersion,
        gatewayUpdatingStartedAt: state.gatewayUpdatingStartedAt,
        gatewayRestartingActive: state.gatewayRestartingActive,
        gatewayRestartTargetUrl: state.gatewayRestartTargetUrl,
      }),
    }
  )
);

interface GatewayOperationStatusSnapshot {
  gatewayUpdatingActive: boolean;
  gatewayUpdatingTargetVersion: string | null;
  gatewayRestartingActive: boolean;
  gatewayRestartTargetUrl: string | null;
}

export function syncGatewayOperationStatus(snapshot: GatewayOperationStatusSnapshot): boolean {
  const current = useAppStatusStore.getState();
  if (
    current.gatewayUpdatingActive === snapshot.gatewayUpdatingActive &&
    current.gatewayUpdatingTargetVersion === snapshot.gatewayUpdatingTargetVersion &&
    current.gatewayRestartingActive === snapshot.gatewayRestartingActive &&
    current.gatewayRestartTargetUrl === snapshot.gatewayRestartTargetUrl
  ) {
    return false;
  }

  useAppStatusStore.setState({
    ...snapshot,
    gatewayUpdatingStartedAt: snapshot.gatewayUpdatingActive
      ? (current.gatewayUpdatingStartedAt ?? Date.now())
      : null,
    ...(snapshot.gatewayUpdatingActive || snapshot.gatewayRestartingActive
      ? { maintenanceActive: false }
      : {}),
  });
  return true;
}
