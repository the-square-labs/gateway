import { useEffect, useState } from "react";
import type { ScopeSelectionFilter } from "@/components/common/ScopeSearchFilter";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  CA,
  DatabaseConnection,
  Domain,
  LoggingEnvironment,
  LoggingSchema,
  Node,
  ProxyHost,
} from "@/types";
import {
  type DockerResourceOption,
  type FolderFamily,
  type FolderOption,
  folderFamilyForScope,
  folderTarget,
  getResourceLabel,
  getResourceOptions,
  isFolderTarget,
  loadFolderFamily,
  matchesQuery,
  parseScopedSelections,
  type RestrictionRow,
  type ScopeItem,
} from "./scope-list-helpers";

export type { ScopeItem } from "./scope-list-helpers";

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
