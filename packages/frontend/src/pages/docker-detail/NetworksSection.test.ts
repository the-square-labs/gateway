import { describe, expect, it } from "vitest";
import { readAttachedNetworks } from "./NetworksSection";

describe("readAttachedNetworks", () => {
  it("hides Gateway-managed database networks from container settings", () => {
    expect(
      readAttachedNetworks({
        bridge: { NetworkID: "bridge-id" },
        "gateway-db-79c029a3cedc4af1": { NetworkID: "managed-id" },
        application: { NetworkID: "application-id" },
      }).map((network) => network.name)
    ).toEqual(["bridge", "application"]);
  });
});
