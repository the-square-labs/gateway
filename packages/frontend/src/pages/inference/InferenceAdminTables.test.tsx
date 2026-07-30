import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { api } from "@/services/api";
import type { InferenceLimitPolicy } from "@/types/inference";
import { InferenceUsersTable } from "./InferenceAdminTables";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: vi.fn(),
    getTotalSize: () => count * 49,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 49,
        size: 49,
      })),
  }),
}));

describe("InferenceUsersTable", () => {
  afterEach(() => {
    api.invalidateCache("req:/api/inference/usage/users");
    api.invalidateCache("req:/api/inference/limits");
    vi.restoreAllMocks();
  });

  it("embeds the user table and opens the shared default-policy editor", async () => {
    vi.spyOn(api, "listInferenceUsersUsage").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);
    const saveLimits = vi.spyOn(api, "setInferenceDefaultLimits").mockResolvedValue([]);
    const user = userEvent.setup();

    render(<InferenceUsersTable canManage />);

    const configure = await screen.findByRole("button", { name: "Configure limits" });
    expect(configure).toHaveClass("bg-primary");
    const search = screen.getByPlaceholderText("Search users...");
    expect(search).toHaveClass("border-0");
    expect(search.parentElement?.parentElement?.parentElement).not.toHaveClass("p-4");
    const emptyTable = await screen.findByText("No inference users");
    expect(emptyTable.parentElement).not.toHaveClass("border");

    await user.click(configure);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const policyTitle = screen.getByText("Default policy");
    const accessSwitch = screen.getByRole("button", { name: "Inference access" });
    expect(policyTitle.parentElement?.parentElement).toContainElement(accessSwitch);
    expect(screen.queryByText("Inference access")).not.toBeInTheDocument();
    expect(
      screen.getByText("Inherited by users without an individual override")
    ).toBeInTheDocument();
    expect(screen.getByText("AI credit limits")).toBeInTheDocument();
    expect(
      screen.getByText("Choose which rolling credit windows apply to every user")
    ).toBeInTheDocument();

    const fiveHourInput = screen.getByRole("spinbutton", {
      name: "5-hour credit limit value",
    });
    expect(fiveHourInput).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "5 hours limit enabled" }));
    expect(fiveHourInput).toBeEnabled();

    const timezone = screen.getByRole("combobox", { name: "Billing timezone" });
    expect(timezone).toHaveValue("UTC");
    await user.click(timezone);
    await user.click(screen.getByText("Europe/Chisinau"));
    expect(timezone).toHaveValue("Europe/Chisinau");

    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(saveLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        credits5hEnabled: true,
        credits7dEnabled: false,
        credits30dEnabled: false,
        billingTimezone: "Europe/Chisinau",
      })
    );
  });

  it("keeps a raw user preference but disables a window gated off globally", async () => {
    vi.spyOn(api, "listInferenceUsersUsage").mockResolvedValue([
      {
        id: "user-1",
        email: "alex@example.com",
        name: "Alex Gateway",
        avatarUrl: "https://example.com/alex.png",
        limits: {
          enabled: true,
          credits5hEnabled: false,
          credits5h: 10,
          credits7dEnabled: true,
          credits7d: 20,
          credits30dEnabled: false,
          credits30d: 30,
          apiMonthlyMicrodollars: 10_000_000,
          billingTimezone: "UTC",
        },
        usage: {
          credits5h: 0,
          credits7d: 0,
          credits30d: 0,
          apiMonthlyMicrodollars: 0,
          recoveryAt: {},
        },
      },
    ]);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([
      limitPolicy({
        policyType: "default",
        userId: null,
        credits5hEnabled: false,
        credits7dEnabled: true,
        credits30dEnabled: false,
      }),
      limitPolicy({
        id: "user-policy",
        policyType: "user",
        userId: "user-1",
        credits5hEnabled: true,
        credits7dEnabled: true,
        credits30dEnabled: true,
        credits5h: "10",
        credits7d: "20",
        credits30d: "30",
      }),
    ]);
    const saveLimits = vi.spyOn(api, "setInferenceUserLimits").mockResolvedValue([]);
    const user = userEvent.setup();

    render(<InferenceUsersTable canManage />);

    const userName = await screen.findByText("Alex Gateway");
    expect(screen.getByText("AG")).toBeInTheDocument();
    await user.click(userName);

    const fiveHourSwitch = screen.getByRole("button", { name: "5 hours limit enabled" });
    expect(fiveHourSwitch).toBeDisabled();
    expect(fiveHourSwitch).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("spinbutton", { name: "5-hour credit limit value" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(saveLimits).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ credits5hEnabled: true, credits30dEnabled: true })
    );
  });

  it("keeps cached limits visible while refreshing in the background", () => {
    api.setCache("req:/api/inference/usage/users", [
      {
        id: "cached-user",
        email: "cached@example.com",
        name: "Cached User",
        avatarUrl: null,
        limits: {
          enabled: true,
          credits5hEnabled: false,
          credits5h: 0,
          credits7dEnabled: false,
          credits7d: 0,
          credits30dEnabled: false,
          credits30d: 0,
          apiMonthlyMicrodollars: 0,
          billingTimezone: "UTC",
        },
        usage: null,
      },
    ]);
    api.setCache("req:/api/inference/limits", []);
    vi.spyOn(api, "listInferenceUsersUsage").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "listInferenceLimits").mockImplementation(() => new Promise(() => {}));

    render(<InferenceUsersTable canManage />);

    expect(screen.getByText("Cached User")).toBeInTheDocument();
    expect(screen.queryByText("Loading users...")).not.toBeInTheDocument();
  });

  it("loads policy-only user rows without calling the protected usage endpoint", async () => {
    const listUsage = vi.spyOn(api, "listInferenceUsersUsage");
    vi.spyOn(api, "listInferenceLimitUsers").mockResolvedValue([
      {
        id: "user-1",
        email: "limited@example.com",
        name: "Limits Admin Target",
        avatarUrl: null,
        limits: {
          enabled: true,
          credits5hEnabled: false,
          credits5h: 0,
          credits7dEnabled: true,
          credits7d: 500,
          credits30dEnabled: false,
          credits30d: 0,
          apiMonthlyMicrodollars: 10_000_000,
          billingTimezone: "UTC",
        },
        usage: null,
      },
    ]);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);

    render(<InferenceUsersTable canManage canViewUsage={false} />);

    expect(await screen.findByText("Limits Admin Target")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
    expect(listUsage).not.toHaveBeenCalled();
  });
});

function limitPolicy(overrides: Partial<InferenceLimitPolicy> = {}): InferenceLimitPolicy {
  return {
    id: "default-policy",
    policyType: "default" as const,
    userId: null,
    enabled: true,
    credits5hEnabled: true,
    credits5h: "100",
    credits7dEnabled: true,
    credits7d: "500",
    credits30dEnabled: true,
    credits30d: "1000",
    apiMonthlyMicrodollars: 10_000_000,
    billingTimezone: "UTC",
    ...overrides,
  };
}
