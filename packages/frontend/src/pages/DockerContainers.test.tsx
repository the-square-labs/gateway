import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { makeNode, makeUser } from "@/test/fixtures";
import type { DockerContainer } from "@/types";
import { DockerContainers } from "./DockerContainers";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("@/components/common/ResourceListForm", () => ({
  ResourceListForm: ({
    loading,
    loadingLabel,
    hasContent,
  }: {
    loading: boolean;
    loadingLabel: string;
    hasContent: boolean;
  }) => <div>{loading ? loadingLabel : hasContent ? "Container content" : "Empty"}</div>,
}));

vi.mock("@/components/common/FolderCreateDialog", () => ({
  FolderCreateDialog: () => null,
}));

vi.mock("@/components/docker/DockerMoveToFolderDialog", () => ({
  DockerMoveToFolderDialog: () => null,
}));

vi.mock("./DockerDeployDialog", () => ({
  DockerDeployDialog: () => null,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const initialDockerState = useDockerStore.getState();
const initialFolderState = useDockerFolderStore.getState();

describe("DockerContainers", () => {
  let containersRequest: ReturnType<typeof deferred>;
  let foldersRequest: ReturnType<typeof deferred>;

  beforeEach(() => {
    containersRequest = deferred();
    foldersRequest = deferred();
    const cachedContainer = {
      id: "container-1",
      name: "/api",
      image: "example/api:latest",
      state: "running",
      status: "Up",
      kind: "container",
      folderId: null,
      folderIsSystem: false,
      folderSortOrder: 0,
      scopeResourceId: "resource-1",
      _nodeId: "node-1",
      _nodeSlug: "docker-1",
    } as unknown as DockerContainer;

    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({
      ...initialDockerState,
      containers: [cachedContainer],
      containersByScope: { __global__: [cachedContainer] },
      dockerNodes: [makeNode({ id: "node-1", slug: "docker-1", type: "docker" })],
      dockerNodesLoaded: true,
      loading: { ...initialDockerState.loading, containers: false },
      fetchContainers: vi.fn(() => containersRequest.promise),
    });
    useDockerFolderStore.setState({
      ...initialFolderState,
      folders: [],
      isLoading: false,
      fetchFolders: vi.fn(() => foldersRequest.promise),
    });
  });

  afterEach(() => {
    useDockerStore.setState(initialDockerState, true);
    useDockerFolderStore.setState(initialFolderState, true);
  });

  it("keeps cached rows hidden until containers and folders finish their initial refresh", async () => {
    render(
      <MemoryRouter>
        <DockerContainers embedded />
      </MemoryRouter>
    );

    expect(screen.getByText("Loading containers...")).toBeInTheDocument();
    expect(screen.queryByText("Container content")).not.toBeInTheDocument();

    await act(async () => containersRequest.resolve());
    expect(screen.getByText("Loading containers...")).toBeInTheDocument();

    await act(async () => foldersRequest.resolve());
    await waitFor(() => expect(screen.getByText("Container content")).toBeInTheDocument());
  });
});
