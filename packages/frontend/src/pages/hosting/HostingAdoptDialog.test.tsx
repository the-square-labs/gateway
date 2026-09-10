import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { HostingAdoptDialog } from "./HostingAdoptDialog";

const choices = {
  resources: [
    { id: "resource", remoteId: "114", name: "VM test", kind: "vm" as const, location: "pve" },
  ],
  nodes: [
    { id: "node", hostname: "worker", displayName: "Worker", type: "docker", status: "online" },
  ],
};
beforeEach(() => {
  vi.spyOn(api, "getHostingAdoptionCandidates").mockResolvedValue(choices);
  vi.spyOn(api, "adoptHostingNode").mockResolvedValue({
    resourceId: "resource",
    nodeIds: ["node"],
  });
});
async function selectBoth() {
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "VM or container" })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("combobox", { name: "VM or container" }));
  await userEvent.click(screen.getByRole("button", { name: /VM test/ }));
  await userEvent.click(screen.getByRole("combobox", { name: "Gateway node" }));
  await userEvent.click(screen.getByRole("button", { name: /Worker/ }));
}
it("submits only a selected pair, prevents duplicate submission, and acknowledges before refresh", async () => {
  let resolve!: () => void;
  vi.mocked(api.adoptHostingNode).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = () => r({ resourceId: "resource", nodeIds: ["node"] });
      })
  );
  const close = vi.fn(),
    adopted = vi.fn();
  render(<HostingAdoptDialog open connectorId="connector" onClose={close} onAdopted={adopted} />);
  expect(screen.getByRole("button", { name: "Verify and adopt" })).toBeDisabled();
  await selectBoth();
  const button = screen.getByRole("button", { name: "Verify and adopt" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.adoptHostingNode).toHaveBeenCalledExactlyOnceWith("connector", {
    resourceId: "resource",
    nodeId: "node",
  });
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
  expect(adopted).toHaveBeenCalledOnce();
});
it("keeps choices and displays verification rejection without claiming success", async () => {
  vi.mocked(api.adoptHostingNode).mockRejectedValue(new Error("These are different hosts"));
  const close = vi.fn();
  render(<HostingAdoptDialog open connectorId="connector" onClose={close} onAdopted={vi.fn()} />);
  await selectBoth();
  await userEvent.click(screen.getByRole("button", { name: "Verify and adopt" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("These are different hosts");
  expect(screen.getByRole("combobox", { name: "VM or container" })).toHaveValue("VM test · VM 114");
  expect(close).not.toHaveBeenCalled();
});
it("shows empty discovery without allowing submit", async () => {
  vi.mocked(api.getHostingAdoptionCandidates).mockResolvedValue({
    resources: [],
    nodes: choices.nodes,
  });
  render(<HostingAdoptDialog open connectorId="connector" onClose={vi.fn()} onAdopted={vi.fn()} />);
  expect(await screen.findByText(/No unbound resources/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Verify and adopt" })).toBeDisabled();
});
