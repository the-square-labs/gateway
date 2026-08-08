import { fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import { SiemDestinationDialog } from "./SiemDestinationDialog";

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
});
