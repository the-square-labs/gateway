import { api } from "@/services/api";
import type { GitScopeProvider, GitScopeTargetResolution } from "@/types/integrations";
import { GIT_CONNECTOR_SCOPES, GIT_TARGET_SCOPES } from "@/types/scope-resource-restrictions";
import { canLoadScopeResource, reportScopeLoadError } from "./scope-list-helpers";

export type { GitScopeProvider } from "@/types/integrations";

/**
 * Git integration scope qualifiers (see the rc.11 contract). IDs are stable provider IDs:
 * - `<connectorId>`: every repository of that connector;
 * - GitLab `<connectorId>/group/<groupId>` (the group, its subgroups and their projects)
 *   and `<connectorId>/project/<projectId>`;
 * - GitHub `<connectorId>/owner/<ownerId>` (every repository of the owner) and
 *   `<connectorId>/repo/<repoId>`;
 * - generic Git: connectors only.
 */
export type GitTargetKind = "group" | "project" | "owner" | "repo";

export interface GitQualifier {
  connectorId: string;
  /** null for a connector-wide qualifier. */
  kind: GitTargetKind | null;
  targetId: string | null;
}

export interface GitScopeConnector {
  id: string;
  name: string;
}

/** Connectors per provider; a provider is absent when its connectors could not be listed. */
export type GitScopeConnectorCatalog = Partial<Record<GitScopeProvider, GitScopeConnector[]>>;

export interface GitTargetLabel {
  /** Group path, project path, owner login or repository full name. */
  label: string;
  missing: boolean;
}

/** Resolved labels keyed by {@link gitLabelKey}. */
export type GitTargetLabels = Readonly<Record<string, GitTargetLabel>>;

/** One option of the scope-target picker. */
export interface GitScopeTargetOption {
  kind: GitTargetKind;
  id: string;
  /** Group path, project path, owner login or repository full name. */
  path: string;
  detail?: string;
}

const GIT_TARGET_SCOPE_SET = new Set<string>(GIT_TARGET_SCOPES);
const GIT_CONNECTOR_SCOPE_SET = new Set<string>(GIT_CONNECTOR_SCOPES);
const TARGET_KINDS = new Set<string>(["group", "project", "owner", "repo"]);
const RESOLVE_BATCH_SIZE = 50;

export const GIT_PROVIDER_LABELS: Record<GitScopeProvider, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  git: "Git",
};

export const GIT_TARGET_KIND_LABELS: Record<GitTargetKind, string> = {
  group: "group",
  project: "project",
  owner: "owner",
  repo: "repository",
};

/** The two target kinds a provider's picker offers: container first, then repositories. */
export const GIT_PROVIDER_TARGET_KINDS: Record<GitScopeProvider, readonly GitTargetKind[]> = {
  gitlab: ["group", "project"],
  github: ["owner", "repo"],
  git: [],
};

/** Picker wording per provider, for example "groups or projects". */
export const GIT_PROVIDER_TARGET_NOUNS: Record<GitScopeProvider, string> = {
  gitlab: "groups or projects",
  github: "owners or repositories",
  git: "connectors",
};

/** The provider of a Git scope that connector qualifiers can limit. */
export function gitScopeProvider(scope: string): GitScopeProvider | null {
  if (!GIT_TARGET_SCOPE_SET.has(scope) && !GIT_CONNECTOR_SCOPE_SET.has(scope)) return null;
  const provider = scope.split(":")[1];
  return provider === "gitlab" || provider === "github" || provider === "git" ? provider : null;
}

/**
 * Target kinds a Git scope takes within a connector: GitLab groups and projects, GitHub owners
 * and repositories; none for generic Git and for connector administration (`manage`).
 */
export function gitScopeTargetKinds(scope: string): readonly GitTargetKind[] {
  const provider = gitScopeProvider(scope);
  return provider && GIT_TARGET_SCOPE_SET.has(scope) ? GIT_PROVIDER_TARGET_KINDS[provider] : [];
}

export function parseGitQualifier(value: string): GitQualifier | null {
  const parts = value.split("/");
  if (parts.length === 1 && parts[0]) return { connectorId: parts[0], kind: null, targetId: null };
  if (parts.length === 3 && parts[0] && parts[2] && TARGET_KINDS.has(parts[1]!)) {
    return { connectorId: parts[0], kind: parts[1] as GitTargetKind, targetId: parts[2] };
  }
  return null;
}

export function gitQualifier(connectorId: string, kind?: GitTargetKind, targetId?: string) {
  return kind && targetId ? `${connectorId}/${kind}/${targetId}` : connectorId;
}

export function gitLabelKey(provider: GitScopeProvider, qualifier: string) {
  return `${provider}:${qualifier}`;
}

/** Whether a group or owner at `ancestorPath` contains the target at `path`. */
function pathWithin(path: string, ancestorPath: string) {
  return path.toLowerCase().startsWith(`${ancestorPath.toLowerCase()}/`);
}

/**
 * Whether `qualifiers` include the target itself or something containing it: its connector,
 * or (by path, as far as labels are known) a GitLab group above it or its GitHub owner.
 */
export function gitTargetCovered(
  target: { connectorId: string; qualifier: string; path: string | null },
  qualifiers: readonly string[],
  pathOf: (qualifier: string) => string | null
): boolean {
  return qualifiers.some((qualifier) => {
    if (qualifier === target.qualifier || qualifier === target.connectorId) return true;
    const parsed = parseGitQualifier(qualifier);
    if (!parsed || parsed.connectorId !== target.connectorId) return false;
    if (parsed.kind !== "group" && parsed.kind !== "owner") return false;
    const ancestorPath = pathOf(qualifier);
    return !!ancestorPath && !!target.path && pathWithin(target.path, ancestorPath);
  });
}

