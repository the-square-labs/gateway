import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerContainer } from "@/types";
import {
  CreateProxyHostDialog,
  defaultProxyUpstreamForDockerTargets,
} from "./CreateProxyHostDialog";

function dockerTarget(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "container-1",
    name: "app",
    image: "example/app:latest",
    state: "running",
    status: "Up",
    created: 1,
    ports: [],
    kind: "container",
    ...overrides,
  };
}

describe("proxy upstream defaults", () => {
  it("keeps manual target when Docker has no resources", () => {
    expect(defaultProxyUpstreamForDockerTargets([]).kind).toBe("manual");
  });

  it("defaults to the available Docker resource kind", () => {
    expect(defaultProxyUpstreamForDockerTargets([dockerTarget()]).kind).toBe("docker_container");
    expect(
      defaultProxyUpstreamForDockerTargets([
        dockerTarget({ kind: "deployment", id: "deployment-1", deploymentId: "deployment-1" }),
      ]).kind
    ).toBe("docker_deployment");
  });
});

describe("CreateProxyHostDialog", () => {
  it("shows a cached nginx node while the refresh is still pending", async () => {
    api.setCache("nodes:list:default", {
      data: [
        {
          id: "node-1",
          hostname: "nginx-uae",
          displayName: "UAE proxy node",
          type: "nginx",
          status: "online",
          serviceCreationLocked: false,
          capabilities: {},
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });
    vi.spyOn(api, "listNodes").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockReturnValue(new Promise(() => {}));

    render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);
    const nodeTrigger = screen.getByRole("combobox", { name: "Ingress node" });
    expect(nodeTrigger).not.toBeDisabled();
    expect(nodeTrigger).toHaveAttribute("aria-busy", "false");
  });

  it("restores the node loading state when an empty selector is reopened", async () => {
    api.invalidateCache("nodes:list:default");
    const listNodes = vi
      .spyOn(api, "listNodes")
      .mockResolvedValueOnce({ data: [] } as never)
      .mockReturnValueOnce(new Promise(() => {}));
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);

    const dialog = render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(listNodes).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
    );

    dialog.rerender(<CreateProxyHostDialog open={false} onOpenChange={vi.fn()} />);
    dialog.rerender(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

    const nodeTrigger = screen.getByRole("combobox", { name: "Ingress node" });
    expect(nodeTrigger).toBeDisabled();
    expect(nodeTrigger).toHaveAttribute("aria-busy", "true");
  });

  it("selects the registered domain ingress node automatically", async () => {
    api.invalidateCache("nodes:list:default");
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        {
          id: "node-1",
          hostname: "edge-one",
          displayName: "Edge One",
          type: "nginx",
          status: "online",
          serviceCreationLocked: false,
          capabilities: {},
        },
        {
          id: "node-2",
          hostname: "edge-two",
          displayName: "Edge Two",
          type: "nginx",
          status: "online",
          serviceCreationLocked: false,
          capabilities: {},
        },
      ],
    } as never);
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      {
        id: "domain-2",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-2",
      },
    ]);
    const user = userEvent.setup();

    render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));

    expect(screen.getByRole("combobox", { name: "Ingress node" })).toHaveTextContent("Edge Two");
  });
});
