/**
 * What a principal can reach, grouped by product area, for agents that must work inside folder-,
 * node- or resource-limited access instead of concluding they have none.
 *
 * `summarizeScopeGrants` is pure: it reads the principal's effective scopes (already expanded and,
 * for tokens and OAuth grants, bounded by the owner) and classifies every grant as broad or as limited
 * to a folder, node, account or resource. `access-summary-resolver.ts` adds names from the database.
 */

import { extractBaseScope } from './scopes.js';
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE } from './scopes-implications.js';

export type AccessTargetKind = 'folder' | 'node' | 'resource' | 'account';

/** Folder families list_resource_folders accepts. */
export type AccessFolderResourceType =
  | 'nodes'
  | 'databases'
  | 'storage'
  | 'domains'
  | 'ssl_certificates'
  | 'logging_environments'
  | 'logging_schemas'
  | 'admin_users'
  | 'permission_groups'
  | 'routes'
  | 'docker'
  | 'pages';

export type AccessDockerFolderType = 'container' | 'compose' | 'image' | 'volume' | 'network';

export interface AccessAreaDefinition {
  id: string;
  title: string;
  /** The action name of a base scope in this area, or null when the base belongs elsewhere. */
  action: (base: string) => string | null;
  /** Holding this scope unqualified means the caller sees every resource of the area. */
  viewScope?: string;
  /** The scope that authorizes creating a resource of this area (it names a destination). */
  createScope?: string;
  /** Docker qualifiers: a bare qualifier is a node, `<nodeId>/<resourceId>` a resource on that node. */
  dockerQualifiers?: boolean;
  /** Legacy bare `<scope>:<nodeId>` creation qualifiers name a node. */
  bareNodeCreate?: boolean;
  folderResourceType?: AccessFolderResourceType;
  dockerFolderType?: AccessDockerFolderType;
  /** How to create inside a granted destination (tool and arguments). */
  createHint?: string;
}

function prefixed(prefix: string, exclude: readonly string[] = []) {
  return (base: string): string | null =>
    base.startsWith(prefix) && !exclude.some((excluded) => base.startsWith(excluded))
      ? base.slice(prefix.length)
      : null;
}

function exact(actions: Readonly<Record<string, string>>) {
  return (base: string): string | null => actions[base] ?? null;
}

function anyPrefix(prefixes: readonly string[]) {
  return (base: string): string | null => (prefixes.some((prefix) => base.startsWith(prefix)) ? base : null);
}

