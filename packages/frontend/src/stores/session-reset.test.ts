import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { resetClientSessionState } from "@/stores/session-reset";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";

afterEach(() => {
  resetClientSessionState();
});

describe("resetClientSessionState", () => {
  it("preserves only same-account shell preferences and global config, never private state", () => {
    useUIStore.setState({
      interfacePreferenceLoaded: true,
      preferredInterface: "operations_console",
      aiLiteMode: false,
    });
    useSystemConfigStore.getState().setConfig({ fileOpenMaxBytes: 123 });
    api.setCache("secret", { data: "private" });
    useAIStore.setState({ messages: [{ id: "m", role: "assistant", content: "private" }] });
    usePinnedDatabasesStore.setState({ sidebarDatabaseIds: ["private"], databaseMeta: {} });
    resetClientSessionState({ preserveShell: true });
    expect(useUIStore.getState()).toMatchObject({
      interfacePreferenceLoaded: true,
      preferredInterface: "operations_console",
    });
    expect(useSystemConfigStore.getState()).toMatchObject({
      loaded: true,
      config: { fileOpenMaxBytes: 123 },
    });
    expect(api.getCached("secret")).toBeUndefined();
    expect(useAIStore.getState().messages).toEqual([]);
    expect(usePinnedDatabasesStore.getState().sidebarDatabaseIds).toEqual([]);
  });
  it("clears auth-sensitive cache, AI state, and persisted pinned metadata", () => {
    api.setCache("sensitive", { ok: true });
    useAIStore.setState({
      messages: [{ id: "msg-1", role: "assistant", content: "secret" }],
      isConnected: true,
      isStreaming: true,
      savedName: "incident",
      pendingApprovalToolCallId: "tool-1",
    });
    useUIStore.setState({
      aiPanelOpen: true,
      aiLiteMode: true,
      aiApprovalModeLoaded: true,
      preferredInterface: "ai_workspace",
      interfacePreferenceLoaded: true,
    });
    usePinnedDatabasesStore.setState({
      sidebarDatabaseIds: ["db-1"],
      databaseMeta: { "db-1": { slug: "prod", name: "Prod", type: "postgres" } },
    });
    usePinnedContainersStore.setState({
      sidebarContainerIds: ["container-1"],
      dashboardContainerIds: ["container-1"],
      containerMeta: {
        "container-1": { nodeId: "node-1", nodeSlug: "prod-node", name: "payments" },
      },
    });

    resetClientSessionState();

    expect(api.getCached("sensitive")).toBeUndefined();
    expect(useAIStore.getState()).toMatchObject({
      messages: [],
      isConnected: false,
      isStreaming: false,
      savedName: null,
      pendingApprovalToolCallId: null,
    });
    expect(useUIStore.getState()).toMatchObject({
      aiPanelOpen: false,
      aiLiteMode: false,
      aiApprovalModeLoaded: false,
      preferredInterface: null,
      interfacePreferenceLoaded: false,
    });
    expect(usePinnedDatabasesStore.getState()).toMatchObject({
      sidebarDatabaseIds: [],
      databaseMeta: {},
    });
    expect(usePinnedContainersStore.getState()).toMatchObject({
      sidebarContainerIds: [],
      dashboardContainerIds: [],
      containerMeta: {},
    });
  });
});
