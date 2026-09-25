import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { AddDomainDialog } from "./AddDomainDialog";

describe("AddDomainDialog", () => {
  it("renders a stable disabled folder row while folders load", () => {
    useResourceFolderStore.setState((state) => ({
      foldersByType: { ...state.foldersByType, domain: [] },
      loadingByType: { ...state.loadingByType, domain: true },
    }));
    vi.spyOn(api, "listDomainFolders").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "listDomainNginxNodes").mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} dnsProvider="cloudflare" />
      </MemoryRouter>
    );

    expect(screen.getByText("Folder")).toBeInTheDocument();
    const trigger = screen.getByRole("combobox", { name: "Folder" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading folders...")).toBeInTheDocument();
  });

  it("does not render node availability notices inside the form", async () => {
    useResourceFolderStore.setState((state) => ({
      foldersByType: { ...state.foldersByType, domain: [] },
      loadingByType: { ...state.loadingByType, domain: false },
    }));
    vi.spyOn(api, "listDomainFolders").mockResolvedValue([]);
    vi.spyOn(api, "listDomainNginxNodes").mockResolvedValue({
      eligibleNodes: [],
      unconfiguredNodes: [
        {
          id: "node-1",
          slug: "private-edge",
          hostname: "private-edge",
          displayName: null,
          appearanceColor: null,
        },
      ],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 1,
    });

    render(
      <MemoryRouter>
        <AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} dnsProvider="cloudflare" />
      </MemoryRouter>
    );

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No Nginx node has a public address")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /node/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Domain" })).toBeDisabled();
  });

  it("renders the node selector when exactly one Nginx node is eligible", async () => {
    useResourceFolderStore.setState((state) => ({
      foldersByType: { ...state.foldersByType, domain: [] },
      loadingByType: { ...state.loadingByType, domain: false },
    }));
    vi.spyOn(api, "listDomainFolders").mockResolvedValue([]);
    vi.spyOn(api, "listDomainNginxNodes").mockResolvedValue({
      eligibleNodes: [
        {
          id: "node-1",
          slug: "local-nginx",
          hostname: "local-nginx",
          displayName: "Local Nginx",
          appearanceColor: null,
          effectiveAddress: "217.19.208.197",
        },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 0,
    });

    render(
      <MemoryRouter>
        <AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} dnsProvider="cloudflare" />
      </MemoryRouter>
    );

    const trigger = await screen.findByRole("combobox", { name: "Ingress node" });
    expect(trigger).toHaveTextContent("Local Nginx");
    expect(trigger).not.toHaveTextContent("217.19.208.197");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await screen.findByText("Local Nginx · 217.19.208.197")).toBeInTheDocument();
  });

  it("offers only the granted folders and preselects the only one for a folder-only creator", async () => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["domains:create:folder/folder-granted"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useResourceFolderStore.setState((state) => ({
      foldersByType: {
        ...state.foldersByType,
        domain: [
          {
            id: "folder-granted",
            name: "Team A",
            parentId: null,
            sortOrder: 0,
            depth: 0,
            children: [],
          },
          {
            id: "folder-other",
            name: "Team B",
            parentId: null,
            sortOrder: 1,
            depth: 0,
            children: [],
          },
        ] as never,
      },
      loadingByType: { ...state.loadingByType, domain: false },
    }));
    vi.spyOn(useResourceFolderStore.getState(), "fetchFolders").mockResolvedValue(undefined);
    vi.spyOn(api, "listDomainNginxNodes").mockResolvedValue({
      eligibleNodes: [
        {
          id: "node-1",
          slug: "local-nginx",
          hostname: "local-nginx",
          displayName: "Local Nginx",
          appearanceColor: null,
          effectiveAddress: "217.19.208.197",
        },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 0,
    });

    try {
      render(
        <MemoryRouter>
          <AddDomainDialog
            open
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
            dnsProvider="cloudflare"
          />
        </MemoryRouter>
      );

      const folderTrigger = screen.getByRole("combobox", { name: "Folder" });
      await waitFor(() => expect(folderTrigger).toHaveTextContent("Team A"));
      fireEvent.keyDown(folderTrigger, { key: "ArrowDown" });
      expect(await screen.findByRole("option", { name: /Team A/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "No folder" })).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Team B/ })).not.toBeInTheDocument();
    } finally {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      useResourceFolderStore.setState((state) => ({
        foldersByType: { ...state.foldersByType, domain: [] },
      }));
      vi.restoreAllMocks();
    }
  });
});
