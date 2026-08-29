import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { EnvironmentSettings, EnvironmentSettingsUpdate } from "@/types";
import { EnvironmentSettingsSection } from "./EnvironmentSettingsSection";

const settings: EnvironmentSettings = {
  rateLimits: {
    windowMs: 60_000,
    maxRequests: 1_200,
    authMaxRequests: 120,
    authLoginMaxRequests: 20,
    authCallbackMaxRequests: 60,
    setupMaxRequests: 20,
    publicStatusMaxRequests: 600,
    publicWebhookMaxRequests: 60,
    pkiMaxRequests: 600,
    streamMaxRequests: 120,
    aiWebSocketMaxRequests: 120,
    inferenceMaxRequests: 1_800,
  },
  loggingIngest: {
    maxBodyBytes: 1024 * 1024,
    maxBatchSize: 500,
    maxMessageBytes: 16 * 1024,
    maxLabels: 32,
    maxFields: 64,
    maxKeyLength: 100,
    maxValueBytes: 8 * 1024,
    maxJsonDepth: 5,
    rateLimitWindowSeconds: 60,
    globalRequestsPerWindow: 600,
    globalEventsPerWindow: 60_000,
    tokenRequestsPerWindow: 300,
    tokenEventsPerWindow: 10_000,
  },
  requestLimits: {
    requestBodyMaxBytes: 2 * 1024 * 1024,
    oauthBodyMaxBytes: 32 * 1024,
    inferenceHttpBodyMaxBytes: 256 * 1024 * 1024,
    inferenceWebSocketMaxPayloadBytes: 128 * 1024 * 1024,
    inferenceMaxConcurrentRequestsPerToken: 32,
    inferenceConcurrencyLeaseSeconds: 600,
  },
  sessions: { expirySeconds: 30 * 24 * 60 * 60 },
  pkiDefaults: { crlValidityHours: 24, expiryWarningDays: 30, expiryCriticalDays: 7 },
};

function applyUpdate(input: EnvironmentSettingsUpdate): EnvironmentSettings {
  const current = structuredClone(settings);
  return {
    rateLimits: { ...current.rateLimits, ...input.rateLimits },
    loggingIngest: { ...current.loggingIngest, ...input.loggingIngest },
    requestLimits: { ...current.requestLimits, ...input.requestLimits },
    sessions: { ...current.sessions, ...input.sessions },
    pkiDefaults: { ...current.pkiDefaults, ...input.pkiDefaults },
  };
}

describe("EnvironmentSettingsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("saves an inference HTTP limit in human-readable MiB", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getEnvironmentSettings").mockResolvedValue({
      data: structuredClone(settings),
      defaults: structuredClone(settings),
    });
    const update = vi
      .spyOn(api, "updateEnvironmentSettings")
      .mockImplementation(async (input) => applyUpdate(input));

    render(<EnvironmentSettingsSection canEdit />);

    const panel = await screen.findByRole("region", { name: "HTTP and inference limits settings" });
    const input = within(panel).getByRole("spinbutton", { name: "Inference HTTP body (MiB)" });
    const restore = within(panel).getByRole("button", { name: "Restore defaults" });
    expect(input).toHaveValue(256);
    expect(restore).toBeDisabled();
    await user.clear(input);
    await user.type(input, "96");
    expect(restore).toBeEnabled();
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        requestLimits: expect.objectContaining({ inferenceHttpBodyMaxBytes: 96 * 1024 * 1024 }),
      })
    );
  });

  it("renders the configured request-limit defaults and maxima", async () => {
    vi.spyOn(api, "getEnvironmentSettings").mockResolvedValue({
      data: structuredClone(settings),
      defaults: structuredClone(settings),
    });

    render(<EnvironmentSettingsSection canEdit />);

    const expectations = [
      ["Default API body (MiB)", 2, "32"],
      ["OAuth and auth body (KiB)", 32, "1024"],
      ["Inference HTTP body (MiB)", 256, "2048"],
      ["Inference WebSocket payload (MiB)", 128, "512"],
      ["Concurrent inference requests (requests)", 32, "128"],
      ["Concurrency lease (seconds)", 600, "2400"],
    ] as const;

    for (const [name, value, max] of expectations) {
      const input = await screen.findByRole("spinbutton", { name });
      expect(input).toHaveValue(value);
      expect(input).toHaveAttribute("max", max);
      expect(input).not.toHaveAttribute("aria-invalid");
    }
  });

  it("renders rate limiting as two independent top-level panels", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getEnvironmentSettings").mockResolvedValue({
      data: structuredClone(settings),
      defaults: structuredClone(settings),
    });
    const update = vi
      .spyOn(api, "updateEnvironmentSettings")
      .mockImplementation(async (input) => applyUpdate(input));

    render(<EnvironmentSettingsSection canEdit />);

    const core = await screen.findByRole("region", {
      name: "Rate limits: core and authentication settings",
    });
    const publicPanel = screen.getByRole("region", {
      name: "Rate limits: public and workloads settings",
    });
    expect(within(core).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(publicPanel).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(core).getAllByRole("button", { name: /^About / })).toHaveLength(6);
    expect(within(publicPanel).getAllByRole("button", { name: /^About / })).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: /^About / })).toHaveLength(34);
    expect(within(core).getByRole("spinbutton", { name: "Setup (requests)" })).toBeDisabled();

    await user.hover(within(core).getByRole("button", { name: "About Window" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /capacity returns gradually instead of resetting at a fixed clock time/
    );

    const apiRequests = within(core).getByRole("spinbutton", { name: "API requests (requests)" });
    await user.clear(apiRequests);
    await user.type(apiRequests, "1500");
    await user.click(within(core).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        rateLimits: {
          windowMs: 60_000,
          maxRequests: 1_500,
          authMaxRequests: 120,
          authLoginMaxRequests: 20,
          authCallbackMaxRequests: 60,
        },
      })
    );
  });

  it("renders read-only controls without mutation actions", async () => {
    vi.spyOn(api, "getEnvironmentSettings").mockResolvedValue({
      data: structuredClone(settings),
      defaults: structuredClone(settings),
    });

    render(<EnvironmentSettingsSection canEdit={false} />);

    expect(
      await screen.findByRole("spinbutton", { name: "Inference HTTP body (MiB)" })
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
