import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { InferenceCoreStatus } from "@/types/inference-core";
import { InferenceSettingsSection } from "./InferenceSettingsSection";

vi.mock("../inference/InferenceActivityPanel", () => ({
  InferenceActivityPanel: () => <div>Activity panel</div>,
}));
vi.mock("../inference/InferenceAdminTables", () => ({
  InferenceUsersTable: () => <div>Users table</div>,
}));
vi.mock("../inference/InferenceUsagePanels", () => ({
  InferenceOverview: () => <div>Usage overview</div>,
}));
vi.mock("./inference/InferenceEndpointSettingsPanel", () => ({
  InferenceEndpointSettingsPanel: () => <div>Endpoint settings</div>,
}));
vi.mock("./inference/InferenceModelsPanel", () => ({
  InferenceModelsPanel: () => <div>Models panel</div>,
}));
vi.mock("./inference/InferenceProvidersPanel", () => ({
  InferenceProvidersPanel: () => <div>Providers panel</div>,
}));

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
  installed: {
    version: "2.26.0-wiolett.1",
    digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    imageRef: "core@sha256:0123",
  },
  compatibility: "compatible",
  health: {
    status: "healthy",
    version: "2.26.0-wiolett.1",
    coreProtocolMajor: 1,
    stateSchemaVersion: 1,
    checkedAt: "2026-08-19T08:00:00.000Z",
  },
});

function setUser(scopes: string[]) {
  useAuthStore.setState({ user: makeUser({ scopes }), isAuthenticated: true, isLoading: false });
}

describe("InferenceSettingsSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the core panel first and disables provider/model panels until ready", async () => {
    setUser(["inference:providers:view", "inference:providers:manage", "inference:models:manage"]);
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(makeStatus());

    render(<InferenceSettingsSection />);

    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Install the inference core above before configuring/).length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Providers panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Models panel")).not.toBeInTheDocument();
    expect(screen.getByText("Endpoint settings")).toBeInTheDocument();
  });

  it("enables provider and model panels once the core is compatible and ready", async () => {
    setUser(["inference:providers:view", "inference:providers:manage", "inference:models:manage"]);
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(readyStatus);

    render(<InferenceSettingsSection />);

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(await screen.findByText("Providers panel")).toBeInTheDocument();
    expect(screen.getByText("Models panel")).toBeInTheDocument();
  });

  it("keeps core actions hidden from viewers while still showing status", async () => {
    setUser(["inference:providers:view", "inference:models:manage"]);
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(makeStatus());

    render(<InferenceSettingsSection />);

    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Install inference core/ })
    ).not.toBeInTheDocument();
  });
});
