import { describe, expect, it } from "vitest";
import type { DockerContainer } from "@/types";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  proxyUpstreamForDockerTarget,
  proxyUpstreamRequest,
} from "./ProxyUpstreamEditor";

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "container-1",
    name: "api",
    image: "nginx:alpine",
    state: "running",
    status: "Up",
    created: 1,
    nodeId: "node-1",
    ports: [{ privatePort: 80, publicPort: 18080, type: "tcp", ip: "0.0.0.0" }],
    ...overrides,
  };
}

describe("proxy Docker upstream selection", () => {
  it("automatically selects a single declared TCP application port", () => {
    const selected = proxyUpstreamForDockerTarget(DEFAULT_PROXY_UPSTREAM, container());

    expect(selected).toMatchObject({
      kind: "docker_container",
      dockerNodeId: "node-1",
      containerName: "api",
      containerPort: 80,
    });
    expect(isProxyUpstreamValid(selected)).toBe(true);
    expect(proxyUpstreamRequest(selected)).toMatchObject({
      upstreamKind: "docker_container",
      dockerNodeId: "node-1",
      dockerContainerName: "api",
      dockerContainerPort: 80,
      dockerProtocol: "tcp",
    });
    expect(proxyUpstreamRequest(selected)).not.toHaveProperty("dockerHostPort");
  });

  it("requires an explicit choice when multiple mappings exist", () => {
    const selected = proxyUpstreamForDockerTarget(
      DEFAULT_PROXY_UPSTREAM,
      container({
        ports: [
          { privatePort: 80, publicPort: 18080, type: "tcp" },
          { privatePort: 443, publicPort: 18443, type: "tcp" },
        ],
      })
    );

    expect(selected.containerPort).toBeNull();
    expect(isProxyUpstreamValid(selected)).toBe(false);
  });

  it("uses a declared application port even when the old host mapping is loopback-only", () => {
    const selected = proxyUpstreamForDockerTarget(
      DEFAULT_PROXY_UPSTREAM,
      container({
        ports: [{ privatePort: 80, publicPort: 18080, type: "tcp", ip: "127.0.0.1" }],
      })
    );

    expect(selected.containerPort).toBe(80);
    expect(isProxyUpstreamValid(selected)).toBe(true);
  });

  it("allows a manual application port without any published mapping", () => {
    const selected = proxyUpstreamForDockerTarget(DEFAULT_PROXY_UPSTREAM, container({ ports: [] }));
    const manual = { ...selected, containerPort: 8080 };

    expect(isProxyUpstreamValid(manual)).toBe(true);
    expect(proxyUpstreamRequest(manual)).toMatchObject({ dockerContainerPort: 8080 });
  });

  it("stores a deployment reference instead of a slot container", () => {
    const selected = proxyUpstreamForDockerTarget(
      DEFAULT_PROXY_UPSTREAM,
      container({ kind: "deployment", id: "deployment-1", deploymentId: "deployment-1" })
    );

    expect(selected).toMatchObject({
      kind: "docker_deployment",
      deploymentId: "deployment-1",
      dockerNodeId: null,
      containerName: null,
    });
  });

  it("stores a stable Compose service reference without a child container name", () => {
    const selected = {
      ...DEFAULT_PROXY_UPSTREAM,
      kind: "docker_container" as const,
      dockerNodeId: "node-1",
      composeProjectId: "project-1",
      composeServiceName: "api",
      containerPort: 8080,
    };

    expect(isProxyUpstreamValid(selected)).toBe(true);
    expect(proxyUpstreamRequest(selected)).toMatchObject({
      upstreamKind: "docker_container",
      dockerNodeId: "node-1",
      dockerContainerName: null,
      dockerComposeProjectId: "project-1",
      dockerComposeServiceName: "api",
      dockerContainerPort: 8080,
    });
  });
});
