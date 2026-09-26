// Sidebar items fade their highlight through an inset box-shadow, not background-color:
// Chrome composites background-colour transitions and, when the main thread is busy as a
// navigation lands (the next page mounting and loading), paints the old fill for one frame
// after the fade has ended, so the item just left blinks as selected. A shadow fades on the
// main thread, like the text colour, and cannot show a stale frame.

/** Same shape in every state, so only the colour interpolates. */
export const SIDEBAR_ITEM_FADE =
  "transition-[color,box-shadow] shadow-[inset_0_0_0_100vmax_transparent]";
export const SIDEBAR_ITEM_FILL = "shadow-[inset_0_0_0_100vmax_var(--color-sidebar-accent)]";
export const SIDEBAR_ITEM_HOVER_FILL =
  "hover:shadow-[inset_0_0_0_100vmax_var(--color-sidebar-accent)]";
