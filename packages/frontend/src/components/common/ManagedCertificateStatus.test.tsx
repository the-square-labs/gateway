import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ManagedCertificateStatus as StatusView } from "@/types";
import {
  certificateAttention,
  describeCertificateRenewal,
  ManagedCertificateDetailRow,
  ManagedCertificateNotice,
  useManagedCertificateStatus,
} from "./ManagedCertificateStatus";

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

describe("certificateAttention", () => {
  it("asks for attention only when the certificate does not renew on its own", () => {
    expect(certificateAttention(status())).toBeNull();
    expect(certificateAttention(status({ state: "delivering" }))).toBeNull();
    expect(certificateAttention(status({ state: "failed" }))).toBe("renewal_failed");
    expect(certificateAttention(status({ state: "ca_limited" }))).toBe("ca_limited");
    expect(certificateAttention(status({ state: "waiting_for_daemon" }))).toBe(
      "waiting_for_daemon"
    );
    expect(certificateAttention(status({ state: "awaiting_reload" }))).toBe("awaiting_reload");
    expect(certificateAttention(status({}, 7))).toBe("expiring");
    expect(certificateAttention(status({}, 8))).toBeNull();
  });
});

describe("ManagedCertificateNotice", () => {
  it("renders nothing while the certificate renews on its own", () => {
    const { container } = render(<ManagedCertificateNotice status={status()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains a failed renewal with the last error and the expiry", () => {
    render(
      <ManagedCertificateNotice
        status={status({ state: "failed", lastError: "engine refused the key" })}
      />
    );
    expect(screen.getByText("TLS certificate renewal failed")).toBeInTheDocument();
    expect(screen.getByText(/engine refused the key/)).toBeInTheDocument();
    expect(screen.getByText(/expires Jan 1, 2027/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renews from a text action, stays pending while the request runs, then reloads", async () => {
    const user = userEvent.setup();
    let finish!: (value: boolean) => void;
    const onRenew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const onRenewed = vi.fn();
    render(
      <ManagedCertificateNotice status={status({}, 3)} onRenew={onRenew} onRenewed={onRenewed} />
    );
    expect(screen.getByText("TLS certificate expires in 3 days")).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Renew now" });
    expect(action).not.toHaveClass("h-8");
    await user.click(action);
    expect(action).toBeDisabled();
    finish(true);
    await waitFor(() => expect(onRenewed).toHaveBeenCalled());
    expect(action).toBeEnabled();
  });
});

describe("ManagedCertificateDetailRow", () => {
  it("shows the expiry as a quiet detail", () => {
    render(<ManagedCertificateDetailRow status={status()} />);
    expect(screen.getByText("TLS Certificate")).toBeInTheDocument();
    expect(screen.getByText(/Expires Jan 1, 2027 · renewed automatically/)).toBeInTheDocument();
  });

  it("renders nothing without a certificate", () => {
    const { container } = render(
      <ManagedCertificateDetailRow status={{ ...status(), certificate: null }} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("useManagedCertificateStatus", () => {
  it("reports loading until the first answer and treats a refusal as no certificate", async () => {
    const load = vi.fn().mockRejectedValue(new Error("TLS off"));
    const { result } = renderHook(() => useManagedCertificateStatus(load, { enabled: true }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
  });

  it("does not load for a resource without TLS", () => {
    const load = vi.fn();
    const { result } = renderHook(() => useManagedCertificateStatus(load, { enabled: false }));
    expect(result.current.loading).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
