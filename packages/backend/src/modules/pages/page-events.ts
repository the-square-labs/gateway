export const PAGE_EVENT_CHANNELS = {
  project: 'pages.project.changed',
  deployment: 'pages.deployment.changed',
  tag: 'pages.tag.changed',
  profile: 'pages.profile.changed',
  migration: 'pages.migration.changed',
  folder: 'pages.folder.changed',
  config: 'pages.config.changed',
  token: 'pages.token.changed',
} as const;

export interface PageProjectEvent {
  action: string;
  projectId: string;
  scopeResourceId: string;
  id?: string;
  publicSlug?: string;
  deploymentId?: string;
  nodeId?: string;
  tag?: string;
  tagId?: string | null;
  sequence?: number;
  generation?: number;
  status?: string;
  phase?: string;
  failureCode?: string | null;
  quotaUsedBytes?: number;
  quotaLimitBytes?: number;
  byteSize?: number;
  progress?: { completed?: number; total?: number };
}

export function pageProjectEvent(
  projectId: string,
  action: string,
  details: Omit<PageProjectEvent, 'projectId' | 'scopeResourceId' | 'action'> = {}
): PageProjectEvent {
  return { projectId, scopeResourceId: projectId, action, ...details };
}
