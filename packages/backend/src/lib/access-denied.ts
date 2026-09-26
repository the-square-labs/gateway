/**
 * Permission-denied messages that point folder-, node- and resource-limited callers at what they can
 * use instead of reading as "no access at all".
 *
 * Services refusing a create at the root call `rootAccessDeniedMessage` (names already known) or
 * `describeRootAccessDenied` (looks the folder and node names up). The AI and MCP tool layers pass
 * every tool error through `withLimitedAccessGuidance`, which adds the same pointer when the caller's
 * grants of the missing scope are limited to folders, nodes or resources.
 */

import type { DrizzleClient } from '@/db/client.js';
import { accessAreaForBase, classifyScopeTarget } from './access-summary.js';
import { buildAccessSummary } from './access-summary-resolver.js';
import { extractBaseScope, isValidBaseScope } from './scopes.js';
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE, isCreationScope } from './scopes-implications.js';

export interface DeniedDestination {
  id: string;
  name?: string | null;
  /** Folder path such as "Clients / MyProject"; preferred over the name when present. */
  path?: string | null;
}

export interface GrantedDestinations {
  /** The scope is held unqualified: a create at the root is allowed. */
  atRoot: boolean;
  folderIds: string[];
  nodeIds: string[];
  /** Specific resources the scope is held on (for non-creation scopes). */
  resourceIds: string[];
}

/** Where a scope is held: at the root, on folders, on nodes, or on specific resources (pure). */
export function grantedDestinations(scopes: readonly string[], baseScope: string): GrantedDestinations {
  const { area } = accessAreaForBase(baseScope);
  // The scope itself or any scope implying it (`docker:containers:manage` satisfies `docker:containers:view`).
  const satisfying = new Set([baseScope, ...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[baseScope] ?? [])]);
  const result: GrantedDestinations = { atRoot: false, folderIds: [], nodeIds: [], resourceIds: [] };
  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    if (!satisfying.has(base)) continue;
    if (scope === base) {
      result.atRoot = true;
      continue;
    }
    const target = classifyScopeTarget(area, base, scope.slice(base.length + 1));
    if (target.kind === 'folder') result.folderIds.push(target.id);
    else if (target.kind === 'node') result.nodeIds.push(target.id);
    else if (target.kind === 'resource')
      result.resourceIds.push(target.nodeId ? `${target.nodeId}/${target.id}` : target.id);
  }
  result.folderIds = [...new Set(result.folderIds)];
  result.nodeIds = [...new Set(result.nodeIds)];
  result.resourceIds = [...new Set(result.resourceIds)];
  return result;
}

function label(destination: DeniedDestination): string {
  const name = destination.path || destination.name;
  return name ? `'${name}' (${destination.id})` : destination.id;
}

function listed(kind: string, destinations: readonly DeniedDestination[], limit = 5): string | null {
  if (destinations.length === 0) return null;
  const shown = destinations.slice(0, limit).map(label).join(', ');
  const more = destinations.length > limit ? ` and ${destinations.length - limit} more` : '';
  return `${kind}${destinations.length === 1 ? '' : 's'} ${shown}${more}`;
}

/**
 * The message for an action refused at the root (typically a create without a destination) when the
 * caller holds the scope on folders or nodes. Without any limited grant it is a plain denial.
 */
export function rootAccessDeniedMessage(input: {
  scope: string;
  /** What was refused, e.g. "Creating a container at the root". Defaults to "Missing <scope> at the root". */
  action?: string;
  folders?: readonly DeniedDestination[];
  nodes?: readonly DeniedDestination[];
}): string {
  const lead = input.action ? `${input.action} requires ${input.scope} there` : `Missing ${input.scope} at the root`;
  const places = [listed('folder', input.folders ?? []), listed('node', input.nodes ?? [])].filter(
    (part): part is string => !!part
  );
  if (places.length === 0) return `${lead}.`;
  const pass =
    input.folders?.length && input.nodes?.length ? 'folderId or nodeId' : input.folders?.length ? 'folderId' : 'nodeId';
  return `${lead}. Your ${input.scope} access is limited to ${places.join(' and ')}: pass ${pass} for one of them. Call get_my_access to see every folder and node you can use.`;
}

/** `rootAccessDeniedMessage` with folder paths and node names read from the database. */
export async function describeRootAccessDenied(
  db: Pick<DrizzleClient, 'select'>,
  scopes: readonly string[],
  scope: string,
  action?: string
): Promise<string> {
  const destinations = grantedDestinations(scopes, scope);
  if (destinations.folderIds.length === 0 && destinations.nodeIds.length === 0) {
    return rootAccessDeniedMessage({ scope, action });
  }
  const { folders, nodes } = await namedDestinations(db, scopes, scope, destinations);
  return rootAccessDeniedMessage({ scope, action, folders, nodes });
}

