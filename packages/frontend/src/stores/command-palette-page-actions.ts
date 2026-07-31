import type { ReactNode } from "react";
import { create } from "zustand";

export interface CommandPalettePageAction {
  id: string;
  label: string;
  icon?: ReactNode;
  action: () => void;
  disabled?: boolean;
  keywords?: readonly string[];
}

export interface CommandPalettePageActionRegistration {
  routeKey: string;
  actions: CommandPalettePageAction[];
}

interface CommandPalettePageActionsState {
  ownerToken: number;
  registrations: Record<number, CommandPalettePageActionRegistration>;
  register: (routeKey: string, actions: CommandPalettePageAction[]) => number;
  clear: (ownerToken: number) => void;
}

export const useCommandPalettePageActions = create<CommandPalettePageActionsState>()(
  (set, get) => ({
    ownerToken: 0,
    registrations: {},
    register: (routeKey, actions) => {
      const ownerToken = get().ownerToken + 1;
      set((state) => ({
        ownerToken,
        registrations: {
          ...state.registrations,
          [ownerToken]: { routeKey, actions },
        },
      }));
      return ownerToken;
    },
    clear: (ownerToken) => {
      if (!get().registrations[ownerToken]) return;
      set((state) => {
        const registrations = { ...state.registrations };
        delete registrations[ownerToken];
        return { registrations };
      });
    },
  })
);
