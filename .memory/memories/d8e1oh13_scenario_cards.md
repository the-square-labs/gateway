---
{
  "id": "d8e1oh13",
  "file_name": "d8e1oh13_scenario_cards",
  "tags": [
    "ai-workspace",
    "dialog",
    "lite-mode",
    "responsive",
    "scenario-cards",
    "sidebar",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1786570827252,
  "updated_at": 1786571549567
}
---
For AI Workspace scenario cards, keep the icon vertically centered with the title in the header row, while the description spans the full card width from the left edge. This avoids an unnecessary icon-sized indentation on the multi-line description while reusing the existing Button/card composition. In the single-column scenario catalog, cards have content-driven height: do not add a fixed or minimum height.

For Lite Mode, adapt the ordinary SidebarContent and page-header patterns: collapsed navigation items must use the same active background and icon-relative attention-badge offsets as the normal sidebar. When LiteModeBackButton is present, wrap the title and description in the same text column so the description aligns under the title rather than under the back button.

The AI Workspace scenario catalog is a compact single-column dialog: use `sm:max-w-xl`, no added fixed height or inner scroll container, and let the standard Dialog overlay manage overflow on short screens.

DashboardLayout must evaluate the selected AI Workspace before its mobile fallback. On mobile, the AI home/chat route renders AILitePanel directly; an AI button from a regular mobile page returns to AI Workspace when that interface is selected instead of opening the Operations Console side panel.
