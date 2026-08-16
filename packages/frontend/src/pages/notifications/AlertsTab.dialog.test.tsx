import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { AlertCategoryDef, AlertRule, NotificationWebhook } from "@/types";
import { AlertDialog } from "./AlertDialog";
import { AlertsTab } from "./AlertsTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("./template-editor", () => ({
  AnimatedHeight: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  STEP_ANIMATION: {},
  TemplateCheatsheetLink: () => <button type="button">Template cheatsheet</button>,
  TemplateEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="Message Template"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  UNIVERSAL_VARIABLES: [],
}));

function makeCategory(): AlertCategoryDef {
  return {
    id: "node",
    label: "Node",
    metrics: [
      {
        id: "cpu",
        label: "CPU",
        unit: "%",
        defaultOperator: ">",
        defaultValue: 80,
        defaultDurationSeconds: 300,
        defaultResolveAfterSeconds: 60,
      },
    ],
    events: [],
    variables: [],
  };
}

function makeWebhook(): NotificationWebhook {
  return {
    id: "webhook-1",
    name: "Ops",
    url: "https://example.com/hook",
    method: "POST",
    enabled: true,
    signingSecret: null,
    signingHeader: null,
    templatePreset: "custom",
    bodyTemplate: null,
    headers: {},
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}

function makeRule(): AlertRule {
  return {
    id: "alert-1",
    name: "CPU High",
    enabled: true,
    type: "threshold",
    category: "node",
    severity: "warning",
    metric: "cpu",
    metricTarget: null,
    operator: ">",
    thresholdValue: 80,
    durationSeconds: 300,
    fireThresholdPercent: 100,
    resolveAfterSeconds: 60,
    resolveThresholdPercent: 100,
    eventPattern: null,
    resourceIds: [],
    messageTemplate: "CPU is high",
    webhookIds: ["webhook-1"],
    cooldownSeconds: 900,
    isBuiltin: false,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}

describe("AlertDialog", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
    vi.spyOn(api, "getAlertCategories").mockResolvedValue([makeCategory()]);
    vi.spyOn(api, "listWebhooks").mockResolvedValue({
      data: [makeWebhook()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
  });

  afterEach(() => {
    api.resetSessionState();
  });

  it("keeps edit defaults and submits the alert update payload", async () => {
    const user = userEvent.setup();
    const updateAlertRule = vi.spyOn(api, "updateAlertRule").mockResolvedValue(makeRule());
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();

    renderWithRouter(
      <AlertDialog open={true} onOpenChange={onOpenChange} rule={makeRule()} onSaved={onSaved} />,
      { path: "/notifications", route: "/notifications" }
    );

    await screen.findByDisplayValue("CPU High");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => {
      expect(updateAlertRule).toHaveBeenCalledWith(
        "alert-1",
        expect.objectContaining({
          name: "CPU High",
          category: "node",
          type: "threshold",
          metric: "cpu",
          thresholdValue: 80,
          durationSeconds: 300,
          webhookIds: ["webhook-1"],
        })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSaved).toHaveBeenCalled();
  });

  it("uses the shared scope list for resources and webhooks", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listNodes).mockResolvedValue({
      data: [
        {
          id: "node-1",
          type: "nginx",
          hostname: "node-1",
          displayName: "Primary Node",
        },
      ] as never,
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(
      <AlertDialog
        open={true}
        onOpenChange={vi.fn()}
        rule={{ ...makeRule(), resourceIds: ["node-1"] }}
        onSaved={vi.fn()}
      />,
      { path: "/notifications", route: "/notifications" }
    );

    await screen.findByDisplayValue("CPU High");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(await screen.findByRole("checkbox", { name: "Primary Node" })).toHaveClass(
      "form-checkbox"
    );
    expect(screen.getByRole("checkbox", { name: /Ops/ })).toHaveClass("form-checkbox");
    expect(screen.queryByText("node-1")).not.toBeInTheDocument();
  });

  it("targets a reported physical GPU when a GPU node alert is scoped to one node", async () => {
    const user = userEvent.setup();
    const gpuRule: AlertRule = {
      ...makeRule(),
      name: "GPU Utilization High",
      metric: "gpu_utilization_percent",
      metricTarget: "nvidia:gpu-1",
      resourceIds: ["node-1"],
    };
    vi.spyOn(api, "getAlertCategories").mockResolvedValue([
      {
        ...makeCategory(),
        metrics: [
          {
            id: "gpu_utilization_percent",
            label: "GPU Utilization (%)",
            unit: "%",
            defaultOperator: ">",
            defaultValue: 90,
            defaultDurationSeconds: 300,
            defaultResolveAfterSeconds: 60,
          },
        ],
      },
    ]);
    vi.mocked(api.listNodes).mockResolvedValue({
      data: [
        {
          id: "node-1",
          type: "docker",
          hostname: "gpu-node",
          displayName: "GPU Node",
          lastHealthReport: {
            gpuDevices: [
              {
                id: "nvidia:gpu-1",
                vendor: "nvidia",
                model: "RTX 3050",
                pciAddress: "0000:01:00.0",
                renderNode: "/dev/dri/renderD128",
                deviceIndex: 0,
                attachable: true,
                unavailableReason: "",
                partitioned: false,
                availableMetrics: ["utilization_percent"],
              },
            ],
          },
        },
      ] as never,
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    const updateAlertRule = vi.spyOn(api, "updateAlertRule").mockResolvedValue(gpuRule);

    renderWithRouter(
      <AlertDialog open={true} onOpenChange={vi.fn()} rule={gpuRule} onSaved={vi.fn()} />,
      { path: "/notifications", route: "/notifications" }
    );

    await screen.findByDisplayValue("GPU Utilization High");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("GPU To Watch")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA · RTX 3050")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => {
      expect(updateAlertRule).toHaveBeenCalledWith(
        "alert-1",
        expect.objectContaining({
          metric: "gpu_utilization_percent",
          metricTarget: "nvidia:gpu-1",
          resourceIds: ["node-1"],
        })
      );
    });
  });

  it("does not replay a stale create token when the alerts tab mounts", async () => {
    vi.spyOn(api, "listAlertRules").mockResolvedValue({
      data: [makeRule()],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<AlertsTab canRead canManage openCreateToken={3} />, {
      path: "/notifications",
      route: "/notifications",
    });

    await screen.findByText("CPU High");
    expect(screen.queryByRole("heading", { name: "New Alert" })).not.toBeInTheDocument();
  });

  it("uses the shared empty state with a create CTA and no duplicate description", async () => {
    vi.spyOn(api, "listAlertRules").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 1,
    });

    renderWithRouter(<AlertsTab canRead canManage openCreateToken={0} />, {
      path: "/notifications",
      route: "/notifications",
    });

    expect(await screen.findByRole("button", { name: "Create an alert" })).toBeInTheDocument();
    expect(
      screen.queryByText("Alerts define conditions that trigger notifications to webhooks.")
    ).not.toBeInTheDocument();
  });
});
