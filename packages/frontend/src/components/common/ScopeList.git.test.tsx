import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildFinalScopes, deriveAllowedResourceIdsByScope } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { waitForReveal } from "@/test/reveal";
import type { GitHubScopeTargets, GitLabScopeTargets, GitScopeTargetResolution } from "@/types";
import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";
import { ScopeList } from "./ScopeList";

const GITLAB_USE = "integrations:gitlab:use";
const GITHUB_READ = "integrations:github:repo:read";
const GIT_WRITE = "integrations:git:repo:write";

const gitlabTargets: GitLabScopeTargets = {
  groups: [
    { id: "123", fullPath: "acme/platform", name: "Platform" },
    { id: "124", fullPath: "acme/platform/sub", name: "Sub" },
    { id: "200", fullPath: "acme/tools", name: "Tools" },
  ],
  projects: [
    { id: "456", pathWithNamespace: "acme/platform/api", name: "api" },
    { id: "789", pathWithNamespace: "acme/tools/cli", name: "cli" },
  ],
};

const githubTargets: GitHubScopeTargets = {
  owners: [{ id: "900", login: "acme", type: "Organization" }],
  repos: [
    { id: "1011", fullName: "acme/api" },
    { id: "1012", fullName: "octo/tool" },
  ],
};

function scopeItems(values: string[]) {
  return TOKEN_SCOPES.filter((scope) => values.includes(scope.value));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A consumer like the token and group editors: toggles scopes and qualifiers, shows the result. */
function Harness({
  scopes,
  initialSelected = scopes,
  initialResources = {},
  allowedResourceIds,
  collapsedRestrictions,
}: {
  scopes: string[];
  initialSelected?: string[];
  initialResources?: Record<string, string[]>;
  allowedResourceIds?: Record<string, string[]>;
  collapsedRestrictions?: boolean;
}) {
  const [selected, setSelected] = useState(initialSelected);
  const [resources, setResources] = useState(initialResources);
  return (
    <>
      <ScopeList
        scopes={scopeItems(scopes)}
        search=""
        selected={selected}
        onToggle={(scope) =>
          setSelected((current) =>
            current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]
          )
        }
        resources={resources}
        onToggleResource={(scope, id) =>
          setResources((current) => {
            const ids = current[scope] ?? [];
            return {
              ...current,
              [scope]: ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
            };
          })
        }
        restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
        allowedResourceIds={allowedResourceIds}
        collapsedRestrictions={collapsedRestrictions}
      />
      <output data-testid="final">{buildFinalScopes(selected, resources).join(" ")}</output>
    </>
  );
}

const finalScopes = () => screen.getByTestId("final").textContent?.split(" ").filter(Boolean);

