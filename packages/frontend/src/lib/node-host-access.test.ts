import { describe, expect, it } from "vitest";
import type { Node } from "@/types";
import { isNodeHostFeatureDisabled, nodeHostFeatureDisabledMessage } from "./node-host-access";

function node(type: Node["type"], capabilities: Record<string, unknown>): Node {
  return { type, capabilities } as Node;
}

describe("node host access", () => {
  it("treats console and files as enabled unless the node reports them disabled", () => {
    expect(isNodeHostFeatureDisabled(node("docker", {}), "console")).toBe(false);
    expect(isNodeHostFeatureDisabled(node("docker", {}), "files")).toBe(false);
    expect(isNodeHostFeatureDisabled(null, "console")).toBe(false);
  });

  it("reads the stored flags and the raw markers", () => {
    const consoleOff = node("nginx", { nodeConsoleDisabled: true });
    expect(isNodeHostFeatureDisabled(consoleOff, "console")).toBe(true);
    expect(isNodeHostFeatureDisabled(consoleOff, "files")).toBe(false);
    const filesMarker = node("docker", { capabilities: ["node_files_disabled_v1"] });
    expect(isNodeHostFeatureDisabled(filesMarker, "files")).toBe(true);
  });

  it("names the config key and the daemon config file of the node type", () => {
    expect(nodeHostFeatureDisabledMessage(node("docker", {}), "console")).toBe(
      "The host console is disabled in this node's daemon configuration. To enable it, set console.enabled: true in the daemon config (/etc/docker-daemon/config.yaml) on the node and restart the daemon."
    );
    expect(nodeHostFeatureDisabledMessage(node("bastion", {}), "files")).toContain(
      "set files.enabled: true in the daemon config file on the node"
    );
  });
});
