import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
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
    vi.spyOn(api, "listCertificates").mockResolvedValue({ data: [] } as any);
    vi.spyOn(api, "searchDomains").mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => useConfirmDialog.getState().close());
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
    await user.click(screen.getByPlaceholderText("example.com"));
    await user.click(await screen.findByRole("button", { name: /app\.example\.com/i }));

    const challengeSelect = screen.getByRole("combobox", { name: "Challenge Type" });
    expect(challengeSelect).toHaveTextContent("Manual DNS validation");

    await user.click(screen.getByRole("button", { name: "Request Certificate" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
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
      title: "Cancel certificate request?",
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
