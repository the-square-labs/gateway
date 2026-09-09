import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { ComposeProjectEditor } from "./ComposeProjectEditor";

vi.mock("@/components/ui/code-editor", () => ({ CodeEditor: () => <div>YAML editor</div> }));
vi.mock("@/lib/docker-node-access", () => ({
  loadVisibleDockerNodes: () =>
    Promise.resolve([{ id: "n1", hostname: "node", capabilities: { dockerComposeV1: true } }]),
}));
vi.mock("@/stores/license-paywall", () => ({
  requireLicenseFeature: () => true,
  handleLicenseApiError: () => false,
}));
vi.mock("../docker-deploy/useDockerSourceRepositories", () => ({
  useDockerSourceRepositories: () => ({ connectorOptions: [], repositories: [] }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({
    user: makeUser({
      scopes: ["docker:compose:view", "docker:compose:create", "docker:compose:manage"],
    }),
  });
  vi.spyOn(api, "listDockerComposeProjects").mockResolvedValue([
    { id: "p1", nodeId: "n1" },
  ] as never);
  vi.spyOn(api, "getDockerComposeProject").mockResolvedValue({
    id: "p1",
    nodeId: "n1",
    name: "external-app",
    managementState: "external",
  } as never);
  vi.spyOn(api, "validateDockerComposeProject").mockResolvedValue({ valid: true } as never);
  vi.spyOn(api, "adoptDockerComposeProject").mockResolvedValue({ revision: { id: "r1" } } as never);
});

describe("Compose adoption dialog", () => {
  it("closes only after Pull & Apply is accepted", async () => {
    let accept!: (value: never) => void;
    const start = vi.spyOn(api, "startDockerComposeOperation").mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const close = vi.fn();
    render(
      <MemoryRouter>
        <ComposeProjectEditor projectIdOverride="p1" adoptionOverride onClose={close} />
      </MemoryRouter>
    );
    const submit = await screen.findByRole("button", { name: "Adopt & Apply" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        "n1",
        "p1",
        "pull_apply",
        expect.objectContaining({ revisionId: "r1" })
      )
    );
    expect(close).not.toHaveBeenCalled();
    await act(async () => accept({ id: "op1" } as never));
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps the adoption dialog open when starting the operation fails", async () => {
    const start = vi
      .spyOn(api, "startDockerComposeOperation")
      .mockRejectedValue(new Error("offline"));
    const close = vi.fn();
    render(
      <MemoryRouter>
        <ComposeProjectEditor projectIdOverride="p1" adoptionOverride onClose={close} />
      </MemoryRouter>
    );
    const submit = await screen.findByRole("button", { name: "Adopt & Apply" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(submit).toBeEnabled());
  });
});
