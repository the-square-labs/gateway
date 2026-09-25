import { z } from 'zod';
import { replaceRetiredScopes } from './scopes-aliases.js';
import { ALL_SCOPES } from './scopes-base.js';
import { FOLDER_CREATION_SCOPES, FOLDER_SCOPABLE, RESOURCE_SCOPABLE } from './scopes-resource.js';

/** Longest accepted delegated scope string, including its resource, folder, or node qualifier. */
export const MAX_DELEGATED_SCOPE_LENGTH = 512;
/** Most scope strings one token, grant, or group may carry (base scopes times restrictions). */
export const MAX_DELEGATED_SCOPES = 5000;
/** Longest accepted OAuth `scope` authorization parameter (the full MCP catalog is about 5.5 KB). */
export const MAX_OAUTH_SCOPE_PARAMETER_LENGTH = 16 * 1024;

const SCOPE_FORMAT = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?::[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_SEGMENT = /^[a-zA-Z0-9_.:-]+$/;
const HOSTING_PROVIDERS = new Set(['proxmox', 'digitalocean', 'hetzner', 'hostkey']);

const ALL_SCOPE_SET = new Set<string>(ALL_SCOPES);
const RESOURCE_SCOPABLE_SET = new Set<string>(RESOURCE_SCOPABLE);
const RESOURCE_SCOPABLE_BY_LENGTH = [...RESOURCE_SCOPABLE].sort((a, b) => b.length - a.length);
const FOLDER_SCOPABLE_SET = new Set<string>(FOLDER_SCOPABLE);
const CREATION_SCOPE_SET = new Set<string>(FOLDER_CREATION_SCOPES);
const DOCKER_CHILD_PREFIXES = [
  'docker:containers:',
  'docker:compose:',
  'docker:networks:',
  'docker:volumes:',
  'docker:images:',
  'docker:availability:',
];
/** Families whose `node/<nodeId>` grants resolve to the resources on that node (see folder-scopes.ts). */
const NODE_TARGET_PREFIXES = ['proxy:', 'pages:', 'storage:', 'databases:', 'docker:', 'hosting:snapshots:'];

const ALL_SCOPES_BY_LENGTH = [...ALL_SCOPES].sort((a, b) => b.length - a.length);

function baseOf(scope: string): string {
  if (ALL_SCOPE_SET.has(scope)) return scope;
  for (const base of RESOURCE_SCOPABLE_BY_LENGTH) {
    if (scope.startsWith(`${base}:`) && scope.length > base.length + 1) return base;
  }
  // A qualifier on a scope that cannot take one: name that scope in the error.
  return ALL_SCOPES_BY_LENGTH.find((base) => scope.startsWith(`${base}:`)) ?? scope;
}

function acceptsNodeTarget(base: string): boolean {
  if (CREATION_SCOPE_SET.has(base)) return true;
  if (base.startsWith('hosting:resources:')) return base !== 'hosting:resources:create';
  return NODE_TARGET_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function isHostingBase(base: string): boolean {
  return base.startsWith('hosting:') || base.startsWith('integrations:hosting:');
}

/** Why a canonical scope string cannot be delegated, or null when it can. */
function canonicalScopeIssue(scope: string): string | null {
  const base = baseOf(scope);
  if (!ALL_SCOPE_SET.has(base)) return 'Scope is not recognized';
  if (scope === base) return null;
  if (!RESOURCE_SCOPABLE_SET.has(base)) return `${base} cannot be restricted to a resource`;
  const target = scope.slice(base.length + 1);
  const segments = target.split('/');
  if (segments.some((segment) => !TARGET_SEGMENT.test(segment))) return 'Scope target is malformed';

  if (target.startsWith('folder/')) {
    if (!FOLDER_SCOPABLE_SET.has(base)) return `${base} cannot be restricted to a folder`;
    return segments.length === 2 && UUID.test(segments[1]) ? null : 'Folder targets must be folder/<uuid>';
  }
  if (target.startsWith('node/')) {
    if (!acceptsNodeTarget(base)) return `${base} cannot be restricted to a node`;
    return segments.length === 2 ? null : 'Node targets must be node/<nodeId>';
  }
  if (target.startsWith('provider/') || target.startsWith('account/')) {
    if (!isHostingBase(base)) return `${base} cannot be restricted to a hosting provider or account`;
    if (segments.length !== 2) return 'Hosting targets must be provider/<provider> or account/<accountId>';
    return segments[0] === 'provider' && !HOSTING_PROVIDERS.has(segments[1]) ? 'Unknown hosting provider' : null;
  }
  if (segments.length === 1) return null;
  if (base.startsWith('docker:registries:internal:')) return null;
  if (DOCKER_CHILD_PREFIXES.some((prefix) => base.startsWith(prefix))) {
    return segments.length === 2 ? null : 'Docker targets must be <nodeId> or <nodeId>/<resourceId>';
  }
  return `${base} does not accept nested resource targets`;
}

/**
 * Why a client-supplied scope string cannot be delegated, or null when it can. Retired scope
 * names are accepted when their replacements are valid (removed scopes are accepted and dropped).
 */
export function delegatedScopeIssue(scope: string): string | null {
  if (scope.length > MAX_DELEGATED_SCOPE_LENGTH) return 'Scope is too long';
  if (!SCOPE_FORMAT.test(scope)) return 'Invalid scope format';
  for (const replacement of replaceRetiredScopes([scope])) {
    const issue = canonicalScopeIssue(replacement);
    if (issue) return issue;
  }
  return null;
}

/** Apply a check to what an inbound scope canonicalizes to (retired names included). */
export function everyReplacementScope(scope: string, predicate: (scope: string) => boolean): boolean {
  return replaceRetiredScopes([scope]).every(predicate);
}

/**
 * One scope a user delegates to an API token, OAuth grant, or permission group. The base must be a
 * catalog scope (or a retired name that still maps to one); `folder/<uuid>` targets only folder-scopable
 * bases, `node/<id>` only bases whose resources live on nodes, `<nodeId>/<child>` only Docker bases.
 */
export const DelegatedScopeStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DELEGATED_SCOPE_LENGTH)
  .superRefine((scope, context) => {
    const issue = delegatedScopeIssue(scope);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: `${issue}: ${scope}` });
  });

export const DelegatedScopeArraySchema = z.array(DelegatedScopeStringSchema).max(MAX_DELEGATED_SCOPES);
