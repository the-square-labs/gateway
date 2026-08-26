import { useEffect, useState } from "react";
import type { ScopeSelectionFilter } from "@/components/common/ScopeSearchFilter";
import { cn } from "@/lib/utils";
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

interface ResourceOption {
  id: string;
  label: string;
  parentId?: string;
  folderId?: string | null;
  depth?: number;
  kind?: "container" | "deployment";
}

interface FolderOption {
  id: string;
  label: string;
  family: FolderFamily;
  ancestorIds: string[];
}

type FolderFamily =
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

interface DockerResourceOption {
  id: string;
  nodeId: string;
  label: string;
  kind: "container" | "deployment";
  folderId?: string | null;
}

interface ParsedScopedSelections {
  baseScopes: string[];
  resources: Record<string, string[]>;
  exactBaseScopes: Set<string>;
}

type RestrictionRow =
  | { type: "folder"; key: string; folder: FolderOption; depth: 0 | 1 }
  | { type: "resource"; key: string; resource: ResourceOption; depth: 0 | 1 | 2 };

function folderTarget(folderId: string) {
  return `${FOLDER_TARGET_PREFIX}${folderId}`;
}

function isFolderTarget(value: string) {
  return value.startsWith(FOLDER_TARGET_PREFIX);
}

function folderFamilyForScope(scope: string): FolderFamily | null {
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

function flattenFolderTree(
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

async function loadFolderFamily(family: FolderFamily): Promise<FolderOption[]> {
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

interface ScopeListProps {
  scopes: readonly ScopeItem[];
  search: string;
  selected: string[];
  onToggle: (scope: string) => void;
  resources?: Record<string, string[]>;
  onToggleResource?: (scope: string, resourceId: string) => void;
  cas?: CA[];
  nodes?: Node[];
  proxyHosts?: ProxyHost[];
  databases?: DatabaseConnection[];
  loggingSchemas?: LoggingSchema[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  inheritedScopes?: string[];
  inheritedFromName?: string;
  readOnly?: boolean;
  viewportClassName?: string;
  selectionFilter?: ScopeSelectionFilter;
}

function matchesQuery(scope: ScopeItem, q: string): boolean {
  return (
    scope.label.toLowerCase().includes(q) ||
    scope.value.toLowerCase().includes(q) ||
    scope.desc.toLowerCase().includes(q)
  );
}

function parseScopedSelections(
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
function getResourceOptions(
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

function getResourceLabel(scope: string): string {
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

export function ScopeList({
  scopes,
  search,
  selected,
  onToggle,
  resources,
  onToggleResource,
  cas,
  nodes,
  proxyHosts,
  databases,
  loggingSchemas,
  restrictableScopes,
  allowedResourceIds,
  inheritedScopes,
  inheritedFromName,
  readOnly,
  viewportClassName,
  selectionFilter = "all",
}: ScopeListProps) {
  const [dockerResources, setDockerResources] = useState<DockerResourceOption[]>([]);
  const [dockerRegistryRepositories, setDockerRegistryRepositories] = useState<string[]>([]);
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [domainResources, setDomainResources] = useState<Domain[]>([]);
  const [loggingEnvironments, setLoggingEnvironments] = useState<LoggingEnvironment[]>([]);
  const q = search.toLowerCase().trim();
  const inheritedParsed = parseScopedSelections(inheritedScopes ?? [], restrictableScopes ?? []);
  const inheritedBaseSet = new Set(inheritedParsed.baseScopes);
  const isSelected = (scope: ScopeItem) =>
    selected.includes(scope.value) || inheritedBaseSet.has(scope.value);
  const selectionFilteredScopes = scopes.filter((scope) => {
    if (selectionFilter === "selected") return isSelected(scope);
    if (selectionFilter === "unselected") return !isSelected(scope);
    return true;
  });
  const directMatches = q ? selectionFilteredScopes.filter((scope) => matchesQuery(scope, q)) : [];
  const visibleScopes = q
    ? directMatches.length > 0
      ? directMatches
      : selectionFilteredScopes.filter((scope) => scope.group.toLowerCase().includes(q))
    : selectionFilteredScopes;
  const categories = [...new Set(visibleScopes.map((s) => s.group))];
  const folderFamiliesKey = [
    ...new Set(
      scopes
        .filter((scope) => selected.includes(scope.value) || inheritedBaseSet.has(scope.value))
        .map((scope) => folderFamilyForScope(scope.value))
        .filter(Boolean)
    ),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    const families = folderFamiliesKey
      .split(",")
      .filter((family): family is FolderFamily => family.length > 0);
    if (families.length === 0) {
      setFolderOptions([]);
      return;
    }
    let cancelled = false;
    void Promise.all(families.map(loadFolderFamily)).then((options) => {
      if (!cancelled) setFolderOptions(options.flat());
    });
    if (families.includes("domains")) {
      void api
        .listDomains({ limit: 200 })
        .then((response) => {
          if (!cancelled) setDomainResources(response.data ?? []);
        })
        .catch(() => {
          if (!cancelled) setDomainResources([]);
        });
    } else {
      setDomainResources([]);
    }
    if (families.includes("logging-environments")) {
      void api
        .listLoggingEnvironments()
        .then((items) => {
          if (!cancelled) setLoggingEnvironments(items ?? []);
        })
        .catch(() => {
          if (!cancelled) setLoggingEnvironments([]);
        });
    } else {
      setLoggingEnvironments([]);
    }
    return () => {
      cancelled = true;
    };
  }, [folderFamiliesKey]);

  useEffect(() => {
    const dockerNodes = (nodes ?? []).filter((node) => node.type === "docker");
    const needsDockerResources = scopes.some(
      (scope) =>
        scope.value.startsWith("docker:containers:") &&
        scope.value !== "docker:containers:create" &&
        restrictableScopes?.includes(scope.value)
    );
    if (!needsDockerResources || dockerNodes.length === 0) {
      setDockerResources([]);
      return;
    }

    let cancelled = false;
    void Promise.all(
      dockerNodes.map(async (node) => {
        const containers = await api.listDockerContainers(node.id).catch(() => []);
        return containers.flatMap((resource) =>
          resource.scopeResourceId
            ? [
                {
                  id: resource.scopeResourceId,
                  nodeId: node.id,
                  label: resource.name,
                  folderId: resource.folderId,
                  kind:
                    resource.kind === "deployment"
                      ? ("deployment" as const)
                      : ("container" as const),
                },
              ]
            : []
        );
      })
    ).then((resourcesByNode) => {
      if (!cancelled) setDockerResources(resourcesByNode.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [nodes, restrictableScopes, scopes]);

  useEffect(() => {
    const needsRepositories = scopes.some(
      (scope) =>
        scope.value.startsWith("docker:registries:internal:") &&
        restrictableScopes?.includes(scope.value)
    );
    if (!needsRepositories) {
      setDockerRegistryRepositories([]);
      return;
    }
    let cancelled = false;
    void api
      .listDockerInternalRegistryRepositories()
      .then((repositories) => {
        if (!cancelled) setDockerRegistryRepositories(repositories);
      })
      .catch(() => {
        if (!cancelled) setDockerRegistryRepositories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [restrictableScopes, scopes]);

  return (
    <div className={cn("max-sm:max-h-[40vh] max-sm:overflow-y-auto", viewportClassName)}>
      {categories.map((cat) => {
        const catScopes = visibleScopes.filter((s) => s.group === cat);
        if (catScopes.length === 0) return null;
        return (
          <div key={cat}>
            {cat && (
              <div className="px-3 py-1.5 bg-muted sticky top-0 z-10 border-b border-border">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {cat}
                </p>
              </div>
            )}
            {catScopes.map((scope) => (
              <ScopeRow
                key={scope.value}
                scope={scope}
                isSelected={selected.includes(scope.value) || inheritedBaseSet.has(scope.value)}
                isOwnSelected={selected.includes(scope.value)}
                onToggle={onToggle}
                muted={false}
                disabled={readOnly}
                resources={resources}
                inheritedResources={inheritedParsed.resources}
                inheritedExactBase={inheritedParsed.exactBaseScopes.has(scope.value)}
                onToggleResource={onToggleResource}
                cas={cas}
                nodes={nodes}
                proxyHosts={proxyHosts}
                databases={databases}
                domains={domainResources}
                loggingEnvironments={loggingEnvironments}
                loggingSchemas={loggingSchemas}
                dockerResources={dockerResources}
                dockerRegistryRepositories={dockerRegistryRepositories}
                folderOptions={folderOptions}
                restrictableScopes={restrictableScopes}
                allowedResourceIds={allowedResourceIds}
                inheritedFromName={inheritedFromName}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ScopeRow({
  scope,
  isSelected,
  isOwnSelected,
  onToggle,
  muted,
  disabled,
  resources,
  inheritedResources,
  inheritedExactBase,
  onToggleResource,
  cas,
  nodes,
  proxyHosts,
  databases,
  domains,
  loggingEnvironments,
  loggingSchemas,
  dockerResources,
  dockerRegistryRepositories,
  folderOptions,
  restrictableScopes,
  allowedResourceIds,
  inheritedFromName,
}: {
  scope: ScopeItem;
  isSelected: boolean;
  isOwnSelected: boolean;
  onToggle: (scope: string) => void;
  muted: boolean;
  disabled?: boolean;
  resources?: Record<string, string[]>;
  inheritedResources?: Record<string, string[]>;
  inheritedExactBase?: boolean;
  onToggleResource?: (scope: string, resourceId: string) => void;
  cas?: CA[];
  nodes?: Node[];
  proxyHosts?: ProxyHost[];
  databases?: DatabaseConnection[];
  domains?: Domain[];
  loggingEnvironments?: LoggingEnvironment[];
  loggingSchemas?: LoggingSchema[];
  dockerResources?: DockerResourceOption[];
  dockerRegistryRepositories?: string[];
  folderOptions?: FolderOption[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  inheritedFromName?: string;
}) {
  const isRestrictable = restrictableScopes?.includes(scope.value) ?? false;
  const selectedIds = resources?.[scope.value] || [];
  const inheritedSelectedIds = inheritedResources?.[scope.value] || [];
  const inheritedSet = new Set(inheritedSelectedIds);
  const combinedSelectedIds = [...new Set([...inheritedSelectedIds, ...selectedIds])];
  const selectedResourceIds = combinedSelectedIds.filter((id) => !isFolderTarget(id));
  const family = folderFamilyForScope(scope.value);
  const baseResourceOptions = isRestrictable
    ? getResourceOptions(
        scope.value,
        cas,
        nodes,
        proxyHosts,
        databases,
        domains,
        loggingEnvironments,
        loggingSchemas,
        dockerResources,
        dockerRegistryRepositories
      )
    : [];
  const allowedIds = allowedResourceIds?.[scope.value];
  const resourceOptions = allowedIds
    ? baseResourceOptions.filter(
        (opt) =>
          allowedIds.includes(opt.id) ||
          (!!opt.parentId && allowedIds.includes(opt.parentId)) ||
          (!opt.parentId &&
            baseResourceOptions.some(
              (child) => child.parentId === opt.id && allowedIds.includes(child.id)
            ))
      )
    : [...baseResourceOptions];
  for (const allowedId of allowedIds ?? []) {
    if (!resourceOptions.some((opt) => opt.id === allowedId)) {
      resourceOptions.push({ id: allowedId, label: allowedId });
    }
  }
  for (const selectedId of selectedResourceIds) {
    if (!resourceOptions.some((opt) => opt.id === selectedId)) {
      resourceOptions.push({ id: selectedId, label: selectedId });
    }
  }
  const availableFolderOptions = (folderOptions ?? []).filter((folder) => folder.family === family);
  const visibleFolderOptions = allowedIds
    ? availableFolderOptions.filter((folder) => allowedIds.includes(folderTarget(folder.id)))
    : availableFolderOptions;
  const restrictionRows: RestrictionRow[] = [];
  if (family === "docker") {
    const nodeOptions = resourceOptions.filter((option) => !option.parentId);
    const childOptions = resourceOptions.filter((option) => !!option.parentId);
    const renderedFolderIds = new Set<string>();
    for (const node of nodeOptions) {
      restrictionRows.push({ type: "resource", key: node.id, resource: node, depth: 0 });
      const nodeChildren = childOptions.filter((option) => option.parentId === node.id);
      for (const folder of visibleFolderOptions) {
        const folderChildren = nodeChildren.filter((option) => option.folderId === folder.id);
        const hasNestedChildren = nodeChildren.some((option) => {
          const resourceFolder = option.folderId
            ? availableFolderOptions.find((candidate) => candidate.id === option.folderId)
            : undefined;
          return resourceFolder?.ancestorIds.includes(folder.id);
        });
        if (folderChildren.length === 0 && !hasNestedChildren) continue;
        restrictionRows.push({
          type: "folder",
          key: `${node.id}:${folder.id}`,
          folder,
          depth: 1,
        });
        renderedFolderIds.add(folder.id);
        for (const resource of folderChildren) {
          restrictionRows.push({
            type: "resource",
            key: resource.id,
            resource,
            depth: 2,
          });
        }
      }
      for (const resource of nodeChildren.filter((option) => !option.folderId)) {
        restrictionRows.push({
          type: "resource",
          key: resource.id,
          resource,
          depth: 1,
        });
      }
    }
    for (const folder of visibleFolderOptions.filter(
      (option) => !renderedFolderIds.has(option.id)
    )) {
      restrictionRows.push({ type: "folder", key: folder.id, folder, depth: 0 });
    }
  } else {
    for (const folder of visibleFolderOptions) {
      restrictionRows.push({ type: "folder", key: folder.id, folder, depth: 0 });
      for (const resource of resourceOptions.filter((option) => option.folderId === folder.id)) {
        restrictionRows.push({
          type: "resource",
          key: resource.id,
          resource,
          depth: 1,
        });
      }
    }
    for (const resource of resourceOptions.filter((option) => !option.folderId)) {
      restrictionRows.push({ type: "resource", key: resource.id, resource, depth: 0 });
    }
  }
  const showRestrictions =
    isRestrictable &&
    (resourceOptions.length > 0 || visibleFolderOptions.length > 0) &&
    (isSelected || combinedSelectedIds.length > 0) &&
    (!disabled || combinedSelectedIds.length > 0);
  const baseLocked = (!!inheritedExactBase || inheritedSelectedIds.length > 0) && !isOwnSelected;
  const rowDisabled = disabled || baseLocked;
  const showTechnicalValue = !scope.hideValue && scope.value !== scope.label;
  const showDescription = scope.desc !== scope.label && scope.desc !== scope.value;

  return (
    <div className={cn(muted && "opacity-40")}>
      <label
        className={cn(
          "flex items-center gap-3 px-3 py-2",
          rowDisabled ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent",
          disabled && "opacity-60"
        )}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => !rowDisabled && onToggle(scope.value)}
          disabled={rowDisabled}
          className="form-checkbox"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm">{scope.label}</p>
            {showTechnicalValue && (
              <p className="text-[10px] text-muted-foreground font-mono">{scope.value}</p>
            )}
            {baseLocked && inheritedFromName && (
              <p className="text-[10px] text-muted-foreground">
                inherited from {inheritedFromName}
              </p>
            )}
          </div>
          {showDescription && <p className="text-xs text-muted-foreground">{scope.desc}</p>}
        </div>
        {scope.meta && <span className="text-xs text-muted-foreground">{scope.meta}</span>}
      </label>
      {showRestrictions && (
        <div className="px-3 pb-2 pl-10">
          <p className="text-xs text-muted-foreground mb-1">{getResourceLabel(scope.value)}</p>
          {restrictionRows.map((row) => {
            if (row.type === "resource") {
              const opt = row.resource;
              const parentSelected = !!opt.parentId && combinedSelectedIds.includes(opt.parentId);
              const parentInherited = !!opt.parentId && inheritedSet.has(opt.parentId);
              const resourceFolder = opt.folderId
                ? availableFolderOptions.find((folder) => folder.id === opt.folderId)
                : undefined;
              const folderTargets = resourceFolder
                ? [resourceFolder.id, ...resourceFolder.ancestorIds].map(folderTarget)
                : [];
              const folderSelected = folderTargets.some((target) =>
                combinedSelectedIds.includes(target)
              );
              const folderInherited = folderTargets.some((target) => inheritedSet.has(target));
              const contextOnly = !!allowedIds && !allowedIds.includes(opt.id);
              const optionDisabled = !!disabled || parentSelected || folderSelected || contextOnly;
              return (
                <label
                  key={row.key}
                  className={cn(
                    "flex items-center gap-2 py-0.5 text-xs",
                    row.depth === 1 && "pl-5",
                    row.depth === 2 && "pl-10",
                    optionDisabled ? "cursor-default opacity-60" : "cursor-pointer"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={
                      parentSelected || folderSelected || combinedSelectedIds.includes(opt.id)
                    }
                    onChange={() =>
                      !optionDisabled &&
                      !inheritedSet.has(opt.id) &&
                      onToggleResource?.(scope.value, opt.id)
                    }
                    disabled={optionDisabled || inheritedSet.has(opt.id) || !onToggleResource}
                    className="form-checkbox"
                  />
                  <span>{opt.label}</span>
                  {opt.kind && (
                    <span className="text-[10px] text-muted-foreground">{opt.kind}</span>
                  )}
                  {(inheritedSet.has(opt.id) || parentInherited || folderInherited) &&
                    inheritedFromName && (
                      <span className="text-[10px] text-muted-foreground">inherited</span>
                    )}
                </label>
              );
            }

            const folder = row.folder;
            const target = folderTarget(folder.id);
            const inherited = inheritedSet.has(target);
            const parentSelected = folder.ancestorIds.some((id) =>
              combinedSelectedIds.includes(folderTarget(id))
            );
            return (
              <label
                key={row.key}
                className={cn(
                  "flex items-center gap-2 py-0.5 text-xs",
                  row.depth === 1 && "pl-5",
                  disabled || parentSelected ? "cursor-default opacity-60" : "cursor-pointer"
                )}
              >
                <input
                  type="checkbox"
                  checked={parentSelected || combinedSelectedIds.includes(target)}
                  onChange={() =>
                    !disabled &&
                    !parentSelected &&
                    !inherited &&
                    onToggleResource?.(scope.value, target)
                  }
                  disabled={disabled || parentSelected || inherited || !onToggleResource}
                  className="form-checkbox"
                />
                <span>{folder.label}</span>
                <span className="text-[10px] text-muted-foreground">folder</span>
                {inherited && inheritedFromName && (
                  <span className="text-[10px] text-muted-foreground">inherited</span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
