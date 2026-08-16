import { navigationAttentionForItem, navigationAttentionLabel } from "./navigation-attention";

describe("navigation attention", () => {
  it("returns only supported page attention", () => {
    const snapshot = {
      navigationAttention: {
        nodes: "critical",
        "proxy-hosts": "warning",
        docker: null,
      },
    } as never;

    expect(navigationAttentionForItem(snapshot, "nodes")).toBe("critical");
    expect(navigationAttentionForItem(snapshot, "proxy-hosts")).toBe("warning");
    expect(navigationAttentionForItem(snapshot, "settings")).toBeNull();
  });

  it("provides accessible status labels", () => {
    expect(navigationAttentionLabel("nodes", "critical")).toBe("Some nodes are offline");
    expect(navigationAttentionLabel("nodes", "warning")).toBe("Some nodes have pending updates");
    expect(navigationAttentionLabel("proxy-hosts", "warning")).toBe("Some routes are degraded");
    expect(navigationAttentionLabel("docker", "critical")).toBe(
      "Some Docker workloads are offline"
    );
  });
});