/** Areas in match order: the first area whose `action` accepts a base owns it. */
export const ACCESS_AREAS: readonly AccessAreaDefinition[] = [
  {
    id: 'docker_containers',
    title: 'Docker containers and deployments',
    action: (base) =>
      base.startsWith('docker:containers:')
        ? base.slice('docker:containers:'.length)
        : base === 'docker:availability:manage'
          ? 'availability:manage'
          : null,
    viewScope: 'docker:containers:view',
    createScope: 'docker:containers:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'container',
    createHint:
      'pass nodeId and folderId to create_docker_container (or the deployment create action of manage_docker_deployment)',
  },
  {
    id: 'docker_compose',
    title: 'Docker Compose projects',
    action: prefixed('docker:compose:'),
    viewScope: 'docker:compose:view',
    createScope: 'docker:compose:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'compose',
    createHint: 'pass nodeId and folderId to manage_docker_compose',
  },
  {
    id: 'docker_images',
    title: 'Docker images',
    action: prefixed('docker:images:'),
    viewScope: 'docker:images:view',
    createScope: 'docker:images:pull',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'image',
    createHint: 'pass nodeId and folderId to pull_docker_image',
  },
  {
    id: 'docker_volumes',
    title: 'Docker volumes',
    action: prefixed('docker:volumes:'),
    viewScope: 'docker:volumes:view',
    createScope: 'docker:volumes:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'volume',
    createHint: 'pass nodeId and folderId to manage_docker_volume',
  },
  {
    id: 'docker_networks',
    title: 'Docker networks',
    action: prefixed('docker:networks:'),
    viewScope: 'docker:networks:view',
    createScope: 'docker:networks:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'network',
    createHint: 'pass nodeId and folderId to manage_docker_network',
  },
  {
    id: 'docker_registries',
    title: 'Docker registries',
    action: prefixed('docker:registries:'),
    viewScope: 'docker:registries:view',
  },
  {
    id: 'docker_tasks',
    title: 'Docker tasks and folder layout',
    action: exact({
      'docker:tasks': 'tasks:view',
      'docker:tasks:manage': 'tasks:manage',
      'docker:folders:manage': 'folders:manage',
    }),
  },
  {
    id: 'route_templates',
    title: 'Route templates',
    action: prefixed('proxy:templates:'),
    viewScope: 'proxy:templates:view',
  },
  {
    id: 'routes',
    title: 'Ingress routes',
    action: prefixed('proxy:'),
    viewScope: 'proxy:view',
    createScope: 'proxy:create',
    bareNodeCreate: true,
    folderResourceType: 'routes',
    createHint: 'pass folderId (and nodeId) to create_route',
  },
  { id: 'access_lists', title: 'Access lists', action: prefixed('acl:'), viewScope: 'acl:view' },
  {
    id: 'domains',
    title: 'Domains',
    action: prefixed('domains:'),
    viewScope: 'domains:view',
    createScope: 'domains:create',
    bareNodeCreate: true,
    folderResourceType: 'domains',
    createHint: 'pass folderId to create_domain',
  },
  {
    id: 'ssl_certificates',
    title: 'SSL certificates',
    action: prefixed('ssl:cert:'),
    viewScope: 'ssl:cert:view',
    createScope: 'ssl:cert:issue',
    folderResourceType: 'ssl_certificates',
    createHint: 'pass folderId to request_acme_cert or manage_ssl_certificate',
  },
  { id: 'pki', title: 'Internal PKI (CAs, certificates, templates)', action: prefixed('pki:') },
  {
    id: 'databases',
    title: 'Databases',
    action: prefixed('databases:'),
    viewScope: 'databases:view',
    createScope: 'databases:create',
    folderResourceType: 'databases',
    createHint:
      'pass folderId (and nodeId for a managed database) to manage_database_connection or manage_managed_database',
  },
  {
    id: 'storage',
    title: 'Storage',
    action: prefixed('storage:'),
    viewScope: 'storage:view',
    createScope: 'storage:create',
    folderResourceType: 'storage',
    createHint: 'pass folderId (and nodeId for managed storage) to manage_storage_connection or manage_managed_storage',
  },
  {
    id: 'pages',
    title: 'Pages',
    action: prefixed('pages:'),
    viewScope: 'pages:view',
    createScope: 'pages:create',
    folderResourceType: 'pages',
    createHint: 'pass folderId (and nodeId) to the create action of manage_pages',
  },
  {
    id: 'logging_schemas',
    title: 'Logging schemas',
    action: prefixed('logs:schemas:'),
    viewScope: 'logs:schemas:view',
    createScope: 'logs:schemas:create',
    folderResourceType: 'logging_schemas',
    createHint: 'pass folderId to the schema create action of manage_logging',
  },
  {
    id: 'logging_environments',
    title: 'Logging environments',
    action: (base) =>
      base.startsWith('logs:environments:')
        ? base.slice('logs:environments:'.length)
        : base.startsWith('logs:')
          ? base.slice('logs:'.length)
          : null,
    viewScope: 'logs:environments:view',
    createScope: 'logs:environments:create',
    folderResourceType: 'logging_environments',
    createHint: 'pass folderId to the environment create action of manage_logging',
  },
  {
    id: 'nodes',
    title: 'Nodes',
    action: prefixed('nodes:'),
    viewScope: 'nodes:details',
    createScope: 'nodes:create',
    folderResourceType: 'nodes',
    createHint: 'pass folderId to create_node',
  },
  {
    id: 'hosting',
    title: 'Hosting (VMs, snapshots, accounts)',
    action: (base) =>
      base.startsWith('integrations:hosting:')
        ? `accounts:${base.slice('integrations:hosting:'.length)}`
        : base.startsWith('hosting:')
          ? base.slice('hosting:'.length)
          : null,
    viewScope: 'hosting:resources:view',
    createScope: 'hosting:resources:create',
    createHint: 'pass the hosting account (connectorId) to the create action of manage_hosting',
  },
  { id: 'integrations', title: 'Integrations (Git, SSH, Cloudflare)', action: prefixed('integrations:') },
  { id: 'notifications', title: 'Notifications', action: prefixed('notifications:') },
  { id: 'status_page', title: 'Status page', action: prefixed('status-page:'), viewScope: 'status-page:view' },
  {
    id: 'users',
    title: 'Users',
    action: exact({
      'admin:users': 'manage',
      'admin:users:folders:manage': 'folders:manage',
      'admin:users:impersonate': 'impersonate',
    }),
    viewScope: 'admin:users',
    folderResourceType: 'admin_users',
  },
  {
    id: 'groups',
    title: 'Permission groups',
    action: exact({ 'admin:groups': 'manage', 'admin:groups:folders:manage': 'folders:manage' }),
    viewScope: 'admin:groups',
    folderResourceType: 'permission_groups',
  },
  {
    id: 'administration',
    title: 'Administration and settings',
    action: anyPrefix(['admin:', 'audit:', 'settings:', 'license:', 'housekeeping:']),
  },
  { id: 'ai', title: 'AI and inference', action: anyPrefix(['ai:', 'feat:', 'inference:', 'mcp:']) },
];

