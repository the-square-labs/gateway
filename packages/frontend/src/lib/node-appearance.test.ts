import { describe, expect, it } from "vitest";
import { daemonTypeForNode, nodeTypeLabel } from "./node-appearance";

describe("node appearance mappings", () => {
  it("labels and updates Build Workers as docker-daemon nodes", () => {
    expect(nodeTypeLabel("builder")).toBe("Build Worker");
    expect(daemonTypeForNode("builder")).toBe("docker");
  });

  it("keeps existing node daemon mappings", () => {
    expect(daemonTypeForNode("databases")).toBe("docker");
    expect(daemonTypeForNode("docker")).toBe("docker");
    expect(daemonTypeForNode("nginx")).toBe("nginx");
    expect(daemonTypeForNode("monitoring")).toBe("monitoring");
  });
});
