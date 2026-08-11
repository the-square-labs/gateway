export const COMPACT_PANELS_BREAKPOINT = 900;
export const AI_PANEL_DEFAULT_WIDTH = 410;
export const AI_PANEL_MIN_WIDTH = 360;
export const AI_PANEL_MAX_WIDTH = 560;

export function isCompactPanelsViewport(viewportWidth: number): boolean {
  return viewportWidth < COMPACT_PANELS_BREAKPOINT;
}

export function getDefaultAIPanelWidth(viewportWidth: number): number {
  return Math.min(
    AI_PANEL_DEFAULT_WIDTH,
    Math.max(AI_PANEL_MIN_WIDTH, Math.round(viewportWidth * 0.4))
  );
}
