import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import { stubRequestLog } from "@/test/request-log";
import { Docker } from "./Docker";

const DOCKER_NODES = "GET /api/nodes?type=docker&limit=100";

describe("Docker page requests", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "nodes:details",
          ...["containers", "images", "volumes", "networks", "compose", "tasks"].map(
            (tab) => `docker:${tab}:view`
          ),
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the Docker nodes once for the open tab and the preload of the others", async () => {
    const node = makeNode({ id: "node-1", type: "docker", status: "online", isConnected: true });
    const log = stubRequestLog([
      [
        /\/api\/nodes\?type=docker/,
        { data: [node], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } },
      ],
    ]);

    render(
      <MemoryRouter initialEntries={["/docker/containers"]}>
        <Routes>
          <Route path="/docker/:tab" element={<Docker />} />
        </Routes>
      </MemoryRouter>
    );

    // The preload of the other tabs ends with the task list.
    await waitFor(() => expect(log.count("GET /api/docker/tasks")).toBe(1), { timeout: 3000 });
    expect(log.count(DOCKER_NODES)).toBe(1);
    expect(log.count("GET /api/docker/containers")).toBe(1);
  });
});
