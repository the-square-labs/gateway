import { render, screen } from "@testing-library/react";
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

    render(<AddDomainDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByText("Folder")).toBeInTheDocument();
    const trigger = screen.getByRole("combobox", { name: "Folder" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading folders...")).toBeInTheDocument();
  });
});
