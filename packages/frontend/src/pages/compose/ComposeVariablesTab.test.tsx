import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerComposeProject, DockerSourceBinding } from "@/types";
import { ComposeVariablesTab } from "./ComposeVariablesTab";

const linkProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../docker-detail/ManagedDatabaseLinksSection", () => ({
  ManagedDatabaseLinksSection: (props: Record<string, unknown>) => {
    linkProps.current = props;
    return null;
  },
}));
vi.mock("../docker-detail/EnvironmentTab", () => ({ EnvironmentTab: () => null }));

function project(overrides: Partial<DockerComposeProject>): DockerComposeProject {
  return {
    id: "project-1",
    nodeId: "node-1",
    name: "shop",
    managementState: "managed",
    status: "stopped",
    activeRevision: null,
    services: [],
    volumeNames: [],
    networkNames: [],
    ...overrides,
  } as DockerComposeProject;
}

afterEach(() => {
  vi.restoreAllMocks();
  linkProps.current = null;
});

describe("Compose links before the first revision", () => {
  it("lets a Git project be linked to the services of its source's Compose file", async () => {
    const getSource = vi
      .spyOn(api, "getDockerSource")
      .mockResolvedValue({ composeServiceNames: ["api", "worker"] } as DockerSourceBinding);

    render(<ComposeVariablesTab project={project({})} canManage onApplied={vi.fn()} />);

    await waitFor(() =>
      expect(linkProps.current?.composeServices).toEqual([
        { name: "api", existingVariableNames: [] },
        { name: "worker", existingVariableNames: [] },
      ])
    );
    expect(getSource).toHaveBeenCalledWith({
      kind: "compose_project",
      nodeId: "node-1",
      composeProjectId: "project-1",
    });
    expect(linkProps.current).toMatchObject({ disabled: false, composeBeforeFirstRevision: true });
  });

  it("stays enabled for a typed service when the source has not resolved its Compose file", async () => {
    vi.spyOn(api, "getDockerSource").mockResolvedValue(null);

    render(<ComposeVariablesTab project={project({})} canManage onApplied={vi.fn()} />);

    await waitFor(() => expect(api.getDockerSource).toHaveBeenCalled());
    expect(linkProps.current).toMatchObject({
      disabled: false,
      composeBeforeFirstRevision: true,
      composeServices: [],
    });
  });

  it("keeps an external project without a revision unlinkable", () => {
    const getSource = vi.spyOn(api, "getDockerSource");

    render(
      <ComposeVariablesTab
        project={project({ managementState: "external" })}
        canManage
        onApplied={vi.fn()}
      />
    );

    expect(linkProps.current).toMatchObject({ disabled: true, composeBeforeFirstRevision: false });
    expect(getSource).not.toHaveBeenCalled();
  });
});
