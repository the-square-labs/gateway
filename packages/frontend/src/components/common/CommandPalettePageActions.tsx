import { useRegisterCommandPalettePageActions } from "@/hooks/use-command-palette-page-actions";
import type { CommandPalettePageAction } from "@/stores/command-palette-page-actions";

export function CommandPalettePageActions({
  actions,
  routeKey,
}: {
  actions: CommandPalettePageAction[];
  routeKey?: string;
}) {
  useRegisterCommandPalettePageActions(actions, routeKey);
  return null;
}
