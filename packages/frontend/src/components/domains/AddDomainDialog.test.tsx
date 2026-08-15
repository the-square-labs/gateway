import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
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
        <AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
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
        <AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
      </MemoryRouter>
    );

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No Nginx node has a public address")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /node/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Domain" })).toBeDisabled();
  });
});
