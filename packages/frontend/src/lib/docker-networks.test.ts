import { describe, expect, it } from "vitest";
import { filterUserDockerNetworks, isGatewayManagedDockerNetwork } from "./docker-networks";

describe("Gateway-managed Docker networks", () => {
  it("hides Secure Links, managed database and managed storage link networks", () => {
    expect(
      filterUserDockerNetworks([
        { name: "frontend" },
        { name: "gateway-secure-links" },
        { name: "gateway-db-79c029a3cedc4af1" },
        { Name: "gateway-storage-0123456789abcdef" },
      ])
    ).toEqual([{ name: "frontend" }]);
    expect(isGatewayManagedDockerNetwork("my-gateway-storage")).toBe(false);
    // Only the exact per-link and cluster names are Gateway's.
    expect(isGatewayManagedDockerNetwork("gateway-storage-assets")).toBe(false);
    expect(
      isGatewayManagedDockerNetwork("gateway-storage-11111111-1111-4111-8111-111111111111")
    ).toBe(true);
  });
});
