import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { stubRequestLog } from "@/test/request-log";
import type { PageProject } from "@/types";
import { PageProjectDetail } from "./PageProjectDetail";

const project: PageProject = {
  id: "project-1",
  name: "Demo",
  slug: "demo",
  description: null,
  appearanceColor: null,
  spaFallback: false,
  previewsEnabled: true,
  fallbackUrl: null,
  primaryDomain: null,
  nodeId: "node-1",
  migrationSourceNodeId: null,
  migrationTargetNodeId: null,
  migrationStatus: null,
  migrationGeneration: 0,
  migrationError: null,
  folderId: null,
  sortOrder: 0,
  maxDeployments: 10,
  storageQuotaBytes: 1024,
  storageUsedBytes: 0,
  nextDeploymentSequence: 1,
  deploymentCount: 0,
  tagCount: 0,
  routeCount: 0,
  createdById: "user-1",
  updatedById: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const PROJECT = "GET /api/pages/project-1";
const DEPLOYMENTS = "GET /api/pages/project-1/deployments?page=1&limit=100";

function renderDetail(initialProject?: PageProject) {
  return render(
    <MemoryRouter initialEntries={["/pages/demo/deployments"]}>
      <Routes>
        <Route
          path="/pages/:projectSlug/:tab?"
          element={
            <PageProjectDetail
              projectId="project-1"
              resolvedSlug="demo"
              initialProject={initialProject}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("Page Project detail requests", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["pages:view", "pages:deploy", "pages:edit", "pages:delete"] }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the Deployments once for the header and the Deployments tab", async () => {
    const log = stubRequestLog([[/\/api\/pages\/project-1$/, { data: project }]]);

    renderDetail();

    await waitFor(() => expect(log.count("GET /api/pages/placement-options")).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log.count(PROJECT)).toBe(1);
    expect(log.count(DEPLOYMENTS)).toBe(1);
  });

  it("starts from the Project the route resolved instead of fetching it again", async () => {
    const log = stubRequestLog();

    renderDetail(project);

    await waitFor(() => expect(log.count(DEPLOYMENTS)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log.count(PROJECT)).toBe(0);
    expect(log.count(DEPLOYMENTS)).toBe(1);
  });
});
