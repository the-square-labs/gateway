import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { waitForReveal } from "@/test/reveal";
import { SSLCertificateCreateDialog } from "./SSLCertificateCreateDialog";

function renderDialog(props: Partial<ComponentProps<typeof SSLCertificateCreateDialog>> = {}) {
  return render(
    <MemoryRouter>
      <SSLCertificateCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        cloudflareConfigured
        onCloudflareRequired={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  );
}

describe("SSLCertificateCreateDialog domain selection", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["ssl:cert:issue"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "listCertificates").mockResolvedValue({ data: [] } as any);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => useConfirmDialog.getState().close());
    useAuthStore.setState({ user: null, isAuthenticated: false });
    vi.restoreAllMocks();
  });

  it("uses automatic Cloudflare DNS-01 for registered managed domains", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
    ]);
    const request = vi.spyOn(api, "requestACMECert").mockResolvedValue({
      certificate: { id: "cert-1" },
      status: "active",
    } as any);
    const user = userEvent.setup();

    renderDialog();
    await waitForReveal();
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));
    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    expect(challengeSelect).toHaveTextContent("Automatic DNS via Cloudflare");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request Certificate" })).toBeEnabled()
    );
    expect(
      screen.getByText(
        "Gateway will create and clean up the Cloudflare validation records automatically."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        folderId: null,
        domains: ["app.example.com"],
        challengeType: "dns-01",
        provider: "letsencrypt",
        dnsProvider: "cloudflare",
        autoRenew: true,
      })
    );
  });

  it("requests Cloudflare setup instead of submitting DNS-01 when it is not configured", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
    ]);
    const request = vi.spyOn(api, "requestACMECert");
    const onCloudflareRequired = vi.fn();
    const user = userEvent.setup();

    renderDialog({ cloudflareConfigured: false, onCloudflareRequired });
    await waitForReveal();
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));
    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    fireEvent.keyDown(challengeSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByText("Automatic DNS via Cloudflare"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request Certificate" })).toBeEnabled()
    );
    expect(screen.getByText("Automatic DNS via Cloudflare")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    expect(onCloudflareRequired).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("opens Cloudflare setup when the backend reports no matching synced zone", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
    ]);
    vi.spyOn(api, "requestACMECert").mockRejectedValue(
      new ApiRequestError("No enabled Cloudflare connector has a synced zone for this domain", {
        status: 409,
        code: "CLOUDFLARE_ZONE_NOT_FOUND",
      })
    );
    const onCloudflareRequired = vi.fn();
    const user = userEvent.setup();

    renderDialog({ cloudflareConfigured: true, onCloudflareRequired });
    await waitForReveal();
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));
    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    expect(challengeSelect).toHaveTextContent("Automatic DNS via Cloudflare");
    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    await waitFor(() => expect(onCloudflareRequired).toHaveBeenCalledOnce());
  });

  it("keeps the selected challenge type when a domain is selected", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "cloudflare",
        nginxNodeId: "node-1",
      },
    ]);
    const user = userEvent.setup();

    renderDialog();
    await waitForReveal();
    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    expect(challengeSelect).toHaveTextContent("Automatic DNS via Cloudflare");

    fireEvent.keyDown(challengeSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByText("Manual DNS validation"));

    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));

    expect(challengeSelect).toHaveTextContent("Manual DNS validation");
  });

  it("keeps manual DNS-01 available without a Cloudflare integration", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "legacy",
        nginxNodeId: "node-1",
      },
    ]);
    const request = vi.spyOn(api, "requestACMECert").mockResolvedValue({
      certificate: { id: "cert-1" },
      status: "active",
    } as any);
    const onCloudflareRequired = vi.fn();
    const user = userEvent.setup();

    renderDialog({ cloudflareConfigured: false, onCloudflareRequired });
    await waitForReveal();
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));

    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    expect(challengeSelect).toHaveTextContent("Manual DNS validation");

    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        folderId: null,
        domains: ["app.example.com"],
        challengeType: "dns-01",
        provider: "letsencrypt",
        autoRenew: false,
      })
    );
    expect(onCloudflareRequired).not.toHaveBeenCalled();
  });

  it("locks a pending manual DNS request and cancels it only after confirmation", async () => {
    vi.mocked(api.searchDomains).mockResolvedValue([
      {
        id: "domain-1",
        domain: "app.example.com",
        dnsStatus: "valid",
        dnsProvider: "legacy",
        nginxNodeId: "node-1",
      },
    ]);
    vi.spyOn(api, "requestACMECert").mockResolvedValue({
      certificate: { id: "cert-pending" },
      status: "pending_dns_verification",
      challenges: [
        {
          domain: "app.example.com",
          recordName: "_acme-challenge.app.example.com",
          recordValue: "challenge-value",
        },
      ],
    } as any);
    const cancelRequest = vi.spyOn(api, "cancelPendingACMECert").mockResolvedValue();
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();

    renderDialog({ onOpenChange, onCreated });
    await waitForReveal();
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));
    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useConfirmDialog.getState()).toMatchObject({
      open: true,
      title: "Cancel Certificate Request?",
    });

    await act(async () => {
      await useConfirmDialog.getState().onConfirm?.();
    });

    await waitFor(() => expect(cancelRequest).toHaveBeenCalledWith("cert-pending"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("does not submit a freely typed, unregistered domain", async () => {
    const request = vi.spyOn(api, "requestACMECert");
    const user = userEvent.setup();

    renderDialog();
    await waitForReveal();
    await user.type(screen.getByPlaceholderText("example.com"), "unregistered.example.com");
    expect(screen.getByRole("button", { name: "Request Certificate" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    expect(request).not.toHaveBeenCalled();
  });

  it("shows only manual upload without tabs when domains and PKI are unavailable", () => {
    renderDialog({ hasDomains: false, pkiEnabled: false, initialTab: "upload" });

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Let's Encrypt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Internal CA" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload Certificate" })).toBeDisabled();
    expect(api.listCertificates).not.toHaveBeenCalled();
  });

  it("enables manual upload only after all required fields are filled", async () => {
    const user = userEvent.setup();
    renderDialog({ hasDomains: false, pkiEnabled: false, initialTab: "upload" });
    await waitForReveal();
    const uploadButton = screen.getByRole("button", { name: "Upload Certificate" });

    await user.type(screen.getByPlaceholderText("My Certificate"), "My Certificate");
    await user.type(screen.getAllByPlaceholderText(/BEGIN CERTIFICATE/)[0], "certificate");
    expect(uploadButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/BEGIN PRIVATE KEY/), "private key");
    expect(uploadButton).toBeEnabled();
  });

  it("hides Internal CA when PKI is disabled", () => {
    renderDialog({ hasDomains: true, pkiEnabled: false });

    expect(screen.getByRole("tab", { name: "Let's Encrypt" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Upload" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Internal CA" })).not.toBeInTheDocument();
  });

  it("hides Let's Encrypt when no domains are registered", () => {
    renderDialog({ hasDomains: false, pkiEnabled: true, initialTab: "upload" });

    expect(screen.queryByRole("tab", { name: "Let's Encrypt" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Upload" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Internal CA" })).toBeInTheDocument();
  });
});

describe("SSLCertificateCreateDialog internal PKI linking", () => {
  function setScopes(scopes: string[]) {
    useAuthStore.setState({
      user: { id: "user-1", scopes } as never,
      isAuthenticated: true,
      isLoading: false,
    });
  }

  beforeEach(() => {
    vi.spyOn(api, "listCertificates").mockResolvedValue({
      data: [
        { id: "pki-1", commonName: "api.internal" },
        { id: "pki-2", commonName: "db.internal" },
      ],
    } as any);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    vi.restoreAllMocks();
  });

  it("disables linking without any PKI key export permission", async () => {
    setScopes(["ssl:cert:issue", "pki:cert:view"]);
    renderDialog({ hasDomains: false, initialTab: "internal" });
    await waitForReveal();

    expect(
      await screen.findByText(/Linking requires the PKI certificate export permission/)
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "PKI certificate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Link Certificate" })).toBeDisabled();
  });

  it("only offers certificates whose private key the user may export", async () => {
    setScopes(["ssl:cert:issue", "pki:cert:export:pki-2"]);
    const link = vi.spyOn(api, "linkInternalCert").mockResolvedValue({ id: "ssl-1" } as any);
    renderDialog({ hasDomains: false, initialTab: "internal" });
    await waitForReveal();

    await waitFor(() => expect(api.listCertificates).toHaveBeenCalled());
    expect(
      screen.queryByText(/Linking requires the PKI certificate export permission/)
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "PKI certificate" }));
    expect(
      await screen.findByRole("option", { name: "api.internal (no export permission)" })
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("option", { name: "db.internal" }));
    fireEvent.click(screen.getByRole("button", { name: "Link Certificate" }));

    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        internalCertId: "pki-2",
        name: undefined,
        folderId: null,
      })
    );
  });
});

