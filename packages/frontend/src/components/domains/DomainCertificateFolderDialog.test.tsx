import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { DomainCertificateFolderDialog } from "./DomainCertificateFolderDialog";

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
});

const folders = [
  { id: "folder-granted", name: "Team A", parentId: null, sortOrder: 0, depth: 0, children: [] },
  { id: "folder-other", name: "Team B", parentId: null, sortOrder: 1, depth: 0, children: [] },
];

describe("DomainCertificateFolderDialog", () => {
  beforeEach(() => {
    vi.spyOn(useResourceFolderStore.getState(), "fetchFolders").mockResolvedValue(undefined);
    useResourceFolderStore.setState((state) => ({
      foldersByType: { ...state.foldersByType, "ssl-certificate": folders as never },
      loadingByType: { ...state.loadingByType, "ssl-certificate": false },
    }));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    useResourceFolderStore.setState((state) => ({
      foldersByType: { ...state.foldersByType, "ssl-certificate": [] },
    }));
    vi.restoreAllMocks();
  });

  it("issues into the only SSL certificate folder a folder-only creator may use", async () => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["ssl:cert:issue:folder/folder-granted"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    const onIssue = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <DomainCertificateFolderDialog
        open
        onOpenChange={vi.fn()}
        domainName="app.example.com"
        onIssue={onIssue}
      />
    );

    const trigger = screen.getByRole("combobox", { name: "Certificate folder" });
    await waitFor(() => expect(trigger).toHaveTextContent("Team A"));
    await user.click(trigger);
    expect(screen.queryByRole("option", { name: "No folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Team B/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Issue" }));

    await waitFor(() => expect(onIssue).toHaveBeenCalledWith("folder-granted"));
  });

  it("keeps issuing disabled without any SSL certificate creation grant", () => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["ssl:cert:issue:cert-1"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <DomainCertificateFolderDialog
        open
        onOpenChange={vi.fn()}
        domainName="app.example.com"
        onIssue={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Issue" })).toBeDisabled();
  });
});
