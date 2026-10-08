import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GitScopeConnectorCatalog,
  type GitTargetLabel,
  gitLabelKey,
  loadGitScopeConnectors,
  resolveGitTargetLabels,
} from "@/components/common/git-scope-targets";
import {
  allResourcePages,
  canLoadScopeResource,
  type FolderOption,
  loadFolderFamily,
  reportScopeLoadError,
} from "@/components/common/scope-list-helpers";
import { extractBaseScope } from "@/lib/scope-utils";
import { api } from "@/services/api";
import type { GitScopeProvider, Node } from "@/types";
import {
  ACCESS_TYPES,
  type AccessContext,
  type AccessLabels,
  type AccessTypeId,
  accessTypeScopes,
  GIT_TARGET_KINDS,
} from "./access-model";

/** One resource the "Specific resources" picker offers. */
export interface AccessResource {
  type: AccessTypeId;
  /** The ID scopes name (`<nodeId>/<resourceId>` for Docker). */
  id: string;
  label: string;
}

const PROVIDERS: readonly GitScopeProvider[] = ["gitlab", "github", "git"];
const TYPE_OF_SCOPE = new Map(
  ACCESS_TYPES.flatMap((type) => accessTypeScopes(type).map((scope) => [scope, type] as const))
);

async function list<T>(name: string, load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (error) {
    reportScopeLoadError(name, error);
    return [];
  }
}

/** The resources of the eight types the signed-in user can see. */
export async function loadAccessResources(): Promise<AccessResource[]> {
  const nodes = canLoadScopeResource("nodes:details")
    ? await list("nodes", () => allResourcePages((page) => api.listNodes({ page, limit: 100 })))
    : [];
  const dockerNodes = nodes.filter((node: Node) => node.type === "docker");
  const nodeLabel = (node: Node) => node.displayName || node.hostname;
  const loads: Promise<AccessResource[]>[] = [
    ...dockerNodes.map(async (node) =>
      canLoadScopeResource("docker:containers:view", node.id)
        ? (
            await list(`containers on ${nodeLabel(node)}`, () => api.listDockerContainers(node.id))
          ).flatMap((container) =>
            container.scopeResourceId
              ? [
                  {
                    type: "containers" as const,
                    id: `${node.id}/${container.scopeResourceId}`,
                    label: container.name,
                  },
                ]
              : []
          )
        : []
    ),
    ...dockerNodes.map(async (node) =>
      canLoadScopeResource("docker:compose:view", node.id)
        ? (
            await list(`Compose projects on ${nodeLabel(node)}`, () =>
              api.listDockerComposeProjects(node.id)
            )
          ).map((project) => ({
            type: "compose" as const,
            id: `${node.id}/${project.id}`,
            label: project.name,
          }))
        : []
    ),
    (async () =>
      canLoadScopeResource("proxy:view")
        ? (
            await list("routes", () =>
              allResourcePages((page) => api.listProxyHosts({ page, limit: 100 }))
            )
          ).map((host) => ({
            type: "routes" as const,
            id: host.id,
            label: host.domainNames[0] || host.id,
          }))
        : [])(),
    (async () =>
      canLoadScopeResource("domains:view")
        ? (
            await list("domains", () =>
              allResourcePages((page) => api.listDomains({ page, limit: 100 }))
            )
          ).map((domain) => ({ type: "domains" as const, id: domain.id, label: domain.domain }))
        : [])(),
    (async () =>
      canLoadScopeResource("ssl:cert:view")
        ? (
            await list("SSL certificates", () =>
              allResourcePages((page) => api.listSSLCertificates({ page, limit: 100 }))
            )
          ).map((cert) => ({ type: "ssl" as const, id: cert.id, label: cert.name }))
        : [])(),
    (async () =>
      canLoadScopeResource("databases:view")
        ? (
            await list("databases", () =>
              allResourcePages((page) => api.listDatabases({ page, limit: 100 }))
            )
          ).map((database) => ({
            type: "databases" as const,
            id: database.id,
            label: database.name,
          }))
        : [])(),
    (async () =>
      canLoadScopeResource("storage:view")
        ? (
            await list("storage", () =>
              allResourcePages((page) => api.listObjectStorages({ page, limit: 100 }))
            )
          ).map((storage) => ({ type: "storage" as const, id: storage.id, label: storage.name }))
        : [])(),
    (async () =>
      canLoadScopeResource("pages:view")
        ? (
            await list("Pages projects", () =>
              allResourcePages((page) => api.listPageProjects({ page, limit: 100 }))
            )
          ).map((project) => ({ type: "pages" as const, id: project.id, label: project.name }))
        : [])(),
  ];
  return (await Promise.all(loads)).flat();
}

/** Whether scopes name single resources of the eight types, so lines need their names. */
function namesResources(scopes: readonly string[]) {
  return scopes.some((scope) => {
    const base = extractBaseScope(scope);
    if (base === scope || !TYPE_OF_SCOPE.has(base)) return false;
    const qualifier = scope.slice(base.length + 1);
    return !qualifier.startsWith("folder/") && !qualifier.startsWith("node/");
  });
}

