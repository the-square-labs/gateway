import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { waitForReveal } from "@/test/reveal";
import type { DockerContainer, NginxTemplate } from "@/types";
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
    vi.spyOn(api, "listFolders").mockResolvedValue([]);
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

  it("opens at full size only after every option list has loaded", async () => {
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
    let resolveTemplates!: (templates: NginxTemplate[]) => void;
    vi.spyOn(api, "listNginxTemplates").mockReturnValue(
      new Promise((resolve) => {
        resolveTemplates = resolve;
      })
    );
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);

    const dialog = render(<CreateProxyHostDialog open={false} onOpenChange={vi.fn()} />);
    dialog.rerender(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);
    const panel = () => document.querySelector("[data-reveal-phase]");

    await waitFor(() => expect(api.listFolders).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(panel()).not.toHaveAttribute("data-reveal-phase", "revealed");

    await act(async () => resolveTemplates([]));
    await waitForReveal();
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled();
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

  describe("automatic ingress node", () => {
    const twoNodes = {
      data: ["node-1", "node-2"].map((id, index) => ({
        id,
        hostname: `edge-${index + 1}`,
        displayName: `Edge ${index + 1}`,
        type: "nginx",
        status: "online",
        serviceCreationLocked: false,
        capabilities: {},
      })),
    };

    beforeEach(() => {
      api.invalidateCache("nodes:list:default");
      vi.spyOn(api, "listNodes").mockResolvedValue(twoNodes as never);
      vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
      vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
      vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
      // Domains the caller cannot list: the dialog cannot fill the node itself.
      vi.spyOn(api, "searchDomains").mockResolvedValue([]);
    });

    it("creates without a node so the server uses the registered domain's ingress node", async () => {
      const createProxyHost = vi
        .spyOn(api, "createProxyHost")
        .mockResolvedValue({ id: "route-1" } as never);
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
      );
      await user.type(screen.getByPlaceholderText("example.com"), "app.example.com");
      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
      await user.click(screen.getByRole("combobox", { name: "Ingress node" }));
      await user.click(screen.getByRole("option", { name: /Automatic/i }));
      expect(screen.getByRole("combobox", { name: "Ingress node" })).toHaveTextContent(
        "Automatic (from the registered domain)"
      );
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.type(await screen.findByPlaceholderText("192.168.1.100"), "10.0.0.2");
      await user.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => expect(createProxyHost).toHaveBeenCalledOnce());
      const request = createProxyHost.mock.calls[0]?.[0];
      expect(request).toEqual(expect.objectContaining({ domainNames: ["app.example.com"] }));
      expect(request?.nodeId).toBeUndefined();
    });

    it("does not offer the automatic node to a node-limited creator", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["proxy:create:node/node-2"] } as never,
      });
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
      );
      await user.click(screen.getByRole("combobox", { name: "Ingress node" }));
      expect(screen.queryByRole("option", { name: /Automatic/i })).not.toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Edge 2/i })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Edge 1/i })).not.toBeInTheDocument();
    });
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

  describe("folder destination", () => {
    const edgeNode = {
      id: "node-1",
      hostname: "edge-one",
      displayName: "Edge One",
      type: "nginx",
      status: "online",
      serviceCreationLocked: false,
      capabilities: {},
    };
    const folderTree = [
      {
        id: "folder-granted",
        name: "Team A",
        parentId: null,
        sortOrder: 0,
        depth: 0,
        hosts: [],
        children: [],
      },
      {
        id: "folder-other",
        name: "Team B",
        parentId: null,
        sortOrder: 1,
        depth: 0,
        hosts: [],
        children: [],
      },
    ];

    beforeEach(() => {
      api.invalidateCache("nodes:list:default");
      vi.spyOn(api, "listNodes").mockResolvedValue({ data: [edgeNode] } as never);
      vi.spyOn(api, "listSSLCertificates").mockResolvedValue({ data: [] } as never);
      vi.spyOn(api, "listNginxTemplates").mockResolvedValue([]);
      vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
      vi.spyOn(api, "searchDomains").mockResolvedValue([]);
      vi.spyOn(api, "listFolders").mockResolvedValue(folderTree as never);
    });

    it("offers only the granted folder, hides the root and preselects it for a folder-only creator", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["proxy:create:folder/folder-granted"] } as never,
      });
      const createProxyHost = vi
        .spyOn(api, "createProxyHost")
        .mockResolvedValue({ id: "route-1" } as never);
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

      const folderTrigger = await screen.findByRole("combobox", { name: "Folder" });
      await waitFor(() => expect(folderTrigger).toHaveTextContent("Team A"));
      await user.click(folderTrigger);
      expect(screen.queryByRole("option", { name: "No folder" })).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Team B/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("option", { name: /Team A/ }));

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
      );
      await user.click(screen.getByRole("combobox", { name: "Ingress node" }));
      await user.click(screen.getByRole("option", { name: /Edge One/i }));
      await user.type(screen.getByPlaceholderText("example.com"), "app.example.com");
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.type(await screen.findByPlaceholderText("192.168.1.100"), "10.0.0.2");
      await user.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => expect(createProxyHost).toHaveBeenCalledOnce());
      expect(createProxyHost.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ folderId: "folder-granted", nodeId: "node-1" })
      );
    });

    it("keeps the root selected and hides the picker without folders for a broad creator", async () => {
      vi.spyOn(api, "listFolders").mockResolvedValue([]);
      useAuthStore.setState({ user: { id: "user-1", scopes: ["proxy:create"] } as never });

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
      );
      expect(screen.queryByRole("combobox", { name: "Folder" })).not.toBeInTheDocument();
    });

    it("requires a folder choice when several folders are allowed and the root is not", async () => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          scopes: ["proxy:create:folder/folder-granted", "proxy:create:folder/folder-other"],
        } as never,
      });
      const user = userEvent.setup();

      render(<CreateProxyHostDialog open onOpenChange={vi.fn()} />);

      const folderTrigger = await screen.findByRole("combobox", { name: "Folder" });
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Ingress node" })).not.toBeDisabled()
      );
      await user.click(screen.getByRole("combobox", { name: "Ingress node" }));
      await user.click(screen.getByRole("option", { name: /Edge One/i }));
      await user.type(screen.getByPlaceholderText("example.com"), "app.example.com");
      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();

      await user.click(folderTrigger);
      await user.click(screen.getByRole("option", { name: /Team B/ }));
      expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
    });
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

    it("shows the raw switch with the raw write scope and sends it only when changed", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["proxy:edit:host-1", "proxy:raw:write:host-1"] } as never,
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
