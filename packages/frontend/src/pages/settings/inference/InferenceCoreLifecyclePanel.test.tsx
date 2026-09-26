import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { api } from "@/services/api";
import type { InferenceCoreStatus } from "@/types/inference-core";
import {
  InferenceCoreLifecyclePanel,
  InferenceCoreSetupFooterAction,
} from "./InferenceCoreLifecyclePanel";

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeStatus(overrides: Partial<InferenceCoreStatus> = {}): InferenceCoreStatus {
  return {
    state: "not_installed",
    installed: null,
    latest: null,
    compatibility: "unknown",
    health: {
      status: "unknown",
      version: null,
      coreProtocolMajor: null,
      stateSchemaVersion: null,
      checkedAt: null,
    },
    operation: null,
    lastError: null,
    ...overrides,
  };
}

const readyStatus = makeStatus({
  state: "ready",
  installed: { version: "2.26.0-wiolett.1", digest: DIGEST, imageRef: "core@sha256:..." },
  compatibility: "compatible",
  health: {
    status: "healthy",
    version: "2.26.0-wiolett.1",
    coreProtocolMajor: 1,
    stateSchemaVersion: 1,
    checkedAt: "2026-08-19T08:00:00.000Z",
  },
});

const runningOperation = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  kind: "install" as const,
  phase: "pulling" as const,
  status: "running" as const,
  progress: {
    stage: "Downloading image",
    downloadedBytes: 123456789,
    totalBytes: 412345678,
    layersCompleted: 3,
    layersTotal: 9,
  },
  fromVersion: null,
  toVersion: "2.26.0-wiolett.1",
  fromDigest: null,
  toDigest: DIGEST,
  error: null,
  startedAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:20.000Z",
  finishedAt: null,
};

function renderPanel(props: Partial<Parameters<typeof InferenceCoreLifecyclePanel>[0]> = {}) {
  const onRefresh = props.onRefresh ?? vi.fn().mockResolvedValue(undefined);
  render(
    <>
      <InferenceCoreLifecyclePanel
        mode="settings"
        status={readyStatus}
        canManage
        onRefresh={onRefresh}
        {...props}
      />
      <ConfirmDialog />
    </>
  );
  return { onRefresh };
}

