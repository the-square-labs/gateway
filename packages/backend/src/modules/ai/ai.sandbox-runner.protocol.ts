import type { SandboxJobKind, SandboxResourceTier, SandboxRuntime } from './ai.sandbox-policy.js';

export type SandboxRunnerMethod =
  | 'health'
  | 'executeScript'
  | 'runProcess'
  | 'fetch'
  | 'uploadArtifact'
  | 'downloadArtifact'
  | 'findJobContainer'
  | 'listArtifactFiles'
  | 'readArtifact'
  | 'getWorkspaceUsage'
  | 'uploadArtifactChunk'
  | 'sendArtifact'
  | 'readProcessOutput'
  | 'waitProcess'
  | 'writeProcessStdin'
  | 'killProcess'
  | 'revokeUserSandboxAccess'
  | 'reconcile';

export interface SandboxRunnerRequest<TParams = unknown> {
  id: string;
  method: SandboxRunnerMethod;
  params: TParams;
}

export interface SandboxRunnerResponse<TResult = unknown> {
  id: string;
  result?: TResult;
  error?: string;
}

export interface SandboxRunnerJobPolicy {
  jobId: string;
  userId: string;
  conversationId?: string | null;
  kind: SandboxJobKind;
  runtime: SandboxRuntime;
  tier: SandboxResourceTier;
  ttlSeconds: number;
  requiredScopes: string[];
  cpuQuota: number;
  memoryBytes: number;
  workspaceBytes: number;
  pidsLimit: number;
}

export interface SandboxRunnerExecuteScriptParams {
  policy: SandboxRunnerJobPolicy;
  script: string;
}

export interface SandboxRunnerRunProcessParams {
  policy: SandboxRunnerJobPolicy;
  command: string[];
}

export interface SandboxRunnerProcessParams {
  processId: string;
}

export interface SandboxRunnerFindJobContainerParams {
  jobId: string;
}

export interface SandboxRunnerFindJobContainerResult extends SandboxRunnerFindJobContainerParams {
  containerId: string | null;
  expiresAt: string | null;
}

export interface SandboxRunnerFetchParams {
  url: string;
}

export interface SandboxRunnerDownloadArtifactParams extends SandboxRunnerProcessParams {
  url: string;
  path?: string;
}

export interface SandboxRunnerUploadArtifactParams extends SandboxRunnerProcessParams {
  path: string;
  contentBase64: string;
}

export interface SandboxRunnerUploadArtifactChunkParams extends SandboxRunnerProcessParams {
  path: string;
  offset: number;
  contentBase64: string;
}

export interface SandboxRunnerUploadArtifactResult {
  processId: string;
  path: string;
  sizeBytes: number;
}

export interface SandboxRunnerUploadArtifactChunkResult {
  processId: string;
  path: string;
  sizeBytes: number;
}

export interface SandboxRunnerReadArtifactParams extends SandboxRunnerProcessParams {
  path: string;
  offset?: number;
  length?: number;
  encoding?: 'utf8' | 'base64';
}

export interface SandboxRunnerListArtifactFilesParams extends SandboxRunnerProcessParams {
  path?: string;
  maxDepth?: number;
  limit?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
}

export interface SandboxRunnerSendArtifactParams extends SandboxRunnerProcessParams {
  path: string;
  filename?: string;
  mediaType?: string;
}

export interface SandboxRunnerReadOutputParams extends SandboxRunnerProcessParams {
  tail?: number;
}

export interface SandboxRunnerWaitProcessParams extends SandboxRunnerProcessParams {
  timeoutMs?: number;
}

export interface SandboxRunnerWriteStdinParams extends SandboxRunnerProcessParams {
  data: string;
  close?: boolean;
}

export interface SandboxRunnerRevokeUserParams {
  userId: string;
  currentScopes: string[];
  reason: string;
}

export interface SandboxRunnerExecutionResult {
  jobId: string;
  containerId: string;
  exitCode: number;
  output: string;
  outputBytes: number;
  timedOut: boolean;
  workspaceUsageBytes: number;
}

export interface SandboxRunnerProcessResult {
  processId: string;
  jobId: string;
  containerId: string;
  expiresAt: string;
}

export interface SandboxRunnerReadOutputResult {
  processId: string;
  output: string;
  outputBytes: number;
}

export interface SandboxRunnerWaitProcessResult {
  processId: string;
  exitCode: number;
  outputBytes: number;
  workspaceUsageBytes: number;
}

export interface SandboxRunnerFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  sizeBytes: number;
  encoding: 'utf8' | 'base64';
  content?: string;
  contentBase64?: string;
}

export interface SandboxRunnerDownloadArtifactResult {
  processId: string;
  url: string;
  status: number;
  path: string;
  sizeBytes: number;
  contentType: string | null;
}

export interface SandboxRunnerReadArtifactResult {
  processId: string;
  path: string;
  offset: number;
  totalBytes: number;
  bytesRead: number;
  eof: boolean;
  encoding: 'utf8' | 'base64';
  content?: string;
  contentBase64?: string;
}

export interface SandboxRunnerWorkspaceUsageResult extends SandboxRunnerProcessParams {
  workspaceUsageBytes: number;
  workspaceReservationBytes: number;
  overReservation: boolean;
}

export interface SandboxRunnerListArtifactFilesEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes?: number;
}

export interface SandboxRunnerListArtifactFilesResult {
  processId: string;
  path: string;
  maxDepth: number;
  entries: SandboxRunnerListArtifactFilesEntry[];
  truncated: boolean;
}

export interface SandboxRunnerSendArtifactResult {
  processId: string;
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  tempFilePath: string;
}

export interface SandboxRunnerWriteStdinResult {
  processId: string;
  bytesWritten: number;
  closed: boolean;
  closeUnsupported?: boolean;
}

export interface SandboxRunnerKillResult {
  processId: string;
  killed: boolean;
}

export interface SandboxRunnerHealth {
  ok: boolean;
  version: 1;
}
