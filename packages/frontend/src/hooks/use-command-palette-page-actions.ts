import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import {
  type CommandPalettePageAction,
  useCommandPalettePageActions,
} from "@/stores/command-palette-page-actions";

export function useRegisterCommandPalettePageActions(
  actions: CommandPalettePageAction[],
  routeKey?: string
) {
  const location = useLocation();
  const register = useCommandPalettePageActions((state) => state.register);
  const clear = useCommandPalettePageActions((state) => state.clear);
  const activeRouteKey = routeKey ?? location.pathname;

  useEffect(() => {
    if (actions.length === 0) return;
    const ownerToken = register(activeRouteKey, actions);
    return () => clear(ownerToken);
  }, [actions, activeRouteKey, clear, register]);
}