describe("SSLCertificateCreateDialog folder destination", () => {
  const folders = [
    { id: "folder-granted", name: "Team A", parentId: null, sortOrder: 0, depth: 0, children: [] },
    { id: "folder-other", name: "Team B", parentId: null, sortOrder: 1, depth: 0, children: [] },
  ];

  beforeEach(() => {
    vi.spyOn(api, "listCertificates").mockResolvedValue({ data: [] } as any);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);
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

  it("preselects the only granted folder and hides the root for a folder-only creator", async () => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["ssl:cert:issue:folder/folder-granted"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    const upload = vi.spyOn(api, "uploadCert").mockResolvedValue({ id: "ssl-1" } as any);
    const user = userEvent.setup();

    renderDialog({ hasDomains: false, pkiEnabled: false, initialTab: "upload" });
    await waitForReveal();

    const folderTrigger = screen.getByRole("combobox", { name: "Folder" });
    await waitFor(() => expect(folderTrigger).toHaveTextContent("Team A"));
    await user.click(folderTrigger);
    expect(screen.queryByRole("option", { name: "No folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Team B/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(screen.getByPlaceholderText("My Certificate"), "My Certificate");
    await user.type(screen.getAllByPlaceholderText(/BEGIN CERTIFICATE/)[0]!, "certificate");
    await user.type(screen.getByPlaceholderText(/BEGIN PRIVATE KEY/), "private key");
    await user.click(screen.getByRole("button", { name: /Upload Certificate/ }));

    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(upload.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ folderId: "folder-granted" })
    );
  });

  it("keeps creation disabled until an allowed folder is chosen", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        scopes: ["ssl:cert:issue:folder/folder-granted", "ssl:cert:issue:folder/folder-other"],
      } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    const user = userEvent.setup();

    renderDialog({ hasDomains: false, pkiEnabled: false, initialTab: "upload" });
    await waitForReveal();
    await user.type(screen.getByPlaceholderText("My Certificate"), "My Certificate");
    await user.type(screen.getAllByPlaceholderText(/BEGIN CERTIFICATE/)[0]!, "certificate");
    await user.type(screen.getByPlaceholderText(/BEGIN PRIVATE KEY/), "private key");
    expect(screen.getByRole("button", { name: /Upload Certificate/ })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: /Team B/ }));
    expect(screen.getByRole("button", { name: /Upload Certificate/ })).toBeEnabled();
  });
});