async function namedDestinations(
  db: Pick<DrizzleClient, 'select'>,
  scopes: readonly string[],
  scope: string,
  destinations: GrantedDestinations
): Promise<{ folders: DeniedDestination[]; nodes: DeniedDestination[] }> {
  try {
    const { area } = accessAreaForBase(scope);
    // Only this scope's grants: the summary then lists the granted folders (not their subfolders) and nodes.
    const satisfying = new Set([scope, ...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[scope] ?? [])]);
    const summary = await buildAccessSummary(
      db,
      scopes.filter((held) => satisfying.has(extractBaseScope(held)))
    );
    const entry = summary.areas.find((candidate) => candidate.area === area.id);
    if (entry) {
      return {
        folders: entry.folders.map(({ id, name, path }) => ({ id, name, path })),
        nodes: entry.nodes.map(({ id, name }) => ({ id, name })),
      };
    }
  } catch {
    // Fall back to ids below.
  }
  return {
    folders: destinations.folderIds.map((id) => ({ id })),
    nodes: destinations.nodeIds.map((id) => ({ id })),
  };
}

const DENIAL =
  /PERMISSION_DENIED|FORBIDDEN|forbidden|Missing|permission|not allowed|not granted|unavailable for this MCP token/i;
const SCOPE_TOKEN = /[a-z][a-z-]*(?::[A-Za-z0-9_./-]+)+/g;

export interface NamedScope {
  /** The catalog base scope. */
  scope: string;
  /** The qualifier the message names (`folder/<id>`, `node/<id>`, a resource id), or null for the bare scope. */
  qualifier: string | null;
}

/** The first catalog scope a message names, split into its base and qualifier. */
export function scopeNamedInMessage(message: string): NamedScope | null {
  for (const match of message.matchAll(SCOPE_TOKEN)) {
    const token = match[0].replace(/[.,;:)]+$/, '');
    const base = extractBaseScope(token);
    if (isValidBaseScope(base) && isValidBaseScope(token)) {
      return { scope: base, qualifier: token === base ? null : token.slice(base.length + 1) };
    }
  }
  return null;
}

/**
 * Add a pointer to the caller's folder and node grants to a permission error when those grants are what
 * the caller holds instead of root access:
 * - a refused create (a creation scope named bare or with a folder/node destination) lists the folders and
 *   nodes the caller may create in and says to pass folderId or nodeId;
 * - any other scope named bare (the caller asked at the root) lists the folders, nodes or resources that
 *   hold it.
 * Denials of one specific resource, genuine denials (no grant of the scope anywhere), messages that name
 * no scope and non-permission errors are returned unchanged.
 */
export async function withLimitedAccessGuidance(
  message: string,
  scopes: readonly string[],
  db?: Pick<DrizzleClient, 'select'> | null
): Promise<string> {
  if (!message || message.includes('get_my_access') || !DENIAL.test(message)) return message;
  const named = scopeNamedInMessage(message);
  if (!named) return message;
  const { scope, qualifier } = named;
  const destinationQualifier = !qualifier || qualifier.startsWith('folder/') || qualifier.startsWith('node/');
  if (!destinationQualifier) return message;
  const destinations = grantedDestinations(scopes, scope);
  if (destinations.atRoot) return message;
  const separator = /[.!?]\s*$/.test(message) ? ' ' : '. ';
  const creation = isCreationScope(scope);
  if (destinations.folderIds.length || destinations.nodeIds.length) {
    const places = db
      ? await namedDestinations(db, scopes, scope, destinations)
      : {
          folders: destinations.folderIds.map((id) => ({ id })),
          nodes: destinations.nodeIds.map((id) => ({ id })),
        };
    const where = [listed('folder', places.folders), listed('node', places.nodes)].filter(
      (part): part is string => !!part
    );
    if (creation) {
      const pass =
        places.folders.length && places.nodes.length
          ? 'folderId or nodeId'
          : places.folders.length
            ? 'folderId'
            : 'nodeId';
      return `${message}${separator}Your ${scope} access is limited to ${where.join(' and ')}: pass ${pass} for one of them. Call get_my_access to see every folder and node you can use.`;
    }
    return `${message}${separator}Your ${scope} access is limited to ${where.join(' and ')} (and what they contain): act on resources inside them, which the list tools return. Call get_my_access for details.`;
  }
  if (!creation && destinations.resourceIds.length) {
    return `${message}${separator}Your ${scope} access is limited to specific resources: call get_my_access to see which ones and use one of them.`;
  }
  return message;
}
