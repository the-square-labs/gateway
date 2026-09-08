import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { HostingCatalog, HostingResource } from "@/types/hosting";
import { HostingResizeDialog } from "./HostingResizeDialog";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn(async () => true) }));
const vm = {
  id: "vm",
  name: "worker",
  remoteId: "42",
  location: "fsn1",
  sizeId: "old",
  incarnation: "original",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 40,
  nodes: [],
} as unknown as HostingResource;
const catalog = {
  sizes: [
    {
      id: "new",
      name: "CPX22",
      cpu: 4,
      memoryMb: 8192,
      diskGb: 80,
      locations: ["fsn1"],
      price: { amount: "10.990000000", currency: "EUR", estimated: true },
    },
  ],
  images: [],
  locations: [],
} as HostingCatalog;
it("shows a placeholder for an obsolete size and describes the available configuration", async () => {
  render(
    <HostingResizeDialog resource={vm} provider="hetzner" catalog={catalog} onClose={vi.fn()} />
  );
  expect(screen.getByRole("combobox", { name: "Server size" })).toHaveTextContent(
    "Select catalog size"
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Server size" }));
  expect(screen.getByRole("option", { name: /CPX22/ })).toHaveTextContent(
    "4 vCPU · 8 GiB RAM · 80 GB disk · 10.99 EUR"
  );
});
it("blocks disk shrink before sending an action", async () => {
  const request = vi.spyOn(api, "hostingResourceAction");
  render(<HostingResizeDialog resource={vm} provider="proxmox" onClose={vi.fn()} />);
  expect(screen.getByRole("spinbutton", { name: "Disk (GB)" })).toHaveAttribute("min", "40");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Disk (GB)" }), {
    target: { value: "20" },
  });
  expect(screen.getByRole("button", { name: "Resize resource" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Shrinking disks");
  expect(request).not.toHaveBeenCalled();
});
it("submits accepted resize through the same shared dialog", async () => {
  const request = vi
    .spyOn(api, "hostingResourceAction")
    .mockResolvedValue({ phase: "pending" } as never);
  const onClose = vi.fn();
  render(<HostingResizeDialog resource={vm} provider="proxmox" onClose={onClose} />);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Disk (GB)" }), {
    target: { value: "60" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Resize resource" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "vm",
      expect.objectContaining({ action: "resize", diskGb: 60, expectedIncarnation: "original" })
    )
  );
  expect(onClose).toHaveBeenCalledOnce();
});