/** Git qualifiers of groups, owners, projects and repositories, per provider. */
function gitTargetQualifiers(scopes: readonly string[]) {
  const byProvider = new Map<GitScopeProvider, Set<string>>();
  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    const provider = base.split(":")[1] as GitScopeProvider;
    if (base === scope || !base.startsWith("integrations:") || !GIT_TARGET_KINDS[provider])
      continue;
    const qualifier = scope.slice(base.length + 1);
    if (qualifier.split("/").length !== 3) continue;
    byProvider.set(provider, new Set([...(byProvider.get(provider) ?? []), qualifier]));
  }
  return byProvider;
}

export interface AccessCatalog {
  /** The first load (folders, connectors, the names the lines need) has finished. */
  ready: boolean;
  ctx: AccessContext;
  labels: AccessLabels;
  gitConnectors: GitScopeConnectorCatalog;
  /** null until loaded; `loadResources` starts the load. */
  resources: AccessResource[] | null;
  loadResources: () => void;
  /** Keeps names of Git targets picked in Add Access. */
  rememberGitLabel: (provider: GitScopeProvider, qualifier: string, label: string) => void;
}

/**
 * What the access lines of an open dialog need: the folders of the eight types' trees, Git
 * connectors, and the names of resources and Git targets the given scopes mention.
 */
export function useAccessCatalog(open: boolean, scopes: readonly string[]): AccessCatalog {
  const [folders, setFolders] = useState<FolderOption[] | null>(null);
  const [gitConnectors, setGitConnectors] = useState<GitScopeConnectorCatalog | null>(null);
  const [gitLabels, setGitLabels] = useState<Record<string, GitTargetLabel>>({});
  const [gitLabelsReady, setGitLabelsReady] = useState(false);
  const [resources, setResources] = useState<AccessResource[] | null>(null);
  const resourcesRequested = useRef(false);
  const scopesKey = [...scopes].sort().join("\n");

  useEffect(() => {
    if (!open) {
      // Each opening loads current folders and resources again.
      setFolders(null);
      setGitConnectors(null);
      setResources(null);
      resourcesRequested.current = false;
      return;
    }
    let cancelled = false;
    void Promise.all(ACCESS_TYPES.map((type) => loadFolderFamily(type.family))).then((loaded) => {
      if (!cancelled) setFolders(loaded.flat());
    });
    void loadGitScopeConnectors(PROVIDERS).then((catalog) => {
      if (!cancelled) setGitConnectors(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const loadResources = useCallback(() => {
    if (resourcesRequested.current) return;
    resourcesRequested.current = true;
    void loadAccessResources().then(setResources);
  }, []);

  useEffect(() => {
    if (!open) return;
    const current = scopesKey ? scopesKey.split("\n") : [];
    if (namesResources(current)) loadResources();
    const byProvider = gitTargetQualifiers(current);
    if (byProvider.size === 0) {
      setGitLabelsReady(true);
      return;
    }
    let cancelled = false;
    setGitLabelsReady(false);
    void Promise.all(
      [...byProvider].map(([provider, qualifiers]) =>
        resolveGitTargetLabels(provider, [...qualifiers]).then(({ labels }) => labels)
      )
    )
      .then((results) => {
        if (!cancelled) setGitLabels((labels) => Object.assign({}, labels, ...results));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setGitLabelsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scopesKey, loadResources]);

  const ctx = useMemo<AccessContext>(() => ({ folders: folders ?? [] }), [folders]);
  const labels = useMemo<AccessLabels>(() => {
    const resourceNames = new Map(
      (resources ?? []).map((item) => [`${item.type}:${item.id}`, item.label])
    );
    return {
      resource: (type, id) => resourceNames.get(`${type}:${id}`),
      connector: (provider, connectorId) =>
        gitConnectors?.[provider]?.find((connector) => connector.id === connectorId)?.name,
      gitTarget: (provider, qualifier) => {
        const entry = gitLabels[gitLabelKey(provider, qualifier)];
        return entry && !entry.missing ? entry.label : undefined;
      },
    };
  }, [gitConnectors, gitLabels, resources]);

  const rememberGitLabel = useCallback(
    (provider: GitScopeProvider, qualifier: string, label: string) => {
      setGitLabels((current) => ({
        ...current,
        [gitLabelKey(provider, qualifier)]: { label, missing: false },
      }));
    },
    []
  );

  const needsResources = namesResources(scopesKey ? scopesKey.split("\n") : []);
  return {
    ready:
      folders !== null &&
      gitConnectors !== null &&
      gitLabelsReady &&
      (!needsResources || resources !== null),
    ctx,
    labels,
    gitConnectors: gitConnectors ?? {},
    resources,
    loadResources,
    rememberGitLabel,
  };
}
