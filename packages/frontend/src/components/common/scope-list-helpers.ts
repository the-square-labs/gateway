import { toast } from "sonner";
import { extractBaseScope, hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import {
  type CA,
  type DatabaseConnection,
  type Domain,
  FOLDER_SCOPABLE_SCOPES,
  type LoggingEnvironment,
  type LoggingSchema,
  type Node,
  type ProxyHost,
} from "@/types";
import { FOLDER_CREATION_SCOPES } from "@/types/scope-resource-restrictions";

const FOLDER_TARGET_PREFIX = "folder/";
const FOLDER_SCOPABLE_SET = new Set<string>(FOLDER_SCOPABLE_SCOPES);
const CREATION_SCOPES = new Set<string>(FOLDER_CREATION_SCOPES);

export interface ScopeItem {
  value: string;
  label: string;
  desc: string;
  group: string;
  hideValue?: boolean;
  meta?: string;
}

export interface ResourceOption {
  id: string;
  label: string;
  parentId?: string;
  folderId?: string | null;
  depth?: number;
  kind?: "container" | "deployment";
}

export type ScopeResourceCatalog = Partial<Record<string, ResourceOption[]>>;

export function reportScopeLoadError(resource: string, error: unknown) {
  // Feature/permission changes can race a lookup. These are not load failures.
  if (error && typeof error === "object") {
    const { code, status } = error as { code?: string; status?: number };
    if (
      status === 403 ||
      [
        "FORBIDDEN",
        "LOGGING_DISABLED",
        "PKI_DISABLED",
        "DOMAINS_DISABLED",
        "FEATURE_DISABLED",
      ].includes(code ?? "")
    )
      return;
  }
  toast.error(`Could not load ${resource} for permission restrictions`, {
    id: `scope-load-${resource}`,
    description: error instanceof Error ? error.message : undefined,
  });
}

export function canLoadScopeResource(permission: string, nodeId?: string): boolean {
  const features = useSystemConfigStore.getState().config.features;
  if (permission.startsWith("logs:") && !features.loggingEnabled) return false;
  if (permission.startsWith("domains:") && !features.domainsEnabled) return false;
  if (permission.startsWith("pki:") && !features.pkiEnabled) return false;
  const scopes = useAuthStore.getState().user?.scopes ?? [];
  const alternatives =
    permission === "pki:ca:view"
      ? ["pki:ca:view:root", "pki:ca:view:intermediate"]
      : permission.startsWith("logs:")
        ? [permission, "logs:manage"]
        : [permission];
  if (!alternatives.some((base) => hasScopeBase(scopes, base))) return false;
  if (!nodeId || scopeMatches(scopes, permission)) return true;
  return (
    scopeMatches(scopes, `${permission}:${nodeId}`) ||
    scopeMatches(scopes, `${permission}:node/${nodeId}`) ||
    scopes.some((scope) => {
      const base = extractBaseScope(scope);
      if (base === scope) return false;
      const target = scope.slice(base.length + 1);
      // Folder membership is resolved by the API. The node inventory is already
      // access-filtered, and its resource endpoint returns only permitted items.
      return (
        (target.startsWith("folder/") || target.startsWith(`${nodeId}/`)) &&
        scopeMatches([scope], `${permission}:${target}`)
      );
    })
  );
}

export async function loadScopeResourceList<T>(
  permission: string,
  load: () => Promise<T[]>
): Promise<T[]> {
  return canLoadScopeResource(permission) ? load() : [];
}

const folderLookupPermissions: Partial<Record<FolderFamily, string>> = {
  groups: "admin:groups",
  users: "admin:users",
  domains: "domains:view",
  proxy: "proxy:view",
  nodes: "nodes:details",
  databases: "databases:view",
  pages: "pages:view",
  ssl: "ssl:cert:view",
  "logging-environments": "logs:environments:view",
  "logging-schemas": "logs:schemas:view",
  docker: "docker:containers:view",
  "docker-network": "docker:networks:view",
  "docker-volume": "docker:volumes:view",
  "docker-image": "docker:images:view",
  "docker-compose": "docker:compose:view",
};

export async function allResourcePages<T>(
  load: (
    page: number
  ) => Promise<{ data: T[]; pagination?: { totalPages: number }; totalPages?: number }>
): Promise<T[]> {
  const resources: T[] = [];
  for (let page = 1; ; page++) {
    const result = await load(page);
    resources.push(...result.data);
    if (!result.data.length || page >= (result.pagination?.totalPages ?? result.totalPages ?? 1))
      return resources;
  }
}

export async function loadScopeResourceCatalog(
  scopes: readonly ScopeItem[],
  nodes: readonly Node[]
): Promise<ScopeResourceCatalog> {
  const families = new Set(
    scopes
      .map((scope) => folderFamilyForScope(scope.value))
      .filter(
        (family) =>
          family &&
          (!folderLookupPermissions[family] ||
            canLoadScopeResource(folderLookupPermissions[family]!))
      )
  );
  const catalog: ScopeResourceCatalog = {};
  const nodeOptions = (kind: string) =>
    nodes
      .filter((node) => node.type === kind)
      .map((node) => ({
        id: `node/${node.id}`,
        label: node.displayName || node.hostname,
      }));
  const loads: Promise<void>[] = [];
  if (families.has("groups"))
    loads.push(
      api
        .listGroups()
        .then((groups) => {
          catalog.groups = groups.map((group) => ({
            id: group.id,
            label: group.name,
            folderId: group.folderId,
          }));
        })
        .catch((error) => {
          reportScopeLoadError("groups", error);
          catalog.groups = [];
        })
    );
  if (families.has("users"))
    loads.push(
      api
        .listUsers()
        .then((users) => {
          catalog.users = users.map((user) => ({
            id: user.id,
            label: user.name || user.email,
            folderId: user.folderId,
          }));
        })
        .catch((error) => {
          reportScopeLoadError("users", error);
          catalog.users = [];
        })
    );
  if (families.has("pages"))
    loads.push(
      (async () => {
        const projects = await allResourcePages((page) =>
          api.listPageProjects({ page, limit: 100 })
        );
        catalog.pages = [
          ...nodeOptions("nginx"),
          ...projects.map((project) => ({
            id: project.id,
            label: project.name,
            folderId: project.folderId,
          })),
        ];
      })().catch((error) => {
        reportScopeLoadError("Pages projects", error);
        catalog.pages = [];
      })
    );
  if (families.has("ssl"))
    loads.push(
      (async () => {
        const certs = await allResourcePages((page) =>
          api.listSSLCertificates({ page, limit: 100 })
        );
        catalog.ssl = certs.map((cert) => ({
          id: cert.id,
          label: cert.name,
          folderId: cert.folderId,
        }));
      })().catch((error) => {
        reportScopeLoadError("SSL certificates", error);
        catalog.ssl = [];
      })
    );
  if (
    canLoadScopeResource("integrations:hosting:view") &&
    scopes.some(
      ({ value }) => value.startsWith("hosting:") || value.startsWith("integrations:hosting:")
    )
  ) {
    loads.push(
      api
        .listHostingConnectors()
        .then((accounts) => {
          catalog.hosting = [
            ...[...new Set(accounts.map((account) => account.provider))].map((provider) => ({
              id: `provider/${provider}`,
              label: `${provider} (all accounts)`,
            })),
            ...accounts.map((account) => ({
              id: `account/${account.id}`,
              label: `${account.name} (${account.provider})`,
            })),
          ];
        })
        .catch((error) => {
          reportScopeLoadError("hosting accounts", error);
          catalog.hosting = [];
        })
    );
  }
  for (const [family, type] of [
    ["docker-network", "network"],
    ["docker-volume", "volume"],
    ["docker-image", "image"],
    ["docker-compose", "compose"],
  ] as const) {
    if (!families.has(family)) continue;
    loads.push(
      (async () => {
        const resources = await Promise.all(
          nodes
            .filter(
              (node) =>
                node.type === "docker" &&
                canLoadScopeResource(folderLookupPermissions[family]!, node.id)
            )
            .map(async (node) => {
              const parent = { id: node.id, label: node.displayName || node.hostname };
              try {
                const children: ResourceOption[] =
                  type === "network"
                    ? (await api.listDockerNetworks(node.id)).flatMap((row) =>
                        row.scopeResourceId
                          ? [
                              {
                                id: `${node.id}/${row.scopeResourceId}`,
                                label: row.name,
                                parentId: node.id,
                                folderId: row.folderId,
                              },
                            ]
                          : []
                      )
                    : type === "volume"
                      ? (await api.listDockerVolumes(node.id)).map((row) => ({
                          id: `${node.id}/${row.name}`,
                          label: row.name,
                          parentId: node.id,
                          folderId: row.folderId,
                        }))
                      : type === "image"
                        ? (await api.listDockerImages(node.id)).map((row) => ({
                            id: `${node.id}/${row.id}`,
                            label: row.repoTags?.[0] ?? row.id,
                            parentId: node.id,
                            folderId: row.folderId,
                          }))
                        : (await api.listDockerComposeProjects(node.id)).map((row) => ({
                            id: `${node.id}/${row.id}`,
                            label: row.name,
                            parentId: node.id,
                            folderId: row.folderId,
                          }));
                return [parent, ...children];
              } catch (error) {
                reportScopeLoadError(`${type} resources on ${parent.label}`, error);
                return [parent];
              }
            })
        );
        catalog[family] = resources.flat();
      })().catch((error) => {
        reportScopeLoadError(family, error);
        catalog[family] = [];
      })
    );
  }
  await Promise.all(loads);
  return catalog;
}

export interface FolderOption {
  id: string;
  label: string;
  family: FolderFamily;
  ancestorIds: string[];
}

export type FolderFamily =
  | "groups"
  | "users"
  | "domains"
  | "proxy"
  | "nodes"
  | "docker"
  | "docker-network"
  | "docker-volume"
  | "docker-image"
  | "docker-compose"
  | "pages"
  | "ssl"
  | "databases"
  | "logging-environments"
  | "logging-schemas";

interface FolderTreeLike {
  id: string;
  name: string;
  children?: FolderTreeLike[];
}

export interface DockerResourceOption {
  id: string;
  nodeId: string;
  label: string;
  kind: "container" | "deployment";
  folderId?: string | null;
}

export interface ParsedScopedSelections {
  baseScopes: string[];
  resources: Record<string, string[]>;
  exactBaseScopes: Set<string>;
}

export type RestrictionRow =
  | { type: "folder"; key: string; folder: FolderOption; depth: 0 | 1 }
  | { type: "resource"; key: string; resource: ResourceOption; depth: 0 | 1 | 2 };

export function folderTarget(folderId: string) {
  return `${FOLDER_TARGET_PREFIX}${folderId}`;
}

export function isFolderTarget(value: string) {
  return value.startsWith(FOLDER_TARGET_PREFIX);
}

export function folderFamilyForScope(scope: string): FolderFamily | null {
  if (!FOLDER_SCOPABLE_SET.has(scope)) return null;
  if (scope === "admin:groups") return "groups";
  if (scope === "admin:users" || scope === "admin:users:impersonate") return "users";
  if (scope.startsWith("domains:")) return "domains";
  if (scope.startsWith("proxy:")) return "proxy";
  if (scope.startsWith("pages:")) return "pages";
  if (scope.startsWith("ssl:cert:")) return "ssl";
  if (scope.startsWith("nodes:")) return "nodes";
  if (scope.startsWith("docker:containers:")) return "docker";
  if (scope.startsWith("docker:networks:")) return "docker-network";
  if (scope.startsWith("docker:volumes:")) return "docker-volume";
  if (scope.startsWith("docker:images:")) return "docker-image";
  if (scope.startsWith("docker:compose:")) return "docker-compose";
  if (scope.startsWith("databases:")) return "databases";
  if (scope.startsWith("logs:schemas:")) return "logging-schemas";
  if (scope.startsWith("logs:environments:") || scope === "logs:read") {
    return "logging-environments";
  }
  return null;
}

export function flattenFolderTree(
  tree: FolderTreeLike[],
  family: FolderFamily,
  parentPath: string[] = [],
  ancestorIds: string[] = []
): FolderOption[] {
  return tree.flatMap((folder) => {
    const path = [...parentPath, folder.name];
    return [
      { id: folder.id, label: path.join("/"), family, ancestorIds },
      ...flattenFolderTree(folder.children ?? [], family, path, [...ancestorIds, folder.id]),
    ];
  });
}

export async function loadFolderFamily(family: FolderFamily): Promise<FolderOption[]> {
  const permission = folderLookupPermissions[family];
  const createPermission = FOLDER_CREATION_SCOPES.find(
    (scope) => folderFamilyForScope(scope) === family
  );
  const managePermission = family.startsWith("docker")
    ? "docker:containers:folders:manage"
    : permission?.replace(/:(view|details)$/, ":folders:manage");
  if (
    permission &&
    ![permission, createPermission, managePermission].some(
      (scope) => scope && canLoadScopeResource(scope)
    )
  )
    return [];
  const load = async (promise: Promise<FolderTreeLike[]>) =>
    promise.catch((error) => {
      reportScopeLoadError(`${family} folders`, error);
      return [];
    });
  switch (family) {
    case "groups":
      return flattenFolderTree(await load(api.listAdminGroupFolders()), family);
    case "users":
      return flattenFolderTree(await load(api.listAdminUserFolders()), family);
    case "domains":
      return flattenFolderTree(await load(api.listDomainFolders()), family);
    case "proxy":
      return flattenFolderTree(await load(api.listFolders()), family);
    case "nodes":
      return flattenFolderTree(await load(api.listNodeFolders()), family);
    case "databases":
      return flattenFolderTree(await load(api.listDatabaseFolders()), family);
    case "logging-environments":
      return flattenFolderTree(await load(api.listLoggingEnvironmentFolders()), family);
    case "logging-schemas":
      return flattenFolderTree(await load(api.listLoggingSchemaFolders()), family);
    case "docker":
      return flattenFolderTree(await load(api.listDockerFolders("container")), family);
    case "docker-network":
      return flattenFolderTree(await load(api.listDockerFolders("network")), family);
    case "docker-volume":
      return flattenFolderTree(await load(api.listDockerFolders("volume")), family);
    case "docker-image":
      return flattenFolderTree(await load(api.listDockerFolders("image")), family);
    case "docker-compose":
      return flattenFolderTree(await load(api.listDockerFolders("compose")), family);
    case "pages":
      return flattenFolderTree(await load(api.listPageProjectFolders()), family);
    case "ssl":
      return flattenFolderTree(await load(api.listSSLCertificateFolders()), family);
  }
}

export function matchesQuery(scope: ScopeItem, q: string): boolean {
  return (
    scope.label.toLowerCase().includes(q) ||
    scope.value.toLowerCase().includes(q) ||
    scope.desc.toLowerCase().includes(q)
  );
}

export function parseScopedSelections(
  values: string[],
  restrictableScopes: readonly string[] = []
): ParsedScopedSelections {
  const baseScopes: string[] = [];
  const resources: Record<string, string[]> = {};
  const exactBaseScopes = new Set<string>();
  const sortedRestrictableScopes = [...restrictableScopes].sort((a, b) => b.length - a.length);
  const restrictableScopeSet = new Set<string>(restrictableScopes);

  for (const value of values) {
    if (restrictableScopeSet.has(value)) {
      if (!baseScopes.includes(value)) baseScopes.push(value);
      exactBaseScopes.add(value);
      continue;
    }

    let matchedBase: string | null = null;
    for (const base of sortedRestrictableScopes) {
      if (value.startsWith(`${base}:`)) {
        matchedBase = base;
        const resourceId = value.slice(base.length + 1);
        if (!baseScopes.includes(base)) baseScopes.push(base);
        if (!resources[base]) resources[base] = [];
        if (!resources[base].includes(resourceId)) resources[base].push(resourceId);
        break;
      }
    }

    if (matchedBase) continue;
    if (!baseScopes.includes(value)) baseScopes.push(value);
    exactBaseScopes.add(value);
  }

  return { baseScopes, resources, exactBaseScopes };
}

/** Determine which resource list to show for a scope */
export function getResourceOptions(
  scope: string,
  cas?: CA[],
  nodes?: Node[],
  proxyHosts?: ProxyHost[],
  databases?: DatabaseConnection[],
  domains?: Domain[],
  loggingEnvironments?: LoggingEnvironment[],
  loggingSchemas?: LoggingSchema[],
  dockerResources?: DockerResourceOption[],
  dockerRegistryRepositories?: string[],
  catalog: ScopeResourceCatalog = {}
): ResourceOption[] {
  const family = folderFamilyForScope(scope);
  if (scope.startsWith("hosting:") || scope.startsWith("integrations:hosting:")) {
    const accountScope =
      scope.startsWith("integrations:") ||
      scope.startsWith("hosting:billing:") ||
      scope === "hosting:resources:create";
    return accountScope
      ? (catalog.hosting ?? [])
      : [
          ...(catalog.hosting ?? []),
          ...(nodes ?? []).map((node) => ({
            id: `node/${node.id}`,
            label: node.displayName || node.hostname,
          })),
        ];
  }
  if (CREATION_SCOPES.has(scope) && scope !== "ssl:cert:issue") {
    if (scope.startsWith("docker:"))
      return (nodes ?? [])
        .filter((node) => node.type === "docker")
        .map((node) => ({ id: node.id, label: node.displayName || node.hostname }));
    if (scope === "proxy:create" || scope === "pages:create" || scope === "databases:create") {
      return (nodes ?? [])
        .filter((node) => node.type === (scope === "databases:create" ? "databases" : "nginx"))
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname }));
    }
    return [];
  }
  if (family && catalog[family]) return catalog[family]!;
  if (scope.startsWith("logs:schemas:")) {
    return (loggingSchemas ?? []).map((schema) => ({
      id: schema.id,
      label: schema.name,
      folderId: schema.folderId,
    }));
  }
  if (scope.startsWith("logs:environments:") || scope === "logs:read") {
    return (loggingEnvironments ?? []).map((environment) => ({
      id: environment.id,
      label: environment.name,
      folderId: environment.folderId,
    }));
  }
  if (scope.startsWith("domains:")) {
    return (domains ?? []).map((domain) => ({
      id: domain.id,
      label: domain.domain,
      folderId: domain.folderId,
    }));
  }
  if (scope.startsWith("databases:")) {
    return [
      ...(nodes ?? [])
        .filter((node) => node.type === "databases")
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname })),
      ...(databases ?? []).map((database) => ({
        id: database.id,
        label: `${database.name} (${database.host}:${database.port})`,
        folderId: database.folderId,
      })),
    ];
  }
  if (scope.startsWith("docker:containers:") && scope !== "docker:containers:create") {
    return (nodes ?? [])
      .filter((n) => n.type === "docker")
      .flatMap((n) => [
        { id: n.id, label: n.displayName || n.hostname, depth: 0 },
        ...(dockerResources ?? [])
          .filter((resource) => resource.nodeId === n.id)
          .map((resource) => ({
            id: `${n.id}/${resource.id}`,
            label: resource.label,
            parentId: n.id,
            folderId: resource.folderId,
            depth: 1,
            kind: resource.kind,
          })),
      ]);
  }
  if (scope.startsWith("docker:registries:internal:")) {
    return (dockerRegistryRepositories ?? []).map((repository) => ({
      id: repository,
      label: repository,
    }));
  }
  if (scope.startsWith("docker:")) {
    return (nodes ?? [])
      .filter((n) => n.type === "docker")
      .map((n) => ({ id: n.id, label: n.displayName || n.hostname, depth: 0 }));
  }
  if (scope.startsWith("nodes:")) {
    return (nodes ?? []).map((n) => ({
      id: n.id,
      label: n.displayName || n.hostname,
      folderId: n.folderId,
    }));
  }
  if (scope === "proxy:create") {
    return (nodes ?? [])
      .filter((node) => node.type === "nginx")
      .map((node) => ({ id: node.id, label: node.displayName || node.hostname }));
  }
  if (scope.startsWith("proxy:")) {
    return [
      ...(nodes ?? [])
        .filter((node) => node.type === "nginx")
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname })),
      ...(proxyHosts ?? []).map((p) => ({
        id: p.id,
        label: p.domainNames[0] || p.id,
        folderId: p.folderId,
      })),
    ];
  }
  if (scope.startsWith("pki:cert:") || scope.startsWith("pki:ca:")) {
    return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
  }
  return [];
}

