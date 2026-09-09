import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployment } from "@/types";
import { PageDeploymentsTab } from "./PageDeploymentsTab";

const PROJECT_ID = "project-1";

const mocks = vi.hoisted(() => ({
  realtimeHandlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (event: string, handler: (payload: unknown) => void) => {
    mocks.realtimeHandlers.set(event, handler);
  },
}));
vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn(async () => true),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deployment(sequence: number): PageDeployment {
  return {
    id: `deployment-${sequence}`,
    projectId: PROJECT_ID,
    sequence,
    publicSlug: `deployment-${sequence}`,
    previewHostname: `deployment-${sequence}.pages.example.test`,
    status: "cleaning",
    artifactSha256: null,
    compressedSizeBytes: 1,
    expandedSizeBytes: 1,
    fileCount: 1,
    sourceMetadata: {},
    requestedTag: null,
    pinned: false,
    failureCode: null,
    failureMessage: null,
    createdById: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    readyAt: null,
    deletedAt: null,
    credentialType: null,
  };
}

function response(data: PageDeployment[]) {
  return {
    data,
    pagination: { page: 1, limit: 100, total: data.length, totalPages: data.length ? 1 : 0 },
  };
}

describe("PageDeploymentsTab realtime cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.realtimeHandlers.clear();
    useAuthStore.setState({
      user: {
        id: "user-1",
        scopes: ["pages:deployments:manage:project-1"],
        isBlocked: false,
      } as never,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("keeps the newest snapshot after a burst of deployment cleanup events", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => deployment(index + 1));
    const requests: Array<ReturnType<typeof deferred<ReturnType<typeof response>>>> = [];
    vi.spyOn(api, "listPageDeployments").mockImplementation(async () => {
      const request = deferred<ReturnType<typeof response>>();
      requests.push(request);
      return request.promise;
    });

    render(<PageDeploymentsTab projectId={PROJECT_ID} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    requests[0].resolve(response(rows));
    expect(await screen.findByText("deployment-1")).toBeInTheDocument();

    const handler = mocks.realtimeHandlers.get("pages.deployment.changed");
    expect(handler).toBeDefined();
    for (let index = 0; index < rows.length; index += 1) {
      handler?.({ projectId: PROJECT_ID, action: "deleted", deploymentId: rows[index].id });
    }

    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(rows.length + 1));
    requests.at(-1)?.resolve(response([]));
    for (const request of requests.slice(1, -1)) request.resolve(response(rows));

    await waitFor(() => expect(screen.queryAllByText("cleaning")).toHaveLength(0));
    expect(screen.queryByText("deployment-1")).not.toBeInTheDocument();
  });
});
