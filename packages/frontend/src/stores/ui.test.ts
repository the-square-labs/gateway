import { syncAILiteModeFromStorageValue, useUIStore } from "@/stores/ui";

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

afterEach(() => {
  setViewportWidth(originalInnerWidth);
  useUIStore.setState({
    aiPanelOpen: false,
    aiLiteMode: false,
    sidebarOpen: true,
    sidebarCollapsed: false,
    aiWorkspaceSidebarCollapsed: false,
    mobileMenuOpen: false,
  });
});

describe("compact panel layout", () => {
  it("collapses navigation when the AI panel opens", () => {
    setViewportWidth(899);

    useUIStore.getState().setAIPanelOpen(true);

    expect(useUIStore.getState()).toMatchObject({
      aiPanelOpen: true,
      sidebarOpen: false,
      sidebarCollapsed: true,
      mobileMenuOpen: false,
    });
  });

  it("closes the AI panel when navigation expands", () => {
    setViewportWidth(899);
    useUIStore.setState({ aiPanelOpen: true, sidebarOpen: false, sidebarCollapsed: true });

    useUIStore.getState().setSidebarCollapsed(false);

    expect(useUIStore.getState()).toMatchObject({
      aiPanelOpen: false,
      sidebarOpen: true,
      sidebarCollapsed: false,
    });
  });

  it("opens navigation whenever the user enters AI Workspace", () => {
    setViewportWidth(899);
    useUIStore.setState({ sidebarOpen: false, sidebarCollapsed: true });

    useUIStore.getState().setPreferredInterface("ai_workspace");

    expect(useUIStore.getState()).toMatchObject({
      aiLiteMode: true,
      sidebarOpen: true,
      sidebarCollapsed: false,
    });
  });

  it("allows navigation to be collapsed manually inside AI Workspace", () => {
    setViewportWidth(899);
    useUIStore.getState().setPreferredInterface("ai_workspace");
    useUIStore.getState().setSidebarCollapsed(true);

    expect(useUIStore.getState()).toMatchObject({
      aiLiteMode: true,
      sidebarOpen: false,
      sidebarCollapsed: true,
      aiWorkspaceSidebarCollapsed: true,
    });
  });

  it("preserves a manual AI Workspace collapse across interface switches", () => {
    setViewportWidth(899);
    useUIStore.getState().setPreferredInterface("ai_workspace");
    useUIStore.getState().setSidebarCollapsed(true);

    useUIStore.getState().setPreferredInterface("operations_console");
    useUIStore.getState().setPreferredInterface("ai_workspace");

    expect(useUIStore.getState()).toMatchObject({
      aiLiteMode: true,
      sidebarOpen: false,
      sidebarCollapsed: true,
      aiWorkspaceSidebarCollapsed: true,
    });
  });

  it("does not treat an Operations Console auto-collapse as an AI Workspace preference", () => {
    setViewportWidth(899);
    useUIStore.getState().setAIPanelOpen(true);

    useUIStore.getState().setPreferredInterface("ai_workspace");

    expect(useUIStore.getState()).toMatchObject({
      aiLiteMode: true,
      sidebarOpen: true,
      sidebarCollapsed: false,
      aiWorkspaceSidebarCollapsed: false,
    });
  });

  it("keeps both desktop panels open on wide screens", () => {
    setViewportWidth(1440);

    useUIStore.getState().setAIPanelOpen(true);

    expect(useUIStore.getState()).toMatchObject({
      aiPanelOpen: true,
      sidebarOpen: true,
      sidebarCollapsed: false,
    });
  });
});

describe("syncAILiteModeFromStorageValue", () => {
  it("applies lite mode changes from persisted UI storage", () => {
    useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });

    syncAILiteModeFromStorageValue(JSON.stringify({ state: { aiLiteMode: true } }));

    expect(useUIStore.getState()).toMatchObject({
      aiPanelOpen: false,
      aiLiteMode: true,
    });

    syncAILiteModeFromStorageValue(JSON.stringify({ state: { aiLiteMode: false } }));

    expect(useUIStore.getState().aiLiteMode).toBe(false);
  });

  it("ignores malformed and unrelated persisted UI storage", () => {
    useUIStore.setState({ aiLiteMode: true });

    syncAILiteModeFromStorageValue("{bad json");
    syncAILiteModeFromStorageValue(JSON.stringify({ state: { aiLiteMode: "true" } }));
    syncAILiteModeFromStorageValue(JSON.stringify({ state: { sidebarOpen: false } }));

    expect(useUIStore.getState().aiLiteMode).toBe(true);
  });
});