const OTHER_AREA: AccessAreaDefinition = { id: 'other', title: 'Other', action: (base) => base };

export function accessAreaForBase(base: string): { area: AccessAreaDefinition; action: string } {
  for (const area of ACCESS_AREAS) {
    const action = area.action(base);
    if (action) return { area, action };
  }
  return { area: OTHER_AREA, action: base };
}

/** Required scope -> scopes it satisfies, inverted from the catalog closure. */
const SATISFIED_BY_SCOPE = new Map<string, string[]>();
for (const [required, implying] of Object.entries(IMPLIED_SCOPES_BY_REQUIRED_SCOPE)) {
  for (const scope of implying) SATISFIED_BY_SCOPE.set(scope, [...(SATISFIED_BY_SCOPE.get(scope) ?? []), required]);
}

/** Hosting scopes whose bare qualifier is a hosting account (connector), not a VM. */
function isHostingAccountBase(base: string): boolean {
  return (
    base.startsWith('integrations:hosting:') ||
    base.startsWith('hosting:billing:') ||
    base === 'hosting:resources:create'
  );
}

export interface ClassifiedTarget {
  kind: AccessTargetKind;
  id: string;
  /** Docker resources live on a node: `<nodeId>/<resourceId>`. */
  nodeId?: string;
  /** `provider/<name>` hosting grants cover every account of a provider. */
  provider?: boolean;
}

/** What a qualified scope targets: a folder, a node, an account, or one resource. */
export function classifyScopeTarget(area: AccessAreaDefinition, base: string, qualifier: string): ClassifiedTarget {
  if (qualifier.startsWith('folder/')) return { kind: 'folder', id: qualifier.slice('folder/'.length) };
  if (qualifier.startsWith('node/')) return { kind: 'node', id: qualifier.slice('node/'.length) };
  if (qualifier.startsWith('account/')) return { kind: 'account', id: qualifier.slice('account/'.length) };
  if (qualifier.startsWith('provider/'))
    return { kind: 'account', id: qualifier.slice('provider/'.length), provider: true };
  if (area.dockerQualifiers) {
    const separator = qualifier.indexOf('/');
    if (separator < 0) return { kind: 'node', id: qualifier };
    return { kind: 'resource', id: qualifier.slice(separator + 1), nodeId: qualifier.slice(0, separator) };
  }
  if (area.bareNodeCreate && base === area.createScope) return { kind: 'node', id: qualifier };
  if (isHostingAccountBase(base)) return { kind: 'account', id: qualifier };
  return { kind: 'resource', id: qualifier };
}

export interface GrantTargetSummary {
  id: string;
  actions: string[];
  nodeId?: string;
  provider?: boolean;
}

export interface AreaGrantSummary {
  area: AccessAreaDefinition;
  /** Actions held everywhere in the area (unqualified scopes and what they imply). */
  broadActions: string[];
  /** Whether the caller sees every resource of the area. */
  broad: boolean;
  /** Folders granted directly (subfolders are included by the grant and not listed again). */
  folders: GrantTargetSummary[];
  nodes: GrantTargetSummary[];
  resources: GrantTargetSummary[];
  accounts: GrantTargetSummary[];
  create?: {
    scope: string;
    atRoot: boolean;
    folderIds: string[];
    nodeIds: string[];
    accountIds: string[];
  };
}

export interface ScopeGrantSummary {
  areas: AreaGrantSummary[];
  /** True when some area is limited to folders, nodes or resources, or allows creation only there. */
  limited: boolean;
}

type TargetAccumulator = { target: ClassifiedTarget; actions: Set<string> };

interface AreaAccumulator {
  area: AccessAreaDefinition;
  broad: Set<string>;
  targets: Map<string, TargetAccumulator>;
}

function sortedActions(actions: Iterable<string>): string[] {
  return [...new Set(actions)].sort();
}

/** The same-area actions a held base satisfies through the implication catalog (`manage` -> `view`). */
function actionsForBase(area: AccessAreaDefinition, base: string, action: string): string[] {
  const implied = (SATISFIED_BY_SCOPE.get(base) ?? []).flatMap((required) => {
    const impliedAction = area.action(required);
    return impliedAction ? [impliedAction] : [];
  });
  return [action, ...implied];
}

