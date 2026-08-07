import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { UIBootstrapShell } from "@/types";

const SNAPSHOT = {
  access: { fingerprint: "fingerprint", scopes: [] },
  systemConfig: {
    fileUploadMaxBytes: 1,
    fileOpenMaxBytes: 1,
    gatewayPublicIps: [],
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      loggingEnabled: false,
      inferenceEnabled: false,
    },
  },
  navigation: {
    hasNginxNodes: false,
    hasCloudflareIntegration: false,
    statusPageEnabled: false,
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
} as UIBootstrapShell;

describe("UI bootstrap store", () => {
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
});
