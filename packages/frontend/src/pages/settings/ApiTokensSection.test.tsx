import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTokensSection } from "@/pages/settings/ApiTokensSection";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { Node, User } from "@/types";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

const FOLDER_ID = "0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e";
const FOLDER_SCOPE = `docker:containers:manage:folder/${FOLDER_ID}`;
// Effective scopes as the backend returns them: the folder grant plus the containers it covers.
const USER = {
  id: "user-1",
  scopes: ["nodes:details", FOLDER_SCOPE, "docker:containers:manage:node-1/c1"],
} as unknown as User;
const NODES = [
  { id: "node-1", type: "docker", hostname: "docker-1", displayName: "Docker 1" },
] as unknown as Node[];

beforeEach(() => {
  useAuthStore.setState({ user: USER });
  vi.spyOn(api, "listTokens").mockResolvedValue([]);
  vi.spyOn(api, "listDockerFolders").mockResolvedValue([
    { id: FOLDER_ID, name: "MyProject", children: [] },
  ] as never);
  vi.spyOn(api, "listDockerContainers").mockResolvedValue([
    { scopeResourceId: "c1", name: "web", folderId: FOLDER_ID, kind: "container" },
  ] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe("ApiTokensSection", () => {
  it("creates a token restricted to the user's Docker folder", async () => {
    const createToken = vi
      .spyOn(api, "createToken")
      .mockResolvedValue({ token: "gw_secret" } as never);

    render(
      <ApiTokensSection
        user={USER}
        nodesList={NODES}
        proxyHostsList={[]}
        databasesList={[]}
        loggingSchemasList={[]}
      />
    );

    await userEvent.click(await screen.findByRole("button", { name: /Create Token/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByPlaceholderText(/CI\/CD Pipeline/i), "Folder bot");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Manage Containers/i }));

    // A folder-only user must restrict the scope; the folder and its container are preselected.
    expect(await within(dialog).findByRole("checkbox", { name: /MyProject/ })).toBeChecked();
    expect(within(dialog).getByText("2 scopes")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /^Create Token$/i }));

    expect(createToken).toHaveBeenCalledWith({
      name: "Folder bot",
      scopes: [FOLDER_SCOPE, "docker:containers:manage:node-1/c1"],
    });
  });
});
