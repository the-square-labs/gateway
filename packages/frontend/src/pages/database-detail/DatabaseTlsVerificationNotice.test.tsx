import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import { DatabaseTlsVerificationNotice, hasUnverifiedTls } from "./DatabaseTlsVerificationNotice";

const legacy = {
  id: "database-1",
  name: "Orders",
  type: "postgres",
  tlsEnabled: true,
  tlsVerifyCertificate: false,
  tlsCaCertificate: null,
} as unknown as DatabaseConnection;

describe("DatabaseTlsVerificationNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flags only external TLS connections without verification", () => {
    expect(hasUnverifiedTls(legacy)).toBe(true);
    expect(hasUnverifiedTls({ ...legacy, tlsVerifyCertificate: true })).toBe(false);
    expect(hasUnverifiedTls({ ...legacy, tlsEnabled: false })).toBe(false);
    expect(hasUnverifiedTls({ ...legacy, managed: {} } as unknown as DatabaseConnection)).toBe(
      false
    );
  });

  it("tests and enables verification in one click", async () => {
    const user = userEvent.setup();
    const verified = { ...legacy, tlsVerifyCertificate: true };
    const update = vi.spyOn(api, "updateDatabase").mockResolvedValue(verified);
    const onVerified = vi.fn();
    render(
      <DatabaseTlsVerificationNotice
        database={legacy}
        canEdit
        onVerified={onVerified}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText("TLS certificate is not verified")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test and enable verification" }));

    expect(update).toHaveBeenCalledWith("database-1", { config: { tlsVerifyCertificate: true } });
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(verified));
  });

  it("keeps the connection unchanged and shows why when the certificate cannot be verified", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "updateDatabase").mockRejectedValue(
      new Error(
        "The database server TLS certificate could not be verified (self-signed certificate)."
      )
    );
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    const onVerified = vi.fn();
    render(
      <DatabaseTlsVerificationNotice
        database={legacy}
        canEdit
        onVerified={onVerified}
        onOpenSettings={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Test and enable verification" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining("could not be verified"))
    );
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("offers no actions without edit permission", () => {
    render(
      <DatabaseTlsVerificationNotice
        database={legacy}
        canEdit={false}
        onVerified={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText("TLS certificate is not verified")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
