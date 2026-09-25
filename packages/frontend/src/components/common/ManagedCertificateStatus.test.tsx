import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ManagedCertificateStatus as StatusView } from "@/types";
import { describeCertificateRenewal, ManagedCertificateStatus } from "./ManagedCertificateStatus";

function status(renewal: Partial<StatusView["renewal"]> = {}, daysRemaining = 120): StatusView {
  return {
    ownerType: "managed_storage",
    ownerId: "cluster-1",
    certificate: {
      id: "cert-1",
      serialNumber: "01",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
      daysRemaining,
      sans: ["10.0.0.5", "localhost", "127.0.0.1"],
    },
    renewal: {
      state: "idle",
      reason: null,
      due: false,
      dueReason: null,
      urgent: false,
      hotReloadSupported: true,
      skipReason: null,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      deliveredAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastMethod: null,
      lastRestarted: false,
      pendingSerial: null,
      ...renewal,
    },
  };
}

describe("describeCertificateRenewal", () => {
  it("explains failures with the last error and the next attempt", () => {
    const note = describeCertificateRenewal(
      status({
        state: "failed",
        attempts: 3,
        lastError: "node daemon unavailable",
        nextAttemptAt: "2026-10-01T10:00:00.000Z",
      })
    );
    expect(note?.tone).toBe("warning");
    expect(note?.text).toContain("Automatic renewal failed (3 attempts): node daemon unavailable.");
    expect(note?.text).toContain("Next attempt");
  });

  it("explains a delivered certificate waiting for the engine and a daemon too old to reload", () => {
    expect(describeCertificateRenewal(status({ state: "awaiting_reload" }))?.tone).toBe("info");
    expect(describeCertificateRenewal(status({ state: "waiting_for_daemon" }))?.text).toMatch(
      /node daemon/
    );
    expect(describeCertificateRenewal(status())).toBeNull();
    expect(
      describeCertificateRenewal(
        status({ state: "ca_limited", lastError: "The issuing CA expires soon" })
      )
    ).toEqual({ tone: "warning", text: "The issuing CA expires soon" });
    expect(
      describeCertificateRenewal(status({ due: true, skipReason: "node_offline" }))?.text
    ).toMatch(/node offline/);
  });
});

describe("ManagedCertificateStatus", () => {
  it("shows the expiry and the last renewal error", async () => {
    render(
      <ManagedCertificateStatus
        load={vi
          .fn()
          .mockResolvedValue(status({ state: "failed", lastError: "engine refused the key" }))}
      />
    );
    expect(await screen.findByText(/TLS certificate expires/)).toBeInTheDocument();
    expect(screen.getByText(/120 days/)).toBeInTheDocument();
    expect(screen.getByText(/engine refused the key/)).toBeInTheDocument();
  });

  it("renders nothing when the resource has no TLS certificate", async () => {
    const load = vi.fn().mockRejectedValue(new Error("TLS off"));
    const { container } = render(<ManagedCertificateStatus load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renews on request and reloads the status", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ lastSuccessAt: "2026-09-25T12:00:00.000Z" }, 365));
    const onRenew = vi.fn().mockResolvedValue(true);
    render(<ManagedCertificateStatus load={load} onRenew={onRenew} />);
    await user.click(await screen.findByRole("button", { name: /Renew now/ }));
    expect(onRenew).toHaveBeenCalled();
    expect(await screen.findByText(/365 days/)).toBeInTheDocument();
    expect(screen.getByText(/Renewed automatically .* without a restart/)).toBeInTheDocument();
  });
});
