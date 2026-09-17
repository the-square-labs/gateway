import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { User } from '@/types.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import type { AISandboxJobsService } from './ai.sandbox-jobs.service.js';
import type { SandboxResourceTier } from './ai.sandbox-policy.js';
import type { AISandboxRunnerService } from './ai.sandbox-runner.service.js';
export interface SandboxExecuteScriptInput {
  runtime?: unknown;
  script: string;
  resourceTier?: SandboxResourceTier;
  ttlSeconds?: number;
  conversationId?: string | null;
}
export interface SandboxRunProcessInput {
  runtime?: unknown;
  command: string[];
  resourceTier?: SandboxResourceTier;
  ttlSeconds?: number;
  conversationId?: string | null;
}
export interface SandboxFetchInput {
  url: string;
}
export interface SandboxDownloadArtifactInput {
  processId: string;
  url: string;
  path?: string;
}
export interface SandboxUploadArtifactInput {
  processId: string;
  path: string;
  contentBase64: string;
}
export interface SandboxUploadArtifactStreamInput {
  processId: string;
  path: string;
  chunks: AsyncIterable<Uint8Array>;
  maxBytes: number;
}
export interface SandboxReadArtifactInput {
  processId: string;
  path: string;
  offset?: number;
  length?: number;
  encoding?: 'utf8' | 'base64';
}
export interface SandboxListArtifactFilesInput {
  processId: string;
  path?: string;
  maxDepth?: number;
  limit?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
}
export interface SandboxSendArtifactInput {
  processId: string;
  path: string;
  filename?: string;
  mediaType?: string;
  conversationId?: string | null;
}
export class AISandboxService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the commercial factory constructor contract.
  constructor(_jobs: AISandboxJobsService, _runner: AISandboxRunnerService, _artifacts: AISandboxArtifactService) {}
  status(): {
    status: import('./ai.sandbox-runner.service.js').SandboxRunnerStatus;
    socketPath: string;
    pid: number | null;
  } {
    return { status: 'unavailable', socketPath: '', pid: null };
  }
  async health(): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerHealth> {
    return commercialModuleUnavailable();
  }
  async executeScript(
    _user: User,
    _input: SandboxExecuteScriptInput
  ): Promise<{
    jobId: string;
    runtime: 'alpine' | 'node' | 'python';
    resourceTier: 'low' | 'medium' | 'high';
    requestedTtlSeconds: number;
    effectiveTtlSeconds: number;
    exitCode: number;
    output: string;
    timedOut: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async runProcess(
    _user: User,
    _input: SandboxRunProcessInput
  ): Promise<{
    jobId: string;
    processId: string;
    containerId: string;
    runtime: 'alpine' | 'node' | 'python';
    resourceTier: 'low' | 'medium' | 'high';
    requestedTtlSeconds: number;
    effectiveTtlSeconds: number;
    expiresAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async readProcessOutput(
    _user: User,
    _processId: string,
    _tail?: number
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerReadOutputResult> {
    return commercialModuleUnavailable();
  }
  async fetch(
    _user: User,
    _input: SandboxFetchInput
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerFetchResult> {
    return commercialModuleUnavailable();
  }
  async downloadArtifact(
    _user: User,
    _input: SandboxDownloadArtifactInput
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerDownloadArtifactResult> {
    return commercialModuleUnavailable();
  }
  async uploadArtifact(
    _user: User,
    _input: SandboxUploadArtifactInput
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerUploadArtifactResult> {
    return commercialModuleUnavailable();
  }
  async uploadArtifactStream(
    _user: User,
    _input: SandboxUploadArtifactStreamInput
  ): Promise<{
    processId: string;
    path: string;
    sizeBytes: number;
  }> {
    return commercialModuleUnavailable();
  }
  async listArtifactFiles(
    _user: User,
    _input: SandboxListArtifactFilesInput
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerListArtifactFilesResult> {
    return commercialModuleUnavailable();
  }
  async readArtifact(
    _user: User,
    _input: SandboxReadArtifactInput
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerReadArtifactResult> {
    return commercialModuleUnavailable();
  }
  async sendArtifact(
    _user: User,
    _input: SandboxSendArtifactInput
  ): Promise<{
    artifactId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sourcePath: string;
    downloadUrl: string;
  }> {
    return commercialModuleUnavailable();
  }
  async writeProcessStdin(
    _user: User,
    _processId: string,
    _data: string,
    _close?: boolean
  ): Promise<import('./ai.sandbox-runner.protocol.js').SandboxRunnerWriteStdinResult> {
    return commercialModuleUnavailable();
  }
  async killProcess(
    _user: User,
    _processId: string
  ): Promise<{
    processId: string;
    killed: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async killConversationJobs(
    _userId: string,
    _conversationId: string
  ): Promise<{
    killed: number;
  }> {
    return { killed: 0 };
  }
  async listJobs(
    _user: User,
    _input?: {
      activeOnly?: boolean;
      status?: string;
      limit?: number;
    }
  ): Promise<
    {
      id: string;
      userId: string;
      conversationId: string | null;
      kind: string;
      runtime: string;
      resourceTier: string;
      requestedTtlSeconds: number;
      effectiveTtlSeconds: number;
      requiredScopes: string[];
      status: string;
      containerId: string | null;
      exitCode: number | null;
      outputBytes: number;
      workspaceReservationBytes: number;
      workspaceUsageBytes: number;
      workspaceReservationReleasedAt: Date | null;
      stdoutCursor: string | null;
      stderrCursor: string | null;
      revocationReason: string | null;
      error: string | null;
      createdAt: Date;
      startedAt: Date | null;
      finishedAt: Date | null;
      expiresAt: Date | null;
      updatedAt: Date;
    }[]
  > {
    return [];
  }
  async revokeUserAccess(
    _userId: string,
    _currentScopes: string[],
    _reason: string
  ): Promise<{
    revoked: number;
  }> {
    return { revoked: 0 };
  }
  startPolicyReconciliation(): void {}
  async stopPolicyReconciliation(): Promise<void> {}
  async reconcileActiveJobs(): Promise<{
    checked: number;
    expired: number;
    revoked: number;
  }> {
    return { checked: 0, expired: 0, revoked: 0 };
  }
}
