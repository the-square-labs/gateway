import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { ManagedObjectStorageCatalogEntry, ManagedObjectStorageCreateInput } from "@/types";
import { defaultManagedStorageDraft, ManagedObjectStorageCreateForm, Storage } from "./Storage";
import { canDeployManagedStorage } from "./storage-detail/managed-storage-capacity";

vi.mock("@/components/common/FolderedResourceList", () => ({
  FolderedResourceList: ({ resources = [] }: { resources?: Array<{ name: string }> }) => (
    <div data-testid="storage-list">{resources.map((row) => row.name).join(", ")}</div>
  ),
}));
vi.mock("@/lib/managed-database-nodes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/managed-database-nodes")>()),
  listManagedDatabaseCandidateNodes: vi.fn().mockResolvedValue([]),
}));

const CATALOG: ManagedObjectStorageCatalogEntry[] = [
  { type: "minio", versions: ["2025-04-22"] },
  { type: "seaweedfs", versions: ["4.47"] },
];
const CAPACITY = { maxStorageGb: 64, maxCpuCores: 4, maxMemoryMb: 4096, maxSwapMb: 0 };

function Form({
  step,
  catalog = CATALOG,
  initial = {},
}: {
  step: 1 | 2 | 3;
  catalog?: ManagedObjectStorageCatalogEntry[];
  initial?: Partial<ManagedObjectStorageCreateInput>;
}) {
  const [draft, setDraft] = useState<ManagedObjectStorageCreateInput>({
    ...defaultManagedStorageDraft(catalog),
    name: "App Storage",
    nodeId: "n1",
    ...initial,
  });
  return (
    <ManagedObjectStorageCreateForm
      draft={draft}
      nodes={[]}
      catalog={catalog}
      capacity={CAPACITY}
      step={step}
      onChange={setDraft}
    />
  );
}

describe("managed storage create defaults", () => {
  it("creates SeaweedFS clusters on the catalog version without legacy MinIO options", () => {
    const draft = defaultManagedStorageDraft(CATALOG);
    expect(draft).toMatchObject({ engine: "seaweedfs", version: "4.47", memoryMb: 1024 });
    for (const key of ["memberNodeIds", "drivesPerNode", "sftpEnabled", "ftpEnabled"]) {
      expect(draft).not.toHaveProperty(key);
    }
  });

  it("never falls back to a version that is not a catalog key", () => {
    expect(defaultManagedStorageDraft([]).version).toBe("");
    expect(defaultManagedStorageDraft([{ type: "minio", versions: ["2025-04-22"] }]).version).toBe(
      ""
    );
  });

  it("requires 512 MB of memory", () => {
    const draft = { ...defaultManagedStorageDraft(CATALOG), name: "App Storage", nodeId: "n1" };
    expect(canDeployManagedStorage({ ...draft, memoryMb: 256 }, ["4.47"], CAPACITY)).toBe(false);
    expect(canDeployManagedStorage({ ...draft, memoryMb: 511 }, ["4.47"], CAPACITY)).toBe(false);
    expect(canDeployManagedStorage({ ...draft, memoryMb: 512 }, ["4.47"], CAPACITY)).toBe(true);
  });
});

describe("managed storage create wizard", () => {
  it("offers only SeaweedFS versions and no distributed mode", () => {
    render(<Form step={1} />);
    expect(screen.getByLabelText("Engine version")).toHaveTextContent("SeaweedFS 4.47");
    expect(screen.getByText("New clusters run SeaweedFS on a single Storage node.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Distributed cluster" })).not.toBeInTheDocument();
    expect(screen.queryByText(/2025-04-22/)).not.toBeInTheDocument();
  });

  it("explains a catalog without SeaweedFS instead of offering a MinIO release", () => {
    render(<Form step={1} catalog={[{ type: "minio", versions: ["2025-04-22"] }]} />);
    expect(
      screen.getByText(
        "The storage catalog lists no SeaweedFS version yet. Refresh the page and try again."
      )
    ).toBeVisible();
    expect(screen.queryByText(/2025-04-22/)).not.toBeInTheDocument();
  });

  it("uses the SeaweedFS memory minimum", () => {
    render(<Form step={2} />);
    expect(screen.getByLabelText("Memory (MB)")).toHaveAttribute("min", "512");
  });

  it("hides FTP and SFTP and preserves the entered S3 port", () => {
    render(<Form step={3} />);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    const port = screen.getByRole("spinbutton", { name: "S3 API port" });
    expect(port).toHaveValue(9000);
    fireEvent.change(port, { target: { value: "9001" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    expect(screen.queryByRole("spinbutton", { name: "S3 API port" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    expect(screen.getByRole("spinbutton", { name: "S3 API port" })).toHaveValue(9001);
    expect(screen.getByRole("button", { name: "TLS" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SFTP access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "FTP access" })).not.toBeInTheDocument();
    expect(screen.queryByText(/FTPS/)).not.toBeInTheDocument();
  });
});

describe("managed storage create dialog", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["storage:view", "storage:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCached").mockReturnValue(undefined);
    vi.spyOn(api, "setCache").mockImplementation(() => undefined);
    vi.spyOn(api, "listObjectStorages").mockResolvedValue({ data: [] } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("selects the catalog version when the catalog arrives after the wizard opened", async () => {
    let resolveCatalog!: (catalog: ManagedObjectStorageCatalogEntry[]) => void;
    vi.spyOn(api, "listManagedObjectStorageCatalog").mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      })
    );
    render(
      <MemoryRouter>
        <Storage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Deploy managed storage" })[0]!);
    const version = await screen.findByLabelText("Engine version");
    expect(version).not.toHaveTextContent("RELEASE.");
    resolveCatalog(CATALOG);
    await waitFor(() => expect(version).toHaveTextContent("SeaweedFS 4.47"));
  });
});

describe("storage list with folder grants", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a server-listed connection the cached scopes do not name yet and refreshes them", async () => {
    const folderGrant = "storage:view:folder/11111111-1111-4111-8111-111111111111";
    useAuthStore.setState({
      user: makeUser({ scopes: [folderGrant] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCached").mockReturnValue(undefined);
    vi.spyOn(api, "setCache").mockImplementation(() => undefined);
    vi.spyOn(api, "listManagedObjectStorageCatalog").mockResolvedValue([]);
    // A colleague created "team-bucket" in the granted folder after this session loaded its scopes.
    vi.spyOn(api, "listObjectStorages").mockResolvedValue({
      data: [{ id: "storage-new", name: "team-bucket" }],
    } as never);
    const getCurrentUser = vi
      .spyOn(api, "getCurrentUser")
      .mockResolvedValue(makeUser({ scopes: [folderGrant, "storage:view:storage-new"] }));

    render(
      <MemoryRouter>
        <Storage />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByTestId("storage-list")).toHaveTextContent("team-bucket")
    );
    await waitFor(() =>
      expect(useAuthStore.getState().user?.scopes).toContain("storage:view:storage-new")
    );
    expect(getCurrentUser).toHaveBeenCalled();
  });
});
