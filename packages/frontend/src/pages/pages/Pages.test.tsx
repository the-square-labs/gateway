import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { PageProject } from "@/types";
import { Pages } from "./Pages";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@/components/common/FolderedResourceList", () => ({
  FolderedResourceList: ({
    loading,
    loadingLabel,
    resources,
  }: {
    loading: boolean;
    loadingLabel: string;
    resources: PageProject[];
  }) => <div>{loading ? loadingLabel : resources.map((project) => project.name).join(", ")}</div>,
}));

const initialAuthState = useAuthStore.getState();

function project(id: string, name: string): PageProject {
  return {
    id,
    name,
    slug: id,
    description: null,
    nodeId: "node-1",
    folderId: null,
    sortOrder: 0,
    appearanceColor: null,
    deploymentCount: 0,
    tagCount: 0,
    storageUsedBytes: 0,
    storageQuotaBytes: 1024,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  } as PageProject;
}

describe("Pages", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["pages:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState(initialAuthState, true);
  });

  it("keeps cached page content hidden until the initial project refresh completes", async () => {
    const cached = project("cached", "Cached project");
    const live = project("live", "Live project");
    let resolveProjects:
      | ((result: Awaited<ReturnType<typeof api.listPageProjects>>) => void)
      | undefined;
    vi.spyOn(api, "getCached").mockReturnValue({ data: [cached] });
    vi.spyOn(api, "setCache").mockImplementation(() => undefined);
    const listProjects = vi.spyOn(api, "listPageProjects").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProjects = resolve;
        })
    );

    render(
      <MemoryRouter>
        <Pages />
      </MemoryRouter>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(screen.getByText("Loading Page Projects...")).not.toBeVisible();

    await act(async () => {
      resolveProjects?.({
        data: [live],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      });
    });

    await waitFor(() => {
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(screen.getByText("Live project")).toBeVisible();
    });
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});
