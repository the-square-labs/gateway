import { FOLDER_CREATION_SCOPES, RESOURCE_SCOPABLE } from './scopes.js';

export type CreatedResourceFamily =
  | 'nodes'
  | 'proxy'
  | 'pages'
  | 'databases'
  | 'domains'
  | 'ssl:cert'
  | 'logs:environments'
  | 'logs:schemas'
  | 'docker:containers'
  | 'docker:compose'
  | 'docker:images'
  | 'docker:volumes'
  | 'docker:networks'
  | 'hosting:resources'
  | 'admin:users'
  | 'admin:groups'
  | 'integrations:hosting';

// Ownership never grants global settings, creation elsewhere, or security-validation bypasses.
const excluded = new Set<string>([
  ...FOLDER_CREATION_SCOPES,
  'proxy:advanced:bypass',
  'proxy:raw:bypass',
  'hosting:resources:create',
]);
export function createdResourceScopes(family: CreatedResourceFamily, resourceId: string): string[] {
  if (
    !resourceId ||
    resourceId.startsWith('folder/') ||
    (resourceId.startsWith('node/') && family !== 'hosting:resources') ||
    resourceId.startsWith('provider/')
  )
    throw new Error('A concrete created resource is required');
  const bases = RESOURCE_SCOPABLE.filter(
    (base) =>
      base.startsWith(`${family}:`) &&
      !base.startsWith('proxy:templates:') &&
      !base.endsWith(':bypass') &&
      !excluded.has(base)
  );
  if (family === 'admin:users' || family === 'admin:groups') return [`${family}:${resourceId}`];
  if (family === 'docker:containers') bases.push('docker:availability:manage');
  if (family === 'ssl:cert') bases.push('ssl:cert:issue');
  if (family === 'logs:environments')
    bases.push('logs:read', 'logs:tokens:view', 'logs:tokens:create', 'logs:tokens:delete');
  if (family === 'hosting:resources')
    bases.push(
      'hosting:snapshots:view',
      'hosting:snapshots:create',
      'hosting:snapshots:delete',
      'hosting:snapshots:restore',
      'hosting:snapshots:folders:manage'
    );
  return [...new Set(bases)].map((base) => `${base}:${resourceId}`);
}
