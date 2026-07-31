import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { CA, DatabaseConnection, LoggingSchema, Node, ProxyHost } from "@/types";

export interface ScopeItem {
  value: string;
  label: string;
  desc: string;
  group: string;
}

interface ResourceOption {
  id: string;
  label: string;
  parentId?: string;
  depth?: number;
  kind?: "container" | "deployment";
}

interface DockerResourceOption {
  id: string;
  nodeId: string;
  label: string;
  kind: "container" | "deployment";
}

interface ParsedScopedSelections {
  baseScopes: string[];
  resources: Record<string, string[]>;
  exactBaseScopes: Set<string>;
}

interface ScopeListProps {
  scopes: readonly ScopeItem[];
  search: string;
  selected: string[];
  onToggle: (scope: string) => void;
  /** Resource restrictions per scope (e.g. cert:issue → [ca-id-1, ca-id-2]) */
  resources?: Record<string, string[]>;
  onToggleResource?: (scope: string, resourceId: string) => void;
  cas?: CA[];
  nodes?: Node[];
  proxyHosts?: ProxyHost[];
  databases?: DatabaseConnection[];
  loggingSchemas?: LoggingSchema[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  /** Inherited scopes from parent group — shown as read-only checked at bottom */
  inheritedScopes?: string[];
  inheritedFromName?: string;
  /** When true, all scopes are shown as non-interactive (view only) */
  readOnly?: boolean;
  viewportClassName?: string;
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
  loggingSchemas?: LoggingSchema[],
  dockerResources?: DockerResourceOption[]
): ResourceOption[] {
  if (scope.startsWith("logs:schemas:")) {
    return (loggingSchemas ?? []).map((schema) => ({ id: schema.id, label: schema.name }));
  }
  if (scope.startsWith("databases:")) {
    return (databases ?? []).map((database) => ({
      id: database.id,
      label: `${database.name} (${database.host}:${database.port})`,
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
            depth: 1,
            kind: resource.kind,
          })),
      ]);
  }
  if (scope.startsWith("docker:")) {
    return (nodes ?? [])
      .filter((n) => n.type === "docker")
      .map((n) => ({ id: n.id, label: n.displayName || n.hostname, depth: 0 }));
  }
  if (scope.startsWith("nodes:")) {
    return (nodes ?? []).map((n) => ({ id: n.id, label: n.displayName || n.hostname }));
  }
  if (scope.startsWith("proxy:")) {
    return (proxyHosts ?? []).map((p) => ({ id: p.id, label: p.domainNames[0] || p.id }));
  }
  if (scope.startsWith("pki:cert:") || scope.startsWith("pki:ca:")) {
    return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
  }
  return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
}

