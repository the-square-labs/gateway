import { api } from "@/services/api";
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

const FOLDER_TARGET_PREFIX = "folder/";
const FOLDER_SCOPABLE_SET = new Set<string>(FOLDER_SCOPABLE_SCOPES);

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

export interface FolderOption {
  id: string;
  label: string;
  family: FolderFamily;
  ancestorIds: string[];
}

export type FolderFamily =
  | "domains"
  | "proxy"
  | "nodes"
  | "docker"
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
  if (scope.startsWith("domains:")) return "domains";
  if (scope.startsWith("proxy:")) return "proxy";
  if (scope.startsWith("nodes:")) return "nodes";
  if (scope.startsWith("docker:containers:")) return "docker";
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
  const load = async (promise: Promise<FolderTreeLike[]>) => promise.catch(() => []);
  switch (family) {
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
  dockerRegistryRepositories?: string[]
): ResourceOption[] {
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
    return (databases ?? []).map((database) => ({
      id: database.id,
      label: `${database.name} (${database.host}:${database.port})`,
      folderId: database.folderId,
    }));
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
    return (proxyHosts ?? []).map((p) => ({
      id: p.id,
      label: p.domainNames[0] || p.id,
      folderId: p.folderId,
    }));
  }
  if (scope.startsWith("pki:cert:") || scope.startsWith("pki:ca:")) {
    return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
  }
  return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
}

export function getResourceLabel(scope: string): string {
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
    return scope.startsWith("docker:containers:") && scope !== "docker:containers:create"
      ? "Restrict to Docker nodes or individual containers and deployments (leave unchecked for all):"
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
