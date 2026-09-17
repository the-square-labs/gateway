import type { DrizzleClient } from '@/db/client.js';
import type { NewSandboxJob, SandboxJob } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { SandboxJobKind, SandboxJobStatus, SandboxResourceTier, SandboxRuntime } from './ai.sandbox-policy.js';
export interface CreateSandboxJobInput {
  userId: string;
  conversationId?: string | null;
  kind: SandboxJobKind;
  runtime: SandboxRuntime;
  resourceTier: SandboxResourceTier;
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  workspaceReservationBytes: number;
}
export interface ListSandboxJobsInput {
  userId: string;
  canManageAll: boolean;
  status?: SandboxJobStatus;
  activeOnly?: boolean;
  limit?: number;
}
export interface ListExpiredSandboxJobsInput {
  userId?: string;
  canManageAll?: boolean;
  now?: Date;
}
export class AISandboxJobsService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the commercial factory constructor contract.
  constructor(_db: DrizzleClient) {}
  async create(_input: CreateSandboxJobInput): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    conversationId: string | null;
    kind: string;
    status: string;
    startedAt: Date | null;
    error: string | null;
    requiredScopes: string[];
    expiresAt: Date | null;
    revocationReason: string | null;
    containerId: string | null;
    finishedAt: Date | null;
    runtime: string;
    resourceTier: string;
    requestedTtlSeconds: number;
    effectiveTtlSeconds: number;
    exitCode: number | null;
    outputBytes: number;
    workspaceReservationBytes: number;
    workspaceUsageBytes: number;
    workspaceReservationReleasedAt: Date | null;
    stdoutCursor: string | null;
    stderrCursor: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async get(_id: string): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async findByContainerId(_containerId: string): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async list(_input: ListSandboxJobsInput): Promise<
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
    return commercialModuleUnavailable();
  }
  async listExpiredActive(_input?: ListExpiredSandboxJobsInput): Promise<SandboxJob[]> {
    return commercialModuleUnavailable();
  }
  async markRunning(
    _id: string,
    _containerId: string
  ): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async markFinished(
    _id: string,
    _status: Extract<SandboxJobStatus, 'exited' | 'killed' | 'timeout' | 'failed' | 'revoked' | 'expired'>,
    _updates?: {
      exitCode?: number | null;
      error?: string | null;
      revocationReason?: string | null;
      outputBytes?: number;
      workspaceUsageBytes?: number;
    }
  ): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async markFinishedIfActive(
    _id: string,
    _status: Extract<SandboxJobStatus, 'exited' | 'killed' | 'timeout' | 'failed' | 'revoked' | 'expired'>,
    _updates?: {
      exitCode?: number | null;
      error?: string | null;
      revocationReason?: string | null;
      outputBytes?: number;
      workspaceUsageBytes?: number;
    }
  ): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async update(
    _id: string,
    _values: Partial<NewSandboxJob>
  ): Promise<{
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
  }> {
    return commercialModuleUnavailable();
  }
  async listActiveForUser(_userId: string): Promise<
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
    return commercialModuleUnavailable();
  }
  async listActiveForConversation(
    _userId: string,
    _conversationId: string
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
    return commercialModuleUnavailable();
  }
  async listActiveWithEffectiveScopes(): Promise<
    {
      job: {
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
      };
      userId: string;
      currentScopes: string[];
    }[]
  > {
    return commercialModuleUnavailable();
  }
}