export function getResourceLabel(scope: string): string {
  if (scope === "admin:groups" || scope === "admin:users" || scope === "admin:users:impersonate")
    return "Restrict to folders or individual accounts/groups (creation requires a destination folder; leave unchecked for all):";
  if (scope.startsWith("hosting:") || scope.startsWith("integrations:hosting:")) {
    return scope.startsWith("integrations:") ||
      scope.startsWith("hosting:billing:") ||
      scope === "hosting:resources:create"
      ? "Restrict to providers or hosting accounts (leave unchecked for all):"
      : "Restrict to providers, hosting accounts or nodes (node access is also required; leave unchecked for all):";
  }
  if (CREATION_SCOPES.has(scope) && scope !== "ssl:cert:issue")
    return "Restrict creation to destination folders or nodes where applicable (leave unchecked for all):";
  if (scope.startsWith("pages:"))
    return "Restrict to nodes, Page Project folders or individual projects (leave unchecked for all):";
  if (scope.startsWith("ssl:cert:"))
    return "Restrict to certificate folders or individual certificates (leave unchecked for all):";
  if (scope.startsWith("domains:")) {
    return "Restrict to domain folders or individual domains (leave unchecked for all):";
  }
  if (scope.startsWith("databases:")) {
    return "Restrict to database folders or individual databases (leave unchecked for all):";
  }
  if (scope.startsWith("docker:registries:internal:")) {
    return "Restrict to specific internal registry repositories (leave unchecked for all):";
  }
  if (scope.startsWith("docker:")) {
    return folderFamilyForScope(scope)
      ? "Restrict to Docker nodes, folders or individual resources (leave unchecked for all):"
      : "Restrict to specific Docker nodes (leave unchecked for all):";
  }
  if (scope.startsWith("nodes:")) return "Restrict to specific nodes (leave unchecked for all):";
  if (scope === "proxy:create")
    return "Restrict to specific Ingress nodes (leave unchecked for all):";
  if (scope.startsWith("proxy:"))
    return "Restrict to route folders or individual routes (leave unchecked for all):";
  if (scope.startsWith("logs:schemas:"))
    return "Restrict to schema folders or individual logging schemas (leave unchecked for all):";
  if (scope.startsWith("logs:environments:") || scope === "logs:read")
    return "Restrict to environment folders or individual logging environments (leave unchecked for all):";
  return "Restrict to specific CAs (leave unchecked for all):";
}
