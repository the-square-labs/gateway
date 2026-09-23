import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { DockerContainer } from "@/types";
import {
  CreateProxyHostDialog,
  defaultProxyUpstreamForDockerTargets,
} from "./CreateProxyHostDialog";

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
});

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
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["proxy:create"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "personal", entitlements: { features: ["pages"] } },
        navigation: { pagesEnabled: true },
      } as never,
    });
  });

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

  it("submits a Pages upstream target through the create flow", async () => {
    api.invalidateCache("nodes:list:default");
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        {
          id: "node-ready",
          hostname: "edge-ready",
          displayName: "Edge Ready",
          type: "nginx",
          status: "online",
          serviceCreationLocked: false,
          capabilities: { capabilities: ["nginx_pages_v1", "nginx_pages_config_v1"] },
        },
      ],
    } as never);
    vi.spyOn(api, "listPageProjects").mockResolvedValue({
      data: [
        {
          id: "project-1",
          name: "Marketing",
          slug: "marketing",
        },
      ],
    } as never);
    vi.spyOn(api, "listPageTags").mockResolvedValue([
      {
        id: "tag-production",
        projectId: "project-1",
        name: "production",
        system: true,
        generation: 1,
        deployment: {
          id: "deployment-1",
          sequence: 1,
          publicSlug: "release-1",
          status: "ready",
        },
      },
    ] as never);
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({
      data: [
        {
          id: "certificate-1",
          name: "Pages certificate",
          type: "acme",
          domainNames: ["pages.example.com"],
        },
      ],
    } as never);
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);
    const createProxyHost = vi
      .spyOn(api, "createProxyHost")
      .mockResolvedValue({ id: "route-1" } as never);
    const user = userEvent.setup();

    render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
    );
    await user.click(screen.getByRole("combobox", { name: "Ingress node" }));
    await user.click(screen.getByRole("option", { name: /Edge Ready/i }));
    await user.type(screen.getByPlaceholderText("example.com"), "pages.example.com");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(screen.getByText("Target")).toBeInTheDocument());

    const targetRow = screen.getByText("Target", { exact: true }).parentElement?.parentElement;
    expect(targetRow).toBeTruthy();
    await user.click(within(targetRow as HTMLElement).getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Pages" }));
    expect(screen.queryByText("WebSocket Support")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Page Project" })).not.toBeDisabled()
    );

    const pageProjectSelect = screen.getByRole("combobox", { name: "Page Project" });
    await user.click(pageProjectSelect);
    await user.type(pageProjectSelect, "missing");
    expect(screen.getByText("No matching Page Projects.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(pageProjectSelect).toHaveValue("");

    await user.click(pageProjectSelect);
    await user.click(screen.getByRole("button", { name: /Marketing · marketing/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Tag" })).not.toBeDisabled());
    await user.click(screen.getByRole("combobox", { name: "Tag" }));
    await user.click(screen.getByRole("button", { name: /production/i }));

    const sslEnabledRow = screen.getByText("SSL Enabled").parentElement?.parentElement;
    expect(sslEnabledRow).toBeTruthy();
    await user.click(within(sslEnabledRow as HTMLElement).getByRole("button"));
    const certificateCombobox = screen.getByRole("combobox", { name: "SSL Certificate" });
    await user.click(certificateCombobox);
    await user.type(certificateCombobox, "Pages certificate");
    await user.click(screen.getByRole("button", { name: /Pages certificate \(acme\)/i }));
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createProxyHost).toHaveBeenCalledOnce());
    expect(createProxyHost.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "proxy",
        upstreamKind: "pages",
        pageProjectId: "project-1",
        pageTagId: "tag-production",
        nodeId: "node-ready",
        websocketSupport: false,
        sslEnabled: true,
        sslCertificateId: "certificate-1",
      })
    );
  });

  it("does not advance to the Pages target when the selected ingress node is locked", async () => {
    api.invalidateCache("nodes:list:default");
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        {
          id: "node-offline",
          hostname: "edge-offline",
          displayName: "Edge Offline",
          type: "nginx",
          status: "offline",
          serviceCreationLocked: true,
          capabilities: { capabilities: ["nginx_pages_v1", "nginx_pages_config_v1"] },
        },
      ],
    } as never);
    vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockResolvedValue([
      {
        id: "domain-offline",
        domain: "pages.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-offline",
      },
    ]);
    const createProxyHost = vi
      .spyOn(api, "createProxyHost")
      .mockResolvedValue({ id: "route-1" } as never);
    const user = userEvent.setup();

    render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
    );
    await user.type(screen.getByPlaceholderText("example.com"), "pages.example.com");
    await user.click(await screen.findByRole("button", { name: /pages\.example\.com/i }));

    expect(screen.getByRole("combobox", { name: "Ingress node" })).toHaveTextContent(
      "Edge Offline"
    );
    expect(screen.queryByRole("button", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    expect(createProxyHost).not.toHaveBeenCalled();
  });

  describe("editing an existing route", () => {
    const existingHost = {
      id: "host-1",
      type: "proxy",
      nodeId: "node-1",
      domainNames: ["app.example.com"],
      upstreamKind: "manual",
      forwardScheme: "http",
      forwardHost: "10.0.0.2",
      forwardPort: 8080,
      websocketSupport: true,
      sslEnabled: true,
      sslForced: true,
      http2Support: true,
      sslCertificateId: "certificate-1",
      internalCertificateId: null,
      nginxTemplateId: null,
      templateVariables: { cacheEnabled: true },
      rawConfigEnabled: false,
      redirectUrl: null,
      redirectStatusCode: 301,
    } as never;

    beforeEach(() => {
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
        ],
      } as never);
      vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
      vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
      vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
      vi.spyOn(api, "searchDomains").mockResolvedValue([]);
    });

    it("pre-fills the form again when reopened after the close animation reset it", async () => {
      const dialog = render(
        <CreateProxyHostDialog open onOpenChange={vi.fn()} existingHost={existingHost} />
      );
      expect(screen.getByPlaceholderText("example.com")).toHaveValue("app.example.com");

      const content = screen.getByRole("dialog");
      content.setAttribute("data-state", "closed");
      fireEvent.animationEnd(content);
      dialog.rerender(
        <CreateProxyHostDialog open={false} onOpenChange={vi.fn()} existingHost={existingHost} />
      );
      dialog.rerender(
        <CreateProxyHostDialog open onOpenChange={vi.fn()} existingHost={existingHost} />
      );

      await waitFor(() =>
        expect(screen.getByPlaceholderText("example.com")).toHaveValue("app.example.com")
      );
    });

    it("sends only the entrypoint fields and no raw toggle without the raw scope", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["proxy:view", "proxy:edit:host-1"] } as never,
      });
      const updateProxyHost = vi
        .spyOn(api, "updateProxyHost")
        .mockResolvedValue(existingHost as never);
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} existingHost={existingHost} />);

      expect(screen.queryByText("Raw Config Mode")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(updateProxyHost).toHaveBeenCalledOnce());
      expect(updateProxyHost.mock.calls[0]?.[1]).toEqual({
        type: "proxy",
        nodeId: "node-1",
        domainNames: ["app.example.com"],
      });
    });

    it("shows the raw switch with the raw toggle scope and sends it only when changed", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["proxy:edit:host-1", "proxy:raw:toggle:host-1"] } as never,
      });
      const updateProxyHost = vi
        .spyOn(api, "updateProxyHost")
        .mockResolvedValue(existingHost as never);
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} existingHost={existingHost} />);

      expect(screen.getByText("Raw Config Mode")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(updateProxyHost).toHaveBeenCalledOnce());
      expect(updateProxyHost.mock.calls[0]?.[1]).not.toHaveProperty("rawConfigEnabled");
    });
  });
});