/** Readable text for a stored qualifier; unresolvable ones say so and keep their ID. */
export function gitQualifierLabel(
  provider: GitScopeProvider,
  qualifier: string,
  connectors: readonly GitScopeConnector[] | undefined,
  labels: GitTargetLabels
): string {
  const parsed = parseGitQualifier(qualifier);
  if (!parsed) return qualifier;
  if (!parsed.kind) {
    const connector = connectors?.find((candidate) => candidate.id === parsed.connectorId);
    if (connector) return connector.name;
    // Without a connector list nothing says whether it still exists.
    return connectors ? `Unavailable (id ${parsed.connectorId})` : parsed.connectorId;
  }
  const entry = labels[gitLabelKey(provider, qualifier)];
  if (entry?.missing) return `Unavailable (id ${parsed.targetId})`;
  if (entry) return entry.label;
  return `${GIT_TARGET_KIND_LABELS[parsed.kind]} ${parsed.targetId}`;
}

export function canLoadGitScopeTargets(provider: GitScopeProvider) {
  return canLoadScopeResource(`integrations:${provider}:view`);
}

/** Lists the connectors of each provider the actor may view. */
export async function loadGitScopeConnectors(
  providers: readonly GitScopeProvider[]
): Promise<GitScopeConnectorCatalog> {
  const catalog: GitScopeConnectorCatalog = {};
  await Promise.all(
    providers.filter(canLoadGitScopeTargets).map(async (provider) => {
      try {
        const connectors =
          provider === "gitlab"
            ? await api.listGitLabConnectors()
            : await api.listGitConnectors(provider);
        catalog[provider] = (connectors ?? []).map((connector) => ({
          id: connector.id,
          name: connector.name,
        }));
      } catch (error) {
        reportScopeLoadError(`${GIT_PROVIDER_LABELS[provider]} connectors`, error);
      }
    })
  );
  return catalog;
}

export interface GitTargetLabelResolution {
  labels: Record<string, GitTargetLabel>;
  /** Label keys whose lookup failed (other than the connector being gone). */
  failedKeys: string[];
  errors: unknown[];
}

/**
 * Resolves labels for qualifiers (`<connectorId>/<kind>/<id>`) of one provider, one request per
 * connector. Qualifiers the API does not return, and those of a connector that no longer
 * exists, are reported missing.
 */
export async function resolveGitTargetLabels(
  provider: GitScopeProvider,
  qualifiers: readonly string[]
): Promise<GitTargetLabelResolution> {
  const byConnector = new Map<string, string[]>();
  for (const qualifier of qualifiers) {
    const parsed = parseGitQualifier(qualifier);
    if (!parsed?.kind) continue;
    const relative = `${parsed.kind}/${parsed.targetId}`;
    byConnector.set(parsed.connectorId, [...(byConnector.get(parsed.connectorId) ?? []), relative]);
  }
  const resolution: GitTargetLabelResolution = { labels: {}, failedKeys: [], errors: [] };
  await Promise.all(
    [...byConnector].flatMap(([connectorId, relatives]) =>
      chunk(relatives, RESOLVE_BATCH_SIZE).map(async (batch) => {
        const keyOf = (relative: string) => gitLabelKey(provider, `${connectorId}/${relative}`);
        let items: GitScopeTargetResolution[];
        try {
          items = await api.resolveGitScopeTargets(provider, connectorId, batch);
        } catch (error) {
          if (errorStatus(error) === 404) {
            for (const relative of batch) {
              resolution.labels[keyOf(relative)] = { label: "", missing: true };
            }
            return;
          }
          resolution.failedKeys.push(...batch.map(keyOf));
          resolution.errors.push(error);
          return;
        }
        const byQualifier = new Map(items.map((item) => [item.qualifier, item]));
        for (const relative of batch) {
          const item = byQualifier.get(relative);
          resolution.labels[keyOf(relative)] =
            item && !item.missing
              ? { label: item.label, missing: false }
              : { label: item?.label ?? "", missing: true };
        }
      })
    )
  );
  return resolution;
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" ? (error as { status?: number }).status : undefined;
}

/** Searches the targets of one connector for the picker. */
export async function searchGitScopeTargets(
  provider: GitScopeProvider,
  connectorId: string,
  search: string
): Promise<GitScopeTargetOption[]> {
  if (provider === "gitlab") {
    const result = await api.searchGitLabScopeTargets(connectorId, search);
    return [
      ...result.groups.map((group) => ({
        kind: "group" as const,
        id: String(group.id),
        path: group.fullPath,
      })),
      ...result.projects.map((project) => ({
        kind: "project" as const,
        id: String(project.id),
        path: project.pathWithNamespace,
      })),
    ];
  }
  if (provider === "github") {
    const result = await api.searchGitHubScopeTargets(connectorId, search);
    return [
      ...result.owners.map((owner) => ({
        kind: "owner" as const,
        id: String(owner.id),
        path: owner.login,
        detail: owner.type === "Organization" ? "organization" : "user",
      })),
      ...result.repos.map((repo) => ({
        kind: "repo" as const,
        id: String(repo.id),
        path: repo.fullName,
      })),
    ];
  }
  return [];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
