import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import {
  CompactInferenceUsage,
  DashboardInferenceUsage,
  InferenceOverview,
  InferenceUsage,
} from "./InferenceUsagePanels";

vi.mock("@/services/api", () => ({
  api: { getCached: vi.fn(), getInferenceSelfUsage: vi.fn(), getInferenceSystemUsage: vi.fn() },
}));

describe("InferenceUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(api.getCached).mockReturnValue(undefined);
    useDashboardBootstrapStore.getState().clear();
    // Most compact-usage cases exercise the post-bootstrap fallback path.
    // The dedicated test below covers the initial shared-bootstrap wait.
    useDashboardBootstrapStore.setState({
      key: "dashboard-key",
      request: {} as never,
      loading: false,
      snapshot: null,
      error: false,
    });
  });

  it("shows percentages and recovery only without raw credits, dollars, tokens, or providers", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: true, percentage: 25.4, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 50.1, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: true, percentage: 10, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: true, percentage: 4.4, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<InferenceUsage />);

    const usageValue = await screen.findByText("75%");
    expect(usageValue).toBeInTheDocument();

    const usageCard = usageValue.closest<HTMLElement>(".border-0");
    expect(usageCard).toBeInTheDocument();
    expect(usageCard?.parentElement).toHaveClass("gap-px", "bg-border");
    expect(usageCard?.parentElement).not.toHaveClass("gap-4", "p-4");
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(usageCard?.querySelector(".bg-primary")).toHaveStyle({ width: "75%" });
    expect(screen.getByText("API usage")).toHaveClass("text-xs");
    expect(usageValue).toHaveClass("text-xl");
    expect(screen.getByText(`Recovers ${formatDateTime("2026-08-01T00:00:00.000Z")}`)).toHaveClass(
      "text-xs"
    );
    expect(screen.queryByText(/Just now/)).not.toBeInTheDocument();
    expect(screen.getByText("90%")).not.toHaveClass("text-warning");
    expect(screen.getByText("96%")).not.toHaveClass("text-warning");
    const panel = screen.getByText("Inference usage").closest(".border.border-border.bg-card");
    expect(panel).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText("Base URL")).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText(/\/api\/inference\/v1/)).toBeInTheDocument();
    expect(
      within(panel as HTMLElement).getByRole("button", { name: "Set up a harness" })
    ).toBeInTheDocument();
    const text = usageCard?.parentElement?.textContent ?? "";
    expect(text).not.toMatch(/\$|credits|tokens|openai|anthropic|kimi/i);
  });

  it("uses the warning color below 20 percent remaining", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: true, percentage: 80, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 83, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: false, percentage: 0, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 0, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<InferenceUsage />);

    const boundaryValue = await screen.findByText("20%");
    const lowValue = screen.getByText("17%");
    expect(boundaryValue).not.toHaveClass("text-warning");
    expect(lowValue).toHaveClass("text-warning");
    expect(
      boundaryValue.closest<HTMLElement>(".border-0")?.querySelector(".bg-primary")
    ).toHaveStyle({ backgroundColor: "var(--color-primary)" });
    expect(lowValue.closest<HTMLElement>(".border-0")?.querySelector(".bg-primary")).toHaveStyle({
      backgroundColor: "var(--color-warning)",
    });
  });

  it("omits API usage when no API-backed model is available", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 1, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: true, percentage: 2, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: true, percentage: 3, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<InferenceUsage />);

    expect(await screen.findByText("5 hours")).toBeInTheDocument();
    expect(screen.queryByText("API usage")).not.toBeInTheDocument();
  });

  it("hides the profile panel when no billable model type is available", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: false, percentage: 0, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 0, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    const { container } = render(<InferenceUsage />);

    await waitFor(() => expect(api.getInferenceSelfUsage).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up a harness" })).not.toBeInTheDocument();
  });

  it("shows dashboard usage only below 20 percent remaining", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 80, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: true, percentage: 50, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 100, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    const { unmount } = render(<DashboardInferenceUsage enabled />);
    await waitFor(() => expect(api.getInferenceSelfUsage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Inference usage")).not.toBeInTheDocument();
    unmount();

    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: true, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 50, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: true, percentage: 83, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 100, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<DashboardInferenceUsage enabled />);
    const warning = await screen.findByRole("status", {
      name: "Weekly inference quota warning",
    });
    expect(screen.getByText("Weekly inference quota is running low")).toBeInTheDocument();
    expect(screen.getByText("17%")).toHaveClass("text-warning");
    expect(warning.querySelector(".bg-warning")).toHaveStyle({ width: "17%" });
    expect(warning).toHaveClass("border-warning/60");
    expect(warning.parentElement).toHaveClass("grid-cols-1");
    expect(warning.parentElement).not.toHaveClass("sm:grid-cols-2");
    expect(warning.querySelector(".items-center.gap-3")).toBeInTheDocument();
    expect(screen.queryByText("Inference usage")).not.toBeInTheDocument();
    expect(screen.queryByText("API usage")).not.toBeInTheDocument();
    expect(screen.queryByText("5 hours")).not.toBeInTheDocument();
  });

  it("renders the compact summary without a zero-budget API row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: true, percentage: 1, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: false, percentage: 2, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: true, percentage: 3, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<CompactInferenceUsage />);

    const fiveHours = await screen.findByLabelText("5 hours remaining 99%");
    expect(screen.queryByLabelText("Weekly remaining 98%")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Monthly remaining 97%")).toBeInTheDocument();
    expect(screen.queryByText("API")).not.toBeInTheDocument();
    expect(fiveHours.querySelector(".bg-foreground")).toHaveStyle({ width: "99%" });
    expect(fiveHours.querySelector(".bg-border")).toBeInTheDocument();

    const rows = [fiveHours, screen.getByLabelText("Monthly remaining 97%")];
    for (const row of rows) {
      expect(row.firstElementChild).toHaveClass("text-[13px]", "text-muted-foreground");
    }

    const trigger = screen.getByRole("button", { name: "AI usage remaining" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveClass("text-sm");
    expect(trigger).not.toHaveClass("text-base");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("gateway:account-menu:ai-usage-open")).toBe("false");
  });

  it("waits for the shared dashboard bootstrap instead of racing a usage request", async () => {
    useDashboardBootstrapStore.setState({
      key: "dashboard-key",
      request: {} as never,
      loading: true,
      snapshot: null,
      error: false,
    });

    render(<CompactInferenceUsage withMenuSeparator />);

    expect(screen.getByLabelText("Loading AI usage")).toBeInTheDocument();
    expect(api.getInferenceSelfUsage).not.toHaveBeenCalled();

    useDashboardBootstrapStore.setState({
      loading: false,
      snapshot: {
        inferenceUsage: {
          enabled: true,
          api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
          subscription: {
            "5h": { configured: true, percentage: 1, recoveryAt: "2026-07-24T22:00:00.000Z" },
            "7d": { configured: false, percentage: 0, recoveryAt: "2026-07-31T00:00:00.000Z" },
            "30d": { configured: false, percentage: 0, recoveryAt: "2026-08-23T00:00:00.000Z" },
          },
        },
      } as never,
    });

    expect(await screen.findByLabelText("5 hours remaining 99%")).toBeInTheDocument();
    expect(api.getInferenceSelfUsage).not.toHaveBeenCalled();
  });

  it("restores the compact disclosure state from local storage", async () => {
    window.localStorage.setItem("gateway:account-menu:ai-usage-open", "false");
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: true, percentage: 5, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 0, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    render(<CompactInferenceUsage />);

    expect(await screen.findByRole("button", { name: "AI usage remaining" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByLabelText("Weekly remaining 95%")).not.toBeInTheDocument();
  });

  it("hides compact usage when no billable model type is available", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockResolvedValue({
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2026-08-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2026-07-24T22:00:00.000Z" },
        "7d": { configured: false, percentage: 0, recoveryAt: "2026-07-31T00:00:00.000Z" },
        "30d": { configured: false, percentage: 0, recoveryAt: "2026-08-23T00:00:00.000Z" },
      },
    });

    const { container } = render(<CompactInferenceUsage />);

    await waitFor(() => expect(api.getInferenceSelfUsage).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the profile panel when inference usage is unavailable", async () => {
    vi.mocked(api.getInferenceSelfUsage).mockRejectedValue(new Error("Usage unavailable"));
    const { container } = render(<InferenceUsage />);
    await waitFor(() => expect(api.getInferenceSelfUsage).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders system totals without duplicating the provider health table", async () => {
    vi.mocked(api.getInferenceSystemUsage).mockResolvedValue({
      windowDays: 30,
      requestTotals: [
        { status: "completed", requests: 4, credits: "2", apiMicrodollars: 0, tokens: 0 },
      ],
      ledgerTotals: [
        {
          budgetType: "api",
          credits: "123.6",
          apiMicrodollars: 10_000,
          tokens: "14564765420" as unknown as number,
        },
      ],
      dailyUsage: Array.from({ length: 30 }, (_, index) => ({
        date: `2026-08-${String(index + 1).padStart(2, "0")}`,
        requests: index,
        credits: index / 10,
        apiMicrodollars: index * 1_000,
        tokens: index * 100,
      })),
    });
    render(<InferenceOverview />);
    expect(await screen.findByText("14,564,765,420")).toBeInTheDocument();
    expect(screen.getByText("124")).toBeInTheDocument();
    expect(screen.getAllByText("Last 30 days")).toHaveLength(4);
    expect(document.querySelectorAll('svg[preserveAspectRatio="none"]')).toHaveLength(4);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByText("Error rate")).not.toBeInTheDocument();
    expect(screen.getByText("Tokens")).toHaveClass("text-sm");
    expect(screen.getByText("14,564,765,420")).toHaveClass("text-2xl");
    expect(screen.queryByText("Upstream health")).not.toBeInTheDocument();
  });

  it("renders cached system totals while refreshing them in the background", () => {
    vi.mocked(api.getCached).mockImplementation((key) =>
      key === "req:/api/inference/usage/system"
        ? {
            windowDays: 30,
            requestTotals: [
              {
                status: "completed",
                requests: 9,
                credits: "0",
                apiMicrodollars: 0,
                tokens: 0,
              },
            ],
            ledgerTotals: [
              {
                budgetType: "api",
                credits: "0",
                apiMicrodollars: 0,
                tokens: 9_876,
              },
            ],
            dailyUsage: [],
          }
        : undefined
    );
    vi.mocked(api.getInferenceSystemUsage).mockImplementation(() => new Promise(() => {}));

    const { rerender } = render(<InferenceOverview />);

    expect(screen.getByText("9,876")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    rerender(<InferenceOverview refreshToken={1} />);
    expect(api.getInferenceSystemUsage).toHaveBeenCalledTimes(2);
  });
});
