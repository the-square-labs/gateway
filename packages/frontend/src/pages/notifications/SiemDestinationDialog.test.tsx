import { fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { SiemDestination } from "@/types";
import { SiemDestinationDialog } from "./SiemDestinationDialog";

const EXISTING: SiemDestination = {
  id: "siem-1",
  name: "Security Operations",
  url: "https://siem.example.test/gateway/audit",
  authType: "bearer",
  customHeaderName: null,
  secretConfigured: true,
  enabled: true,
  pendingDeliveries: 0,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("SiemDestinationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("collects a custom header name and value as a separate authentication mode", async () => {
    const createSiemDestination = vi.spyOn(api, "createSiemDestination").mockResolvedValue({
      id: "siem-1",
    } as never);

    renderWithRouter(
      <SiemDestinationDialog open onOpenChange={vi.fn()} destination={null} onSaved={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Security Operations" } });
    fireEvent.change(screen.getByLabelText("HTTPS endpoint"), {
      target: { value: "https://siem.example.test/gateway/audit" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Authentication method" }));
    fireEvent.click(await screen.findByRole("option", { name: "Custom header" }));

    fireEvent.change(await screen.findByLabelText("Custom header"), {
      target: { value: "X-API-Key" },
    });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "collector-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Destination" }));

    await waitFor(() => {
      expect(createSiemDestination).toHaveBeenCalledWith({
        name: "Security Operations",
        url: "https://siem.example.test/gateway/audit",
        authType: "custom_header",
        customHeaderName: "X-API-Key",
        secret: "collector-key",
        enabled: true,
      });
    });
  });

  it("keeps space between the animated authentication fields and delivery control", () => {
    renderWithRouter(
      <SiemDestinationDialog open onOpenChange={vi.fn()} destination={null} onSaved={vi.fn()} />
    );

    const deliveryRow = screen.getByText("Delivery enabled").closest(".flex");
    if (!deliveryRow?.parentElement) throw new Error("Delivery control container is missing");

    expect(deliveryRow.parentElement).toHaveClass("pt-4");
  });
  it("requires the secret again when an edit changes the endpoint URL", async () => {
    const updateSiemDestination = vi
      .spyOn(api, "updateSiemDestination")
      .mockResolvedValue(EXISTING as never);

    renderWithRouter(
      <SiemDestinationDialog open onOpenChange={vi.fn()} destination={EXISTING} onSaved={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("HTTPS endpoint"), {
      target: { value: "https://collector.example.test/audit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(
      await screen.findByText("Re-enter the secret when changing the destination URL")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Bearer token")).toHaveAttribute("aria-invalid", "true");
    expect(updateSiemDestination).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "new-token" } });
    expect(
      screen.queryByText("Re-enter the secret when changing the destination URL")
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(updateSiemDestination).toHaveBeenCalledWith("siem-1", {
        name: "Security Operations",
        url: "https://collector.example.test/audit",
        authType: "bearer",
        enabled: true,
        secret: "new-token",
      })
    );
  });

  it("keeps the stored secret when an edit leaves the endpoint URL unchanged", async () => {
    const updateSiemDestination = vi
      .spyOn(api, "updateSiemDestination")
      .mockResolvedValue(EXISTING as never);

    renderWithRouter(
      <SiemDestinationDialog open onOpenChange={vi.fn()} destination={EXISTING} onSaved={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "SOC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(updateSiemDestination).toHaveBeenCalledWith("siem-1", {
        name: "SOC",
        url: "https://siem.example.test/gateway/audit",
        authType: "bearer",
        enabled: true,
      })
    );
  });
});
