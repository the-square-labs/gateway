import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { InferenceActivity } from "@/types/inference";
import { InferenceActivityPanel } from "./InferenceActivityPanel";

vi.mock("@/services/api", () => ({
  api: {
    getCached: vi.fn(),
    listInferenceActivity: vi.fn(),
    listInferenceActivityFilters: vi.fn(),
  },
}));

let intersectionCallback: IntersectionObserverCallback | undefined;

describe("InferenceActivityPanel", () => {
  beforeEach(() => {
    vi.mocked(api.getCached).mockReturnValue(undefined);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.mocked(api.listInferenceActivity).mockImplementation(async (query = {}) => {
      if (query.limit === 6) {
        return {
          data: Array.from({ length: 6 }, (_, index) => activity(`recent-${index}`)),
          nextPage: 2,
        };
      }
      if (query.page === 2) return { data: [activity("page-two")], nextPage: null };
      return { data: [activity("full-first")], nextPage: 2 };
    });
    vi.mocked(api.listInferenceActivityFilters).mockResolvedValue({
      users: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Alice Gateway",
          email: "alice@example.com",
          avatarUrl: "https://example.com/alice.png",
        },
      ],
      models: ["gpt-5.6", "kimi-k3"],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows six recent rows and lazily requests additional modal pages", async () => {
    render(<InferenceActivityPanel />);

    expect(await screen.findByText("User recent-5")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5.6 high")).toHaveLength(6);
    expect(api.listInferenceActivity).toHaveBeenCalledWith({ page: 1, limit: 6 });
    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveClass("text-left");
    expect(screen.getByRole("columnheader", { name: "Cost" })).toHaveClass("text-right");
    expect(screen.getByRole("columnheader", { name: "Time" })).toHaveClass("text-right");
    expect(screen.getByRole("button", { name: "View all" })).toHaveClass(
      "p-0",
      "text-muted-foreground"
    );

    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await waitFor(() =>
      expect(api.listInferenceActivity).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 50 })
      )
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Filters" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Operation")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Activity user" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Activity model" })).toBeInTheDocument();

    await waitFor(() => expect(intersectionCallback).toBeDefined());
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    await waitFor(() =>
      expect(api.listInferenceActivity).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 50 })
      )
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Activity user" }));
    fireEvent.mouseDown(await screen.findByRole("button", { name: "Alice Gateway" }));
    await waitFor(() =>
      expect(api.listInferenceActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          userId: "11111111-1111-4111-8111-111111111111",
        })
      )
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Activity model" }));
    fireEvent.mouseDown(await screen.findByRole("button", { name: "kimi-k3" }));
    await waitFor(() =>
      expect(api.listInferenceActivity).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, model: "kimi-k3" })
      )
    );
  });

  it("shows cached recent activity while refreshing it in the background", () => {
    vi.mocked(api.getCached).mockReturnValue({
      data: [activity("cached")],
      nextPage: null,
    });
    vi.mocked(api.listInferenceActivity).mockImplementation(() => new Promise(() => {}));

    render(<InferenceActivityPanel />);

    expect(screen.getByText("User cached")).toBeInTheDocument();
    expect(screen.queryByText("Loading activity...")).not.toBeInTheDocument();
  });
});

function activity(id: string): InferenceActivity {
  return {
    id,
    userId: id,
    userName: `User ${id}`,
    userEmail: `${id}@example.com`,
    userAvatarUrl: null,
    protocol: "responses",
    operation: "responses",
    publicModelId: "gpt-5.6",
    reasoningEffort: "high",
    budgetType: "subscription",
    status: "completed",
    credits: 1,
    apiMicrodollars: 0,
    uncachedInputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: 10,
    errorCode: null,
    startedAt: "2026-07-26T10:00:00.000Z",
    completedAt: "2026-07-26T10:00:01.000Z",
  };
}
