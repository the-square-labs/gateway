import { describe, expect, it } from "vitest";
import { isGatewayPublicRoute } from "./proxy-route-protection";

describe("isGatewayPublicRoute", () => {
  it("matches a route domain to the configured public URL hostname", () => {
    expect(
      isGatewayPublicRoute(
        { domainNames: ["other.example.com", "gateway.example.com"] },
        "https://gateway.example.com/settings"
      )
    ).toBe(true);
  });

  it("normalizes hostname case and a trailing dot", () => {
    expect(
      isGatewayPublicRoute({ domainNames: ["Gateway.Example.com."] }, "https://gateway.example.com")
    ).toBe(true);
  });

  it("does not protect unrelated routes or invalid public URLs", () => {
    expect(
      isGatewayPublicRoute({ domainNames: ["app.example.com"] }, "https://gateway.example.com")
    ).toBe(false);
    expect(isGatewayPublicRoute({ domainNames: ["gateway.example.com"] }, "invalid")).toBe(false);
  });
});