describe("ScopeList Git restrictions", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "actor", scopes: TOKEN_SCOPES.map((scope) => scope.value) } as never,
    });
    vi.spyOn(api, "listGitLabConnectors").mockResolvedValue([
      { id: "gl-1", name: "Company GitLab" },
      { id: "gl-2", name: "Partner GitLab" },
    ] as never);
    vi.spyOn(api, "listGitConnectors").mockImplementation(async (provider) =>
      provider === "github"
        ? ([{ id: "gh-1", name: "GitHub Org" }] as never)
        : ([{ id: "git-1", name: "Internal Git" }] as never)
    );
    vi.spyOn(api, "searchGitLabScopeTargets").mockResolvedValue(gitlabTargets);
    vi.spyOn(api, "searchGitHubScopeTargets").mockResolvedValue(githubTargets);
    vi.spyOn(api, "resolveGitScopeTargets").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits a GitLab scope to a whole connector", async () => {
    render(<Harness scopes={[GITLAB_USE]} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /Company GitLab/ }));

    expect(finalScopes()).toEqual([`${GITLAB_USE}:gl-1`]);
    // The connector covers everything in it, so it is not narrowed further meanwhile.
    expect(
      screen.queryByRole("button", { name: /Add groups or projects from Company GitLab/ })
    ).not.toBeInTheDocument();
  });

  it("adds GitLab groups and projects from a debounced search", async () => {
    render(<Harness scopes={[GITLAB_USE]} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Add groups or projects from Company GitLab to Use GitLab System Credential",
      })
    );
    const search = await screen.findByRole("textbox", {
      name: "Search groups or projects in Company GitLab",
    });
    expect(await screen.findByRole("button", { name: /acme\/platform\/api/ })).toBeVisible();
    expect(api.searchGitLabScopeTargets).toHaveBeenCalledWith("gl-1", "");

    await userEvent.type(search, "acme");
    await waitFor(() => expect(api.searchGitLabScopeTargets).toHaveBeenCalledWith("gl-1", "acme"));
    const queries = vi.mocked(api.searchGitLabScopeTargets).mock.calls.map(([, query]) => query);
    expect(queries).toEqual(["", "acme"]);

    const groups = screen.getByRole("group", { name: "Groups" });
    await userEvent.click(within(groups).getByRole("button", { name: /^acme\/platform\s/ }));
    await userEvent.click(screen.getByRole("button", { name: /acme\/tools\/cli/ }));

    expect(finalScopes()).toEqual([
      `${GITLAB_USE}:gl-1/group/123`,
      `${GITLAB_USE}:gl-1/project/789`,
    ]);
    // Inside the chosen group, its projects are already covered.
    expect(screen.getByRole("button", { name: /acme\/platform\/api/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /acme\/platform\/api/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // Picked targets are listed under their connector with their paths, no lookup needed.
    expect(screen.getByRole("checkbox", { name: /acme\/platform group/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /acme\/tools\/cli project/ })).toBeChecked();
    expect(api.resolveGitScopeTargets).not.toHaveBeenCalled();
  });

  it("adds GitHub owners and repositories", async () => {
    render(<Harness scopes={[GITHUB_READ]} />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Add owners or repositories from GitHub Org to Read GitHub Repositories",
      })
    );
    await userEvent.click(await screen.findByRole("button", { name: /^acme organization/ }));
    await userEvent.click(screen.getByRole("button", { name: /octo\/tool/ }));

    expect(finalScopes()).toEqual([
      `${GITHUB_READ}:gh-1/owner/900`,
      `${GITHUB_READ}:gh-1/repo/1012`,
    ]);
    expect(screen.getByRole("button", { name: /acme\/api/ })).toBeDisabled();
  });

  it("offers only connectors for generic Git", async () => {
    render(<Harness scopes={[GIT_WRITE]} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /Internal Git/ }));

    expect(finalScopes()).toEqual([`${GIT_WRITE}:git-1`]);
    expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
    expect(api.resolveGitScopeTargets).not.toHaveBeenCalled();
  });

  it("limits connector administration to connectors only", async () => {
    render(<Harness scopes={["integrations:gitlab:manage"]} />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /Partner GitLab/ }));

    expect(finalScopes()).toEqual(["integrations:gitlab:manage:gl-2"]);
    expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
  });

  it("opens the dialog with resolved labels for stored qualifiers", async () => {
    const lookup = deferred<GitScopeTargetResolution[]>();
    vi.mocked(api.resolveGitScopeTargets).mockReturnValue(lookup.promise);

    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token</DialogTitle>
          </DialogHeader>
          <Harness
            scopes={[GITLAB_USE]}
            initialResources={{ [GITLAB_USE]: ["gl-1/group/123", "gl-1/project/999"] }}
          />
        </DialogContent>
      </Dialog>
    );

    await waitFor(() =>
      expect(api.resolveGitScopeTargets).toHaveBeenCalledWith("gitlab", "gl-1", [
        "group/123",
        "project/999",
      ])
    );
    expect(document.querySelector("[data-reveal-phase]")).not.toHaveAttribute(
      "data-reveal-phase",
      "revealed"
    );

    lookup.resolve([
      { qualifier: "group/123", label: "acme/platform", missing: false },
      { qualifier: "project/999", label: "", missing: true },
    ]);
    await waitForReveal();

    expect(screen.getByRole("checkbox", { name: /acme\/platform group/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Unavailable \(id 999\) project/ })).toBeChecked();
  });

  it("removes stored targets and connectors that no longer exist", async () => {
    vi.mocked(api.resolveGitScopeTargets).mockResolvedValue([
      { qualifier: "project/999", label: "", missing: true },
    ]);
    render(
      <Harness
        scopes={[GITLAB_USE]}
        initialResources={{ [GITLAB_USE]: ["gl-1/project/999", "gl-gone"] }}
      />
    );

    const missingProject = await screen.findByRole("checkbox", {
      name: /Unavailable \(id 999\) project/,
    });
    const missingConnector = screen.getByRole("checkbox", {
      name: /Unavailable \(id gl-gone\) connector/,
    });
    await userEvent.click(missingProject);
    await userEvent.click(missingConnector);

    expect(finalScopes()).toEqual([GITLAB_USE]);
    // Still listed, unchecked, so the removal can be undone in place.
    expect(
      screen.getByRole("checkbox", { name: /Unavailable \(id 999\) project/ })
    ).not.toBeChecked();
  });

  it("summarizes collapsed restrictions with readable labels", async () => {
    vi.mocked(api.resolveGitScopeTargets).mockResolvedValue([
      { qualifier: "repo/1011", label: "acme/api", missing: false },
    ]);
    render(
      <Harness
        scopes={[GITHUB_READ, GITLAB_USE]}
        initialResources={{ [GITHUB_READ]: ["gh-1/repo/1011"], [GITLAB_USE]: ["gl-1"] }}
        collapsedRestrictions
      />
    );

    expect(await screen.findByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText("Company GitLab")).toBeInTheDocument();
  });

  describe("bounded by the granting user's grant", () => {
    const actorScopes = [`${GITLAB_USE}:gl-1/group/123`];

    beforeEach(() => {
      useAuthStore.setState({ user: { id: "actor", scopes: actorScopes } as never });
      vi.mocked(api.resolveGitScopeTargets).mockResolvedValue([
        { qualifier: "group/123", label: "acme/platform", missing: false },
      ]);
    });

    it("offers only the held group, and targets inside it", async () => {
      render(
        <Harness
          scopes={[GITLAB_USE]}
          initialResources={{ [GITLAB_USE]: ["gl-1/group/123"] }}
          allowedResourceIds={deriveAllowedResourceIdsByScope(actorScopes)}
        />
      );

      const group = await screen.findByRole("checkbox", { name: /acme\/platform group/ });
      // The connector is context only; the other connector is not offered at all.
      expect(screen.getByRole("checkbox", { name: /Company GitLab/ })).toBeDisabled();
      expect(screen.queryByRole("checkbox", { name: /Partner GitLab/ })).not.toBeInTheDocument();

      await userEvent.click(group);
      await userEvent.click(
        screen.getByRole("button", { name: /Add groups or projects from Company GitLab/ })
      );
      expect(await screen.findByRole("button", { name: /acme\/platform\/api/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /acme\/platform\/sub/ })).toBeEnabled();
      expect(screen.queryByRole("button", { name: /acme\/tools/ })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /acme\/platform\/api/ }));
      expect(finalScopes()).toEqual([`${GITLAB_USE}:gl-1/project/456`]);
    });
  });
});
