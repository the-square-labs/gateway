import { describe, expect, it } from "vitest";
import { proxyUpstreamResourceName, proxyUpstreamText } from "../../src/lib/proxy-upstream-label";

const manual = {
  type: "proxy" as const,
  upstreamKind: "manual" as const,
  forwardHost: "backend.internal",
  forwardPort: 8080,
  forwardScheme: "http" as const,
};

describe("proxyUpstreamLabel", () => {
  it("keeps the resolved URL for manual targets", () => {
    expect(proxyUpstreamText(manual)).toBe("http://backend.internal:8080");
  });

  it("shows a semantic container target without its resolved node address", () => {
    expect(
      proxyUpstreamResourceName({
        ...manual,
        upstreamKind: "docker_container",
        forwardHost: "gateway-dind",
        forwardPort: 18080,
        dockerContainerName: "proxy-link-smoke",
        dockerContainerPort: 80,
        dockerProtocol: "tcp",
      })
    ).toBe("proxy-link-smoke");
  });

  it("uses the deployment name rather than its id or router endpoint", () => {
    expect(
      proxyUpstreamResourceName({
        ...manual,
        upstreamKind: "docker_deployment",
        dockerDeploymentId: "11111111-1111-4111-8111-111111111111",
        dockerDeploymentName: "api-production",
        dockerContainerPort: 3000,
        dockerProtocol: "tcp",
      })
    ).toBe("api-production");
  });
});
