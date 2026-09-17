import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { LicenseSection } from "./LicenseSection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUIBootstrapStore.setState({ snapshot: null });
});

describe("paid feature activation in license settings", () => {
  it("lets a license manager retry module activation without entering the key again", async () => {
    const status = {
      status: "valid",
      plan: "personal",
      licensed: true,
      hasKey: true,
      keyLast4: "1234",
      licenseName: "Personal",
      installationName: "Test",
      installationId: "test",
      expiresAt: null,
      lastCheckedAt: null,
    };
    vi.spyOn(api, "getCached").mockReturnValue(status);
    vi.spyOn(api, "getLicenseStatus").mockResolvedValue(status as never);
    vi.spyOn(api, "setCache").mockImplementation(() => {});
    const enable = vi.spyOn(api, "activateLicenseModule").mockResolvedValue({ restarting: true });
    useUIBootstrapStore.setState({ snapshot: { commercialModule: "unavailable" } as never });
    render(
      <MemoryRouter>
        <LicenseSection canManage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Enable paid features" }));
    await waitFor(() => expect(enable).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
  });
});
