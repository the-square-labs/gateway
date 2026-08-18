import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { UIBootstrapShell } from "@/types";

const SNAPSHOT = {
  access: { fingerprint: "fingerprint", scopes: [] },
  systemConfig: {
    fileUploadMaxBytes: 1,
    fileOpenMaxBytes: 1,
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
    relayAutoRecovery: true,
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      siemEnabled: true,
      loggingEnabled: false,
      inferenceEnabled: false,
    },
  },
  navigation: {
    hasNginxNodes: false,
    hasCloudflareIntegration: false,
    statusPageEnabled: false,
    pagesEnabled: false,
    dockerNodes: [],
    nodes: {
      data: [],
      revision: 1,
      observedAt: null,
      lastAttemptAt: null,
      lastError: null,
      refreshStatus: "success",
      availability: "available",
    },
  },
  update: null,
  aiStatus: null,
  aiWorkspace: { configured: false, installationOwner: false },
  license: {
    status: "community",
    plan: "community",
    licensed: true,
    expiresAt: null,
    graceUntil: null,
    offlineGraceUntil: null,
    entitlementsVersion: 3,
    entitlements: {
      managedNodes: 100,
      users: 10,
      customPermissionGroups: 5,
      supportLevel: "community",
      features: [],
    },
  },
} as UIBootstrapShell;

describe("UI bootstrap store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.spyOn(api, "getUIBootstrap").mockReset();
    useUIBootstrapStore.getState().clear();
  });

  it("deduplicates the initial shell request for one authorization key", async () => {
    vi.mocked(api.getUIBootstrap).mockResolvedValueOnce(SNAPSHOT);

    const [first, second] = await Promise.all([
      useUIBootstrapStore.getState().load("user:scopes"),
      useUIBootstrapStore.getState().load("user:scopes"),
    ]);

    expect(api.getUIBootstrap).toHaveBeenCalledTimes(1);
    expect(first).toBe(SNAPSHOT);
    expect(second).toBe(SNAPSHOT);
  });

  it("keeps the visible shell while an invalidation replaces an in-flight request", async () => {
    let resolveStale!: (value: UIBootstrapShell) => void;
    const staleRequest = new Promise<UIBootstrapShell>((resolve) => {
      resolveStale = resolve;
    });
    const refreshed = {
      ...SNAPSHOT,
      navigation: { ...SNAPSHOT.navigation, hasNginxNodes: true },
    } as UIBootstrapShell;
    vi.mocked(api.getUIBootstrap)
      .mockResolvedValueOnce(SNAPSHOT)
      .mockReturnValueOnce(staleRequest)
      .mockResolvedValueOnce(refreshed);

    await useUIBootstrapStore.getState().load("user:scopes");
    void useUIBootstrapStore.getState().load("user:scopes:next");
    useUIBootstrapStore.getState().invalidate();
    resolveStale(SNAPSHOT);

    await vi.waitFor(() => expect(api.getUIBootstrap).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(useUIBootstrapStore.getState().snapshot).toBe(refreshed));
  });

  it("coalesces rapid shell invalidations into one refresh", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getUIBootstrap)
      .mockResolvedValueOnce(SNAPSHOT)
      .mockResolvedValueOnce({
        ...SNAPSHOT,
        navigation: { ...SNAPSHOT.navigation, hasNginxNodes: true },
      });

    await useUIBootstrapStore.getState().load("user:scopes");
    useUIBootstrapStore.getState().invalidate();
    useUIBootstrapStore.getState().invalidate();
    useUIBootstrapStore.getState().invalidate();

    await vi.advanceTimersByTimeAsync(250);

    expect(api.getUIBootstrap).toHaveBeenCalledTimes(2);
  });
});
