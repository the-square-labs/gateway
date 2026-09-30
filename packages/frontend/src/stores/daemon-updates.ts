import { create } from "zustand";
import { api } from "@/services/api";
import type { DaemonUpdateStatus } from "@/types";

interface DaemonUpdatesState {
  statuses: DaemonUpdateStatus[];
  isLoading: boolean;
  error: string | null;
  lastLoadedAt: number;
  fetchDaemonUpdates: (options?: { force?: boolean }) => Promise<DaemonUpdateStatus[]>;
  setDaemonUpdates: (statuses: DaemonUpdateStatus[]) => void;
}

const FRESH_MS = 10_000;
let inFlight: Promise<DaemonUpdateStatus[]> | null = null;
/** Bumped by every request and by setDaemonUpdates; a response applies only if nothing newer was started since. */
let generation = 0;

export const useDaemonUpdatesStore = create<DaemonUpdatesState>()((set, get) => ({
  statuses: [],
  isLoading: false,
  error: null,
  lastLoadedAt: 0,

  fetchDaemonUpdates: async (options = {}) => {
    const now = Date.now();
    const { statuses, lastLoadedAt } = get();

    if (!options.force && statuses.length > 0 && now - lastLoadedAt < FRESH_MS) {
      return statuses;
    }

    // A forced read must not join a request that started before the change it was forced by.
    if (inFlight && !options.force) return inFlight;

    const requestGeneration = ++generation;
    set({ isLoading: true, error: null });
    const request: Promise<DaemonUpdateStatus[]> = api
      .getDaemonUpdates()
      .then((data): DaemonUpdateStatus[] | Promise<DaemonUpdateStatus[]> => {
        // Superseded: answer with the newer request so no caller acts on the older data.
        if (requestGeneration !== generation)
          return inFlight && inFlight !== request ? inFlight : get().statuses;
        set({
          statuses: data,
          isLoading: false,
          error: null,
          lastLoadedAt: Date.now(),
        });
        return data;
      })
      .catch((err) => {
        if (requestGeneration === generation) {
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : "Failed to load daemon updates",
          });
        }
        throw err;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  },

  setDaemonUpdates: (statuses) => {
    generation++;
    set({
      statuses,
      isLoading: false,
      error: null,
      lastLoadedAt: Date.now(),
    });
  },
}));