function getResourceLabel(scope: string): string {
  if (scope.startsWith("databases:")) {
    return "Restrict to specific databases (leave unchecked for all):";
  }
  if (scope.startsWith("docker:")) {
    return scope.startsWith("docker:containers:") && scope !== "docker:containers:create"
      ? "Restrict to Docker nodes or individual containers and deployments (leave unchecked for all):"
      : "Restrict to specific Docker nodes (leave unchecked for all):";
  }
  if (scope.startsWith("nodes:")) return "Restrict to specific nodes (leave unchecked for all):";
  if (scope.startsWith("proxy:"))
    return "Restrict to specific proxy hosts (leave unchecked for all):";
  if (scope.startsWith("logs:schemas:"))
    return "Restrict to specific logging schemas (leave unchecked for all):";
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
}: ScopeListProps) {
  const [dockerResources, setDockerResources] = useState<DockerResourceOption[]>([]);
  const q = search.toLowerCase().trim();
  const inheritedParsed = parseScopedSelections(inheritedScopes ?? [], restrictableScopes ?? []);
  const inheritedBaseSet = new Set(inheritedParsed.baseScopes);
  const categories = [...new Set(scopes.map((s) => s.group))];

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

  // When searching: split into matches (top) and rest (muted below)
  if (q) {
    const matches = scopes.filter((s) => matchesQuery(s, q));
    const rest = scopes.filter((s) => !matchesQuery(s, q));

    return (
      <div className={cn("max-sm:max-h-[40vh] max-sm:overflow-y-auto", viewportClassName)}>
        {matches.map((scope) => (
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
            loggingSchemas={loggingSchemas}
            dockerResources={dockerResources}
            restrictableScopes={restrictableScopes}
            allowedResourceIds={allowedResourceIds}
            inheritedFromName={inheritedFromName}
          />
        ))}
        {rest.length > 0 && matches.length > 0 && <div className="border-t border-border" />}
        {rest.map((scope) => (
          <ScopeRow
            key={scope.value}
            scope={scope}
            isSelected={selected.includes(scope.value) || inheritedBaseSet.has(scope.value)}
            isOwnSelected={selected.includes(scope.value)}
            onToggle={onToggle}
            muted
            disabled={readOnly}
            resources={resources}
            inheritedResources={inheritedParsed.resources}
            inheritedExactBase={inheritedParsed.exactBaseScopes.has(scope.value)}
            onToggleResource={onToggleResource}
            cas={cas}
            nodes={nodes}
            proxyHosts={proxyHosts}
            databases={databases}
            loggingSchemas={loggingSchemas}
            dockerResources={dockerResources}
            restrictableScopes={restrictableScopes}
            allowedResourceIds={allowedResourceIds}
            inheritedFromName={inheritedFromName}
          />
        ))}
      </div>
    );
  }

  // No search: render grouped by category
  return (
    <div className={cn("max-sm:max-h-[40vh] max-sm:overflow-y-auto", viewportClassName)}>
      {categories.map((cat) => {
        const catScopes = scopes.filter((s) => s.group === cat);
        if (catScopes.length === 0) return null;
        return (
          <div key={cat}>
            <div className="px-3 py-1.5 bg-muted sticky top-0 z-10 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {cat}
              </p>
            </div>
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
                loggingSchemas={loggingSchemas}
                dockerResources={dockerResources}
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
  loggingSchemas,
  dockerResources,
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
  loggingSchemas?: LoggingSchema[];
  dockerResources?: DockerResourceOption[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  inheritedFromName?: string;
}) {
  const isRestrictable = restrictableScopes?.includes(scope.value) ?? false;
  const selectedIds = resources?.[scope.value] || [];
  const inheritedSelectedIds = inheritedResources?.[scope.value] || [];
  const inheritedSet = new Set(inheritedSelectedIds);
  const combinedSelectedIds = [...new Set([...inheritedSelectedIds, ...selectedIds])];
  const baseResourceOptions = isRestrictable
    ? getResourceOptions(
        scope.value,
        cas,
        nodes,
        proxyHosts,
        databases,
        loggingSchemas,
        dockerResources
      )
    : [];
  const allowedIds = allowedResourceIds?.[scope.value];
  const resourceOptions = allowedIds
    ? baseResourceOptions.filter(
        (opt) =>
          allowedIds.includes(opt.id) || (!!opt.parentId && allowedIds.includes(opt.parentId))
      )
    : [...baseResourceOptions];
  for (const allowedId of allowedIds ?? []) {
    if (!resourceOptions.some((opt) => opt.id === allowedId)) {
      resourceOptions.push({ id: allowedId, label: allowedId });
    }
  }
  for (const selectedId of combinedSelectedIds) {
    if (!resourceOptions.some((opt) => opt.id === selectedId)) {
      resourceOptions.push({ id: selectedId, label: selectedId });
    }
  }
  const showRestrictions =
    isRestrictable &&
    resourceOptions.length > 0 &&
    (isSelected || combinedSelectedIds.length > 0) &&
    (!disabled || combinedSelectedIds.length > 0);
  const baseLocked = (!!inheritedExactBase || inheritedSelectedIds.length > 0) && !isOwnSelected;
  const rowDisabled = disabled || baseLocked;
  const showTechnicalValue = scope.value !== scope.label;
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
      </label>
      {showRestrictions && (
        <div className="px-3 pb-2 pl-10">
          <p className="text-xs text-muted-foreground mb-1">{getResourceLabel(scope.value)}</p>
          {resourceOptions.map((opt) => {
            const parentSelected = !!opt.parentId && combinedSelectedIds.includes(opt.parentId);
            const parentInherited = !!opt.parentId && inheritedSet.has(opt.parentId);
            return (
              <label
                key={opt.id}
                className={cn(
                  "flex items-center gap-2 py-0.5 text-xs",
                  opt.depth === 1 && "pl-5",
                  disabled || parentSelected ? "cursor-default opacity-60" : "cursor-pointer"
                )}
              >
                <input
                  type="checkbox"
                  checked={parentSelected || combinedSelectedIds.includes(opt.id)}
                  onChange={() =>
                    !disabled &&
                    !parentSelected &&
                    !inheritedSet.has(opt.id) &&
                    onToggleResource?.(scope.value, opt.id)
                  }
                  disabled={
                    disabled || parentSelected || inheritedSet.has(opt.id) || !onToggleResource
                  }
                  className="form-checkbox"
                />
                <span>{opt.label}</span>
                {opt.kind && <span className="text-[10px] text-muted-foreground">{opt.kind}</span>}
                {(inheritedSet.has(opt.id) || parentInherited) && inheritedFromName && (
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
