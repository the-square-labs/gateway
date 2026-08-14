import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSshConnectorDialog } from "./ExternalSshConnectorDialog";

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
});

const mocks = vi.hoisted(() => ({
  listExternalSshConnectors: vi.fn(),
  discoverExternalSshHostKey: vi.fn(),
  createExternalSshConnector: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: {
    listExternalSshConnectors: mocks.listExternalSshConnectors,
    discoverExternalSshHostKey: mocks.discoverExternalSshHostKey,
    createExternalSshConnector: mocks.createExternalSshConnector,
  },
}));

describe("ExternalSshConnectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExternalSshConnectors.mockResolvedValue([]);
    mocks.discoverExternalSshHostKey.mockResolvedValue({
      host: "api.example.com",
      port: 22,
      hostFingerprint: "SHA256:known-host-key",
    });
  });

  it("collects the target before showing authentication", async () => {
    const user = userEvent.setup();
    render(<ExternalSshConnectorDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);

    expect(
      screen.getByText("Define the target server and how Gateway should reach it.")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("SSH credential type")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Production server"), "Production API");
    await user.type(screen.getByPlaceholderText("server.example.com"), "api.example.com");
    expect(screen.queryByPlaceholderText("SHA256:…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Choose the credential for the target server.")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH credential type")).toBeInTheDocument();
    await user.type(screen.getByLabelText("SSH password"), "secret");
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("Review & host identity")).toBeInTheDocument();
    expect(mocks.createExternalSshConnector).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check host key" }));
    expect(await screen.findByText("SHA256:known-host-key")).toBeInTheDocument();
    expect(screen.queryByText("SHA256", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Host key trusted")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create connector" })).toBeEnabled();
    expect(screen.queryByText("Import private key")).not.toBeInTheDocument();
  });

  it("adds jump-server steps inside the same dialog", async () => {
    const user = userEvent.setup();
    render(<ExternalSshConnectorDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Production server"), "Production API");
    await user.type(screen.getByPlaceholderText("server.example.com"), "api.example.com");
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Add jump server…" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Define the jump server without creating it yet.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Bastion server")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("bastion.example.com")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Bastion server"), "Jump");
    await user.type(screen.getByPlaceholderText("bastion.example.com"), "jump.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Jump SSH password"), "jump-secret");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Choose the credential for the target server.")).toBeInTheDocument();
    expect(mocks.createExternalSshConnector).not.toHaveBeenCalled();
  });

  it("offers the generated jump key for target authentication without saving on Continue", async () => {
    const user = userEvent.setup();
    render(<ExternalSshConnectorDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Production server"), "Production API");
    await user.type(screen.getByPlaceholderText("server.example.com"), "api.example.com");
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Add jump server…" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByPlaceholderText("Bastion server"), "Jump");
    await user.type(screen.getByPlaceholderText("bastion.example.com"), "jump.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.click(screen.getByLabelText("Jump credential type"));
    await user.click(screen.getByRole("option", { name: "Generate new key" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByLabelText("SSH credential type"));
    await user.click(screen.getByRole("option", { name: "Reuse jump server key" }));

    expect(screen.getByText("Shared generated key")).toBeInTheDocument();
    expect(mocks.createExternalSshConnector).not.toHaveBeenCalled();
  });

  it("aborts a pending host-key check when the dialog closes", async () => {
    const user = userEvent.setup();
    let requestSignal: AbortSignal | undefined;
    mocks.discoverExternalSshHostKey.mockImplementation((_input: unknown, signal?: AbortSignal) => {
      requestSignal = signal;
      return new Promise(() => undefined);
    });
    const onOpenChange = vi.fn();
    render(<ExternalSshConnectorDialog open onOpenChange={onOpenChange} onCreated={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Production server"), "Production API");
    await user.type(screen.getByPlaceholderText("server.example.com"), "api.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("SSH password"), "secret");
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Check host key" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(requestSignal?.aborted).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
