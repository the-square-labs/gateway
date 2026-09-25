import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployment, PageProject, PageTag } from "@/types";
import { PageDeploymentsTab } from "./PageDeploymentsTab";
import { PagePreviewLinksPanel } from "./PagePreviewLinksPanel";
import { PageTagsTab } from "./PageTagsTab";
import { formatPageExpiry, pagePreviewLinkReason } from "./page-format";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: mocks.confirm }));

const PROJECT_ID = "project-1";

const project = {
  id: PROJECT_ID,
  name: "Demo",
  slug: "demo",
  previewHash: "abcdefghijkl",
  accessListId: null,
} as PageProject;

function deployment(overrides: Partial<PageDeployment> = {}): PageDeployment {
  return {
    id: "deployment-1",
    projectId: PROJECT_ID,
    sequence: 1,
    publicSlug: "mnopqrstuvwxyz23",
    previewHostname: "mnopqrstuvwxyz23.pages.example.test",
    status: "ready",
    artifactSha256: null,
    compressedSizeBytes: 1,
    expandedSizeBytes: 1,
    fileCount: 1,
    sourceMetadata: {},
    requestedTag: "demo",
    pinned: false,
    failureCode: null,
    failureMessage: null,
    createdById: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    readyAt: null,
    deletedAt: null,
    credentialType: null,
    ...overrides,
  };
}

function tag(name: string, preview: PageTag["preview"]): PageTag {
  return {
    id: `tag-${name}`,
    projectId: PROJECT_ID,
    name,
    system: name === "latest",
    generation: 1,
    deployment: {
      id: "deployment-1",
      sequence: 1,
      publicSlug: "mnopqrstuvwxyz23",
      status: "ready",
    },
    preview,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.confirm.mockResolvedValue(true);
  useAuthStore.setState({
    user: {
      id: "user-1",
      scopes: [`pages:tags:manage:${PROJECT_ID}`, `pages:deployments:manage:${PROJECT_ID}`],
      isBlocked: false,
    } as never,
    isAuthenticated: true,
    isLoading: false,
  });
});

describe("Pages preview links", () => {
  it("shows each Tag's stable preview link with a copy button, or why it has none", async () => {
    vi.spyOn(api, "listPageTags").mockResolvedValue([
      tag("demo", {
        hostname: "abcdefghijkl-demo.pages.example.test",
        url: "https://abcdefghijkl-demo.pages.example.test",
        status: "ready",
        reason: null,
      }),
      tag("x".repeat(55), {
        hostname: null,
        url: null,
        status: "unavailable",
        reason: "label_too_long",
      }),
    ]);
    vi.spyOn(api, "listPageDeployments").mockResolvedValue({
      data: [deployment()],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    render(<PageTagsTab projectId={PROJECT_ID} />);

    const link = await screen.findByRole("link", { name: "abcdefghijkl-demo.pages.example.test" });
    expect(link).toHaveAttribute("href", "https://abcdefghijkl-demo.pages.example.test");
    expect(screen.getByRole("button", { name: /demo preview URL/i })).toBeInTheDocument();
    expect(screen.getByText("Name too long for a link")).toBeInTheDocument();
  });

  it("shows the expiry of a Deployment in its details", async () => {
    const user = userEvent.setup();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    vi.spyOn(api, "listPageDeployments").mockResolvedValue({
      data: [deployment({ expiresAt })],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });

    render(<PageDeploymentsTab projectId={PROJECT_ID} />);

    await user.click(await screen.findByText("mnopqrstuvwxyz23"));
    expect(await screen.findByText(formatPageExpiry(expiresAt) as string)).toBeInTheDocument();
  });

  it("rotates every preview link only after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listAccessLists").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    } as never);
    const rotated = { ...project, previewHash: "zzzzzzzzzzzz" };
    const rotate = vi.spyOn(api, "rotatePagePreviewHash").mockResolvedValue({
      project: rotated,
      rotation: { revokedHostnames: 3, cleanupPendingHostnames: 0, republishFailures: 0 },
    });
    const onProjectChange = vi.fn();
    render(
      <PagePreviewLinksPanel
        project={project}
        accessListId=""
        onAccessListChange={vi.fn()}
        onProjectChange={onProjectChange}
      />
    );

    mocks.confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Rotate preview links" }));
    expect(rotate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Rotate preview links" }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(rotated));
    expect(rotate).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ variant: "destructive" })
    );
  });

  it("labels expiry and link reasons for people", () => {
    expect(formatPageExpiry(null)).toBeNull();
    expect(formatPageExpiry(new Date(0).toISOString())).toBe("Expired");
    expect(pagePreviewLinkReason("access_unsupported")).toBe("Daemon update required");
    expect(pagePreviewLinkReason("unknown")).toBe("Unavailable");
  });
});
