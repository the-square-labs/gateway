import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useDockerStore } from "@/stores/docker";
import { makeNode } from "@/test/fixtures";
import { ProxyUpstreamTarget } from "./ProxyUpstreamTarget";

describe("ProxyUpstreamTarget", () => {
  it("renders a Docker container as a Docker cube badge with its exact name", () => {
    render(
      <ProxyUpstreamTarget
        host={{
          type: "proxy",
          upstreamKind: "docker_container",
          forwardHost: "gateway-dind",
          forwardPort: 18080,
          forwardScheme: "http",
          dockerContainerName: "proxy-link-smoke",
        }}
      />
    );

    const name = screen.getByText("proxy-link-smoke");
    const badge = name.closest("div");
    expect(badge).toHaveClass("bg-muted");
    expect(badge?.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText(/gateway-dind/)).not.toBeInTheDocument();
  });

  it("keeps manual upstreams as plain text", () => {
    render(
      <ProxyUpstreamTarget
        host={{
          type: "proxy",
          upstreamKind: "manual",
          forwardHost: "backend.internal",
          forwardPort: 8080,
          forwardScheme: "http",
        }}
      />
    );

    expect(screen.getByText("http://backend.internal:8080").tagName).toBe("SPAN");
  });

  it("links a Secure Link target badge to the Docker resource when requested", () => {
    useDockerStore.setState({
      dockerNodes: [makeNode({ id: "node-1", slug: "docker-one", type: "docker" })],
    });

    render(
      <MemoryRouter>
        <ProxyUpstreamTarget
          linkToResource
          host={{
            type: "proxy",
            upstreamKind: "docker_container",
            forwardHost: null,
            forwardPort: null,
            forwardScheme: "http",
            dockerNodeId: "node-1",
            dockerContainerName: "backend",
          }}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "backend" });
    expect(link).toHaveAttribute("href", "/docker/containers/docker-one/backend");
    expect(link.firstElementChild).toHaveClass("bg-muted");
  });
});