describe("InferenceCoreLifecyclePanel", () => {
  afterEach(() => {
    useConfirmDialog.getState().close();
    vi.restoreAllMocks();
  });

  it("renders the not-installed state and runs the install flow", async () => {
    const install = vi
      .spyOn(api, "installInferenceCore")
      .mockResolvedValue({ operation: runningOperation });
    const status = makeStatus({
      state: "not_installed",
      latest: {
        version: "2.26.0-wiolett.1",
        digest: DIGEST,
        sizeBytes: 412345678,
        releaseNotesUrl: null,
      },
    });
    const { onRefresh } = renderPanel({ status });
    const user = userEvent.setup();

    const state = screen.getByText("Not installed").parentElement;
    expect(state).toHaveClass("h-5", "px-1", "shrink-0", "whitespace-nowrap");
    expect(state?.parentElement).toHaveClass("inline-flex", "whitespace-nowrap");
    expect(screen.getByText("2.26.0-wiolett.1")).toBeInTheDocument();
    expect(screen.getByText(/393\.2/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Install inference core/ }));

    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(onRefresh).toHaveBeenCalled();
  });

  it("renders an active operation from server state with determinate progress", () => {
    renderPanel({ status: makeStatus({ state: "pulling", operation: runningOperation }) });

    // Both the state badge and the stage title name the current stage.
    expect(screen.getAllByText("Downloading image").length).toBeGreaterThanOrEqual(1);
    const progress = screen.getByRole("progressbar", {
      name: "Inference core install progress",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByText(/30%/)).toBeInTheDocument();
    expect(screen.getByText(/117\.7 .* of .*393\.2/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 9 layers/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Install inference core/ })
    ).not.toBeInTheDocument();
  });

  it("stays explicitly indeterminate when the backend supplies no totals", () => {
    renderPanel({
      status: makeStatus({
        state: "pulling",
        operation: { ...runningOperation, progress: { stage: "Downloading image" } },
      }),
    });

    expect(screen.getAllByText("Downloading image").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/Download details appear when they are available/)).toBeInTheDocument();
  });

  it("renders the ready state with version, health, and last check", () => {
    renderPanel();

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("2.26.0-wiolett.1")).toBeInTheDocument();
    expect(screen.queryByText("Digest")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy digest" })).not.toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check for updates/ })).toBeInTheDocument();
  });

  it.each([
    ["negotiated-v1", "Supported"],
    ["legacy", "Gateway request limits require a core update"],
    ["unknown", "Gateway request limits are unverified"],
  ] as const)("renders request-limit capability status for %s", (capability, message) => {
    renderPanel({
      status: makeStatus({
        ...readyStatus,
        health: { ...readyStatus.health, requestLimitsCapability: capability },
      }),
    });

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("confirms an available update and explains interruption and rollback", async () => {
    const update = vi
      .spyOn(api, "updateInferenceCore")
      .mockResolvedValue({ operation: { ...runningOperation, kind: "update" } });
    const status = makeStatus({
      ...readyStatus,
      state: "update_available",
      latest: {
        version: "2.27.0-wiolett.1",
        digest: DIGEST,
        sizeBytes: 412345678,
        releaseNotesUrl: "https://docs.wiolett.example/releases/2.27.0-wiolett.1",
      },
    });
    renderPanel({ status });
    const user = userEvent.setup();

    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByLabelText("Inference core status")).toHaveClass("border-warning");
    expect(screen.getByText(/2\.26\.0-wiolett\.1 → 2\.27\.0-wiolett\.1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Update to 2\.27\.0-wiolett\.1/ }));

    expect(await screen.findByText("Update Inference Core")).toBeInTheDocument();
    expect(screen.getByText(/briefly interrupted/)).toBeInTheDocument();
    expect(screen.getByText(/automatically restores the previous version/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("2.27.0-wiolett.1"));
  });

  it("uses the info border while the core is updating", () => {
    renderPanel({
      status: makeStatus({
        ...readyStatus,
        state: "updating",
        operation: { ...runningOperation, kind: "update", phase: "updating" },
      }),
    });

    expect(screen.getByText("Updating")).toBeInTheDocument();
    expect(screen.getByLabelText("Inference core status")).toHaveClass("border-link");
  });

  it("keeps the enclosing page hidden while the first status request runs", async () => {
    const view = (status: InferenceCoreStatus | null, loading: boolean) => (
      <PageTransition>
        <InferenceCoreLifecyclePanel
          mode="settings"
          status={status}
          loading={loading}
          canManage
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </PageTransition>
    );
    const { container, rerender } = render(view(null, true));
    const gate = container.querySelector("[data-page-transition]");

    expect(gate).not.toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.queryByLabelText("Inference core status")).not.toBeInTheDocument();

    rerender(view(readyStatus, false));

    await waitFor(() => {
      expect(gate).toHaveAttribute("data-reveal-phase", "revealed");
      expect(screen.getByLabelText("Inference core status")).toBeVisible();
    });
  });

  it("disables the retry action while a failed status request is retried", async () => {
    let resolveRefresh!: () => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    renderPanel({ status: null, error: "Core unreachable", onRefresh });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    await act(async () => resolveRefresh());
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("shows the setup footer's in-place status request as a pending button", () => {
    render(
      <InferenceCoreSetupFooterAction
        status={null}
        loading
        canManage
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const button = screen.getByRole("button", { name: "Loading core status" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("reports an installed current release as up to date", async () => {
    vi.spyOn(api, "checkInferenceCoreUpdates").mockResolvedValue({
      latest: {
        version: "2.26.0-wiolett.1",
        digest: DIGEST,
        sizeBytes: 412345678,
        releaseNotesUrl: null,
      },
    });
    const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
    const info = vi.spyOn(toast, "info").mockImplementation(() => "toast-id");
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Check for updates/ }));

    await waitFor(() => expect(success).toHaveBeenCalledWith("Inference core is up to date"));
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps setup lifecycle actions out of the status panel", () => {
    renderPanel({ canManage: false, mode: "setup" });

    expect(screen.queryByRole("button", { name: /Check for updates/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue to providers/ })).not.toBeInTheDocument();
  });

  it("offers Repair for a failed installed core and shows the redacted error", () => {
    renderPanel({
      status: makeStatus({
        ...readyStatus,
        state: "failed",
        lastError: "The inference core failed to start: port already in use",
      }),
    });

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/port already in use/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair" })).toBeInTheDocument();
  });

  it("offers Retry install when a failed install left nothing installed", () => {
    renderPanel({
      status: makeStatus({ state: "failed", lastError: "Download failed" }),
    });

    expect(screen.getByRole("button", { name: "Retry install" })).toBeInTheDocument();
  });

  it("marks an incompatible core as Update required", () => {
    renderPanel({
      status: makeStatus({ ...readyStatus, compatibility: "update_required" }),
    });

    expect(screen.getByText("Update required")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Update inference core|Update to/ })
    ).toBeInTheDocument();
  });

  it("exposes stage changes through a polite live region", () => {
    renderPanel({ status: makeStatus({ state: "pulling", operation: runningOperation }) });

    const stages = screen.getAllByText("Downloading image");
    expect(stages.some((stage) => stage.closest("[aria-live='polite']"))).toBe(true);
  });
});
