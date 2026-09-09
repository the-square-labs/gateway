import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { PageProject } from "@/types";
import { Pages } from "./Pages";

const realtime = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (channel: string, callback: () => void) => realtime.set(channel, callback),
}));
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
    realtime.clear();
    useAuthStore.setState({
      user: makeUser({ scopes: ["pages:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("does not restore stale project placement when folder refreshes finish out of order", async () => {
    const original = project("p1", "Original location");
    const moved = { ...original, name: "Moved location", folderId: "f2" };
    const response = (data: PageProject[]) => ({
      data,
      pagination: { page: 1, limit: 100, total: data.length, totalPages: 1 },
    });
    let finishOld!: (result: ReturnType<typeof response>) => void;
    vi.spyOn(api, "getCached").mockReturnValue(undefined);
    vi.spyOn(api, "setCache").mockImplementation(() => undefined);
    const list = vi.spyOn(api, "listPageProjects").mockResolvedValue(response([original]));
    render(
      <MemoryRouter>
        <Pages />
      </MemoryRouter>
    );
    await screen.findByText("Original location");
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    act(() => realtime.get("pages.folder.changed")?.());
    list.mockResolvedValueOnce(response([moved]));
    await act(async () => realtime.get("pages.project.changed")?.());
    await screen.findByText("Moved location");
    await act(async () => finishOld(response([original])));
    expect(screen.getByText("Moved location")).toBeInTheDocument();
    expect(screen.queryByText("Original location")).not.toBeInTheDocument();
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