/**
 * Classify effective scopes by area.
 *
 * `derived` holds the qualified scopes the authentication layer added by expanding folder and node
 * grants (the resources and subfolders inside a granted folder). They are covered by the grant that
 * produced them, so they are not listed as separate resources or folders.
 */
export function summarizeScopeGrants(
  scopes: readonly string[],
  options: { derived?: ReadonlySet<string> } = {}
): ScopeGrantSummary {
  const derived = options.derived ?? new Set<string>();
  const byArea = new Map<string, AreaAccumulator>();
  const accumulator = (area: AccessAreaDefinition) => {
    let entry = byArea.get(area.id);
    if (!entry) {
      entry = { area, broad: new Set(), targets: new Map() };
      byArea.set(area.id, entry);
    }
    return entry;
  };

  for (const scope of new Set(scopes)) {
    const base = extractBaseScope(scope);
    const { area, action } = accessAreaForBase(base);
    const entry = accumulator(area);
    const actions = actionsForBase(area, base, action);
    if (scope === base) {
      for (const held of actions) entry.broad.add(held);
      continue;
    }
    if (derived.has(scope)) continue;
    const target = classifyScopeTarget(area, base, scope.slice(base.length + 1));
    if (!target.id) continue;
    const key = `${target.kind}\u0000${target.nodeId ?? ''}\u0000${target.id}`;
    const existing = entry.targets.get(key) ?? { target, actions: new Set<string>() };
    for (const held of actions) existing.actions.add(held);
    entry.targets.set(key, existing);
  }

  const areas: AreaGrantSummary[] = [];
  for (const area of [...ACCESS_AREAS, OTHER_AREA]) {
    const entry = byArea.get(area.id);
    if (!entry) continue;
    const listed = (kind: AccessTargetKind) =>
      [...entry.targets.values()]
        .filter(({ target }) => target.kind === kind)
        .map(({ target, actions }) => ({
          id: target.id,
          actions: sortedActions(actions),
          ...(target.nodeId ? { nodeId: target.nodeId } : {}),
          ...(target.provider ? { provider: true } : {}),
        }))
        .sort((left, right) => `${left.nodeId ?? ''}/${left.id}`.localeCompare(`${right.nodeId ?? ''}/${right.id}`));
    const folders = listed('folder');
    const nodes = listed('node');
    const resources = listed('resource');
    const accounts = listed('account');
    const broadActions = sortedActions(entry.broad);
    const qualified = folders.length + nodes.length + resources.length + accounts.length > 0;
    const viewAction = area.viewScope ? area.action(area.viewScope) : null;
    const broad = viewAction ? entry.broad.has(viewAction) : broadActions.length > 0 && !qualified;
    const createAction = area.createScope ? area.action(area.createScope) : null;
    const withCreate = (targets: GrantTargetSummary[]) =>
      createAction ? targets.filter((target) => target.actions.includes(createAction)).map((target) => target.id) : [];
    const create =
      area.createScope && createAction
        ? {
            scope: area.createScope,
            atRoot: entry.broad.has(createAction),
            folderIds: withCreate(folders),
            nodeIds: withCreate(nodes),
            accountIds: withCreate(accounts),
          }
        : undefined;
    areas.push({
      area,
      broadActions,
      broad,
      folders,
      nodes,
      resources,
      accounts,
      ...(create && (create.atRoot || create.folderIds.length || create.nodeIds.length || create.accountIds.length)
        ? { create }
        : {}),
    });
  }

  return { areas, limited: areas.some(isRestrictedArea) };
}

/** An area the caller cannot use at the root: limited visibility, or creation only in some destinations. */
export function isRestrictedArea(summary: AreaGrantSummary): boolean {
  if (
    !summary.broad &&
    (summary.folders.length || summary.nodes.length || summary.resources.length || summary.accounts.length)
  )
    return true;
  return !!summary.create && !summary.create.atRoot;
}

/** Whether a scope list holds any folder, node, account or resource-limited grant. */
export function hasLimitedGrants(scopes: readonly string[]): boolean {
  return summarizeScopeGrants(scopes).limited;
}

/** The standing rules every access summary repeats for agents. */
export const LIMITED_ACCESS_RULES: readonly string[] = [
  'Folder-, node- and resource-limited access is normal. An empty list or a denial at the root does not mean you have no access: work inside the folders, nodes and resources listed here.',
  'List tools return only what you can access; an empty result means nothing visible matches, not that the tool is forbidden.',
  'To create, pass folderId (and nodeId where the tool takes one) for a destination listed under create. A create without a destination targets the root and is refused unless create.atRoot is true.',
  'list_resource_folders shows each folder you can use with the actions you hold in it.',
];
