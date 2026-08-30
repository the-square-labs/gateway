import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageProject } from "@/types";
import { PageProjectDetail } from "./PageProjectDetail";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(async () => true),
  activeTab: "deployments",
  realtimeHandlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: mocks.confirm }));
vi.mock("@/components/common/PageBackButton", () => ({ PageBackButton: () => null }));
vi.mock("@/components/common/ResponsiveHeaderActions", () => ({
  HEADER_ACTION_PRIORITY: { primary: 100 },
  ResponsiveHeaderActions: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (event: string, handler: (payload: unknown) => void) => {
    mocks.realtimeHandlers.set(event, handler);
  },
}));
vi.mock("@/hooks/use-url-tab", () => ({ useUrlTab: () => [mocks.activeTab, vi.fn()] }));
vi.mock("./PageDeploymentsTab", () => ({ PageDeploymentsTab: () => null }));
vi.mock("./PageManualDeployDialog", () => ({ PageManualDeployDialog: () => null }));
vi.mock("./PageProjectSettingsTab", () => ({ PageProjectSettingsDialog: () => null }));
vi.mock("./PageRuntimeConfigTab", () => ({ PageRuntimeConfigTab: () => null }));
vi.mock("./PageTagsTab", () => ({ PageTagsTab: () => null }));
vi.mock("./PageTokensTab", () => ({ PageTokensTab: () => null }));

const project: PageProject = {
  id: "project-1",
  name: "Demo",
  slug: "demo",
  description: null,
  appearanceColor: null,
  spaFallback: false,
  fallbackUrl: null,
  primaryDomain: null,
  nodeId: null,
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

describe("PageProjectDetail deletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.navigate.mockReset();
    mocks.confirm.mockClear();
    mocks.activeTab = "deployments";
    mocks.realtimeHandlers.clear();
    vi.spyOn(api, "listPageDeployments").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    useAuthStore.setState({
      user: {
        id: "user-1",
        scopes: ["pages:view:project-1", "pages:delete:project-1"],
        isBlocked: false,
      } as never,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("does not report a realtime 404 after a successful delete", async () => {
    const user = userEvent.setup();
    const getProject = vi
      .spyOn(api, "getPageProject")
      .mockResolvedValueOnce(project)
      .mockRejectedValueOnce(new Error("Page Project not found"));
    vi.spyOn(api, "listPageProjectPlacementOptions").mockResolvedValue([]);
    vi.spyOn(api, "deletePageProject").mockImplementation(async () => {
      mocks.realtimeHandlers.get("pages.project.changed")?.({ projectId: project.id });
    });
    const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");

    render(<PageProjectDetail projectId={project.id} resolvedSlug={project.slug} />);
    await user.click(await screen.findByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(success).toHaveBeenCalledWith("Page Project deleted"));
    expect(error).not.toHaveBeenCalled();
    expect(getProject).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("/pages");
  });

  it("shows the latest immutable preview without mounting the deployments tab", async () => {
    mocks.activeTab = "source";
    vi.spyOn(api, "getPageProject").mockResolvedValue(project);
    vi.mocked(api.listPageDeployments).mockResolvedValue({
      data: [
        {
          id: "deployment-1",
          projectId: project.id,
          sequence: 1,
          publicSlug: "preview-slug",
          previewHostname: "preview-slug.pages.example.test",
          status: "ready",
          artifactSha256: "a".repeat(64),
          compressedSizeBytes: 1,
          expandedSizeBytes: 1,
          fileCount: 1,
          sourceMetadata: {},
          requestedTag: null,
          pinned: false,
          failureCode: null,
          failureMessage: null,
          createdById: "user-1",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          readyAt: new Date(0).toISOString(),
          deletedAt: null,
          credentialType: "user",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    render(<PageProjectDetail projectId={project.id} resolvedSlug={project.slug} />);

    expect(await screen.findByText("Latest immutable preview")).toBeInTheDocument();
    expect(screen.getByText("preview-slug.pages.example.test")).toBeInTheDocument();
    expect(screen.queryByText("Pages Project")).not.toBeInTheDocument();
  });

  it("prefers the first bound domain over the immutable preview", async () => {
    mocks.activeTab = "source";
    vi.spyOn(api, "getPageProject").mockResolvedValue({
      ...project,
      primaryDomain: "docs.example.test",
    });
    vi.mocked(api.listPageDeployments).mockResolvedValue({
      data: [
        {
          id: "deployment-1",
          projectId: project.id,
          sequence: 1,
          publicSlug: "preview-slug",
          previewHostname: "preview-slug.pages.example.test",
          status: "ready",
          artifactSha256: "a".repeat(64),
          compressedSizeBytes: 1,
          expandedSizeBytes: 1,
          fileCount: 1,
          sourceMetadata: {},
          requestedTag: null,
          pinned: false,
          failureCode: null,
          failureMessage: null,
          createdById: "user-1",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          readyAt: new Date(0).toISOString(),
          deletedAt: null,
          credentialType: "user",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    render(<PageProjectDetail projectId={project.id} resolvedSlug={project.slug} />);

    expect(await screen.findByText("Domain")).toBeInTheDocument();
    expect(screen.getByText("docs.example.test")).toBeInTheDocument();
    expect(screen.queryByText("preview-slug.pages.example.test")).not.toBeInTheDocument();
  });
});
