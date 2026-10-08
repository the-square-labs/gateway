import type { DockerTaskFollowUps } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { ContainerTransition, ContainerTransitionClaim } from './docker-container-transitions.js';
import { envListToMap } from './docker-env-operations.js';
import type { DockerTaskRow, DockerTaskService } from './docker-task.service.js';

const logger = createChildLogger('DockerEnvFollowUps');

/** Placeholder that inspect returns for secret-backed env values. */
export const MASKED_ENV_VALUE = '********';

/** The sealed part of DockerTaskFollowUps: the env its follow-ups need, never in plaintext in the task row. */
export interface DockerEnvFollowUpPayload {
  /** The stored env the operation left. A follow-up Gateway runs after it lost track of the task needs it unchanged. */
  expectedEnv: Record<string, string>;
  /** The keys of `expectedEnv` whose value the replaced runtime had too (reconcileEnvAfterImageChange). */
  mirroredKeys?: string[];
  /** The stored env before the update (restoreEnvAfterFailedUpdate). */
  restoreEnv?: Record<string, string>;
}

type SealedEnv = DockerTaskFollowUps['sealed'];

/** Seals a follow-up payload with the key and envelope of stored container env (CryptoService.encryptString). */
export function sealEnvFollowUpPayload(
  crypto: Pick<CryptoService, 'encryptString'>,
  payload: DockerEnvFollowUpPayload
): SealedEnv {
  return crypto.encryptString(JSON.stringify(payload));
}

export function openEnvFollowUpPayload(
  crypto: Pick<CryptoService, 'decryptString'>,
  sealed: SealedEnv
): DockerEnvFollowUpPayload {
  const payload = JSON.parse(crypto.decryptString(sealed)) as DockerEnvFollowUpPayload;
  if (!payload || typeof payload !== 'object' || !payload.expectedEnv || typeof payload.expectedEnv !== 'object') {
    throw new Error('Invalid env follow-up payload');
  }
  return payload;
}

export interface DockerEnvFollowUpContext {
  environmentService?: {
    replace(nodeId: string, containerName: string, env: Record<string, string>): Promise<unknown>;
    getDecryptedMap(nodeId: string, containerName: string): Promise<Record<string, string>>;
    sealFollowUpPayload(payload: DockerEnvFollowUpPayload): SealedEnv;
    openFollowUpPayload(sealed: SealedEnv): DockerEnvFollowUpPayload;
  };
  taskService?: Pick<DockerTaskService, 'recordFollowUps' | 'takeFollowUps'>;
  inspectContainer(nodeId: string, containerId: string): Promise<any>;
  claimTransitions(
    nodeId: string,
    entries: ReadonlyArray<{ name: string; state: ContainerTransition }>
  ): ContainerTransitionClaim;
  acquireTransitionLeases(nodeId: string, names: readonly string[]): Promise<void>;
  releaseTransitions(claim: ContainerTransitionClaim): void;
}

/**
 * After an image change the daemon drops env values inherited from the
 * previous image. Stored env entries that only mirrored such an inherited
 * value would otherwise pin the old image default on the next env edit, so
 * align them with the new runtime.
 */
export async function reconcileStoredEnvAfterImageChange(
  ctx: Pick<DockerEnvFollowUpContext, 'environmentService' | 'inspectContainer'>,
  nodeId: string,
  name: string,
  previousRuntimeEnv: Record<string, string>,
  newContainerId: string
): Promise<void> {
  if (!ctx.environmentService) return;
  const stored = await ctx.environmentService.getDecryptedMap(nodeId, name);
  if (Object.keys(stored).length === 0) return;
  const inspect = await ctx.inspectContainer(nodeId, newContainerId);
  const nextRuntimeEnv = envListToMap(Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : []);
  const next = { ...stored };
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    if (previousRuntimeEnv[key] !== value || nextRuntimeEnv[key] === value) continue;
    changed = true;
    if (Object.hasOwn(nextRuntimeEnv, key) && nextRuntimeEnv[key] !== MASKED_ENV_VALUE)
      next[key] = nextRuntimeEnv[key]!;
    else delete next[key];
  }
  if (changed) await ctx.environmentService.replace(nodeId, name, next);
}

/** What an update or recreate owes once the node settled it, with the env it needs. */
export interface DockerEnvFollowUpPlan {
  /** The stored env the operation leaves (written before dispatch, or the one it found). */
  expectedEnv: Record<string, string>;
  /** Set for an image change: the replaced runtime's env (stored entries mirroring it are reconciled). */
  previousRuntimeEnv?: Record<string, string>;
  /** Set when a failed asynchronous update must put back the stored env it saved before it ran. */
  restoreEnv?: Record<string, string>;
}

/** The gate the operation's own watch passes before it runs a follow-up itself. */
export interface DockerEnvFollowUpGate {
  /** Whether the watch may run its follow-ups now: they were not kept with the task, or the watch took them first. */
  take(): Promise<boolean>;
}

const RUN_IN_PROCESS: DockerEnvFollowUpGate = { take: async () => true };

function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key])
  );
}

/** Neither the error message nor its cause: a failed query's message carries its parameters (sealed env). */
function errorSummary(error: unknown) {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return {
    error: error instanceof Error ? error.name : 'Error',
    ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
  };
}

/**
 * Keeps what an update or recreate owes once settled with its task, the env sealed, so that it still runs when Gateway
 * loses track of the task (a restart, or the node's control stream dropped): DockerTaskReconciler then runs it through
 * runKeptEnvFollowUps. Recorded right before the task's watch starts. Never fails the operation: follow-ups that could
 * not be kept run only from the watch, as before. Nothing is kept for a follow-up that would change nothing.
 */
export async function keepEnvFollowUps(
  ctx: Pick<DockerEnvFollowUpContext, 'environmentService' | 'taskService'>,
  taskId: string | undefined,
  name: string,
  plan: DockerEnvFollowUpPlan
): Promise<DockerEnvFollowUpGate> {
  const { environmentService, taskService } = ctx;
  if (!taskId || !environmentService || !taskService) return RUN_IN_PROCESS;
  const previous = plan.previousRuntimeEnv;
  const mirroredKeys = previous
    ? Object.keys(plan.expectedEnv).filter(
        (key) => Object.hasOwn(previous, key) && previous[key] === plan.expectedEnv[key]
      )
    : [];
  const reconcile = mirroredKeys.length > 0;
  const restore = plan.restoreEnv !== undefined && !sameEnv(plan.restoreEnv, plan.expectedEnv);
  if (!reconcile && !restore) return RUN_IN_PROCESS;
  let kept = false;
  try {
    kept = await taskService.recordFollowUps(taskId, {
      containerName: name,
      ...(reconcile ? { reconcileEnvAfterImageChange: true } : {}),
      ...(restore ? { restoreEnvAfterFailedUpdate: true } : {}),
      sealed: environmentService.sealFollowUpPayload({
        expectedEnv: plan.expectedEnv,
        ...(reconcile ? { mirroredKeys } : {}),
        ...(restore ? { restoreEnv: plan.restoreEnv } : {}),
      }),
    });
  } catch (error) {
    logger.warn('Env follow-ups not kept with their task; only its watch in this process runs them', {
      taskId,
      name,
      ...errorSummary(error),
    });
  }
  if (!kept) return RUN_IN_PROCESS;
  return { take: async () => (await taskService.takeFollowUps(taskId)) !== null };
}

/** How DockerTaskReconciler settled a replacement whose task keeps follow-ups. */
export type DockerTaskFollowUpTrigger = { kind: 'replaced'; newContainerId: string } | { kind: 'daemon-task-failed' };

/**
 * Runs what an update or recreate Gateway lost track of still owes, once DockerTaskReconciler settled it with the
 * node: the stored env reconciliation after an image change once the replacement succeeded, or the stored env restore
 * once the daemon reported that the update failed. It is taken from the task first, so it runs once. Like the
 * operation, it holds the container meanwhile: a container another operation holds right now throws 409
 * CONTAINER_BUSY, and the reconciler asks again at its next pass. It runs only while the stored env is still the one the
 * operation left; otherwise a later operation changed it, and the follow-up is dropped. A follow-up that fails once it
 * was taken is logged and not run again.
 */
export async function runKeptEnvFollowUps(
  ctx: DockerEnvFollowUpContext,
  task: Pick<DockerTaskRow, 'id' | 'nodeId' | 'followUps'>,
  trigger: DockerTaskFollowUpTrigger
): Promise<void> {
  const owed = task.followUps;
  const { environmentService, taskService } = ctx;
  if (!owed || !environmentService || !taskService) return;
  const followUp = trigger.kind === 'replaced' ? 'reconcileEnvAfterImageChange' : 'restoreEnvAfterFailedUpdate';
  // The other one cannot be due any more; settling the task drops it.
  if (owed[followUp] !== true) return;
  const nodeId = task.nodeId;
  const name = owed.containerName;
  const claim = ctx.claimTransitions(nodeId, [{ name, state: 'updating' }]);
  try {
    await ctx.acquireTransitionLeases(nodeId, [name]);
    const taken = await taskService.takeFollowUps(task.id);
    if (!taken || taken[followUp] !== true) return;
    const details = { taskId: task.id, nodeId, name, followUp };
    try {
      const payload = environmentService.openFollowUpPayload(taken.sealed);
      const stored = await environmentService.getDecryptedMap(nodeId, name);
      if (!sameEnv(stored, payload.expectedEnv)) {
        logger.warn('Skipped an env follow-up: the stored env changed after the operation', details);
        return;
      }
      if (trigger.kind === 'replaced') {
        const mirrored = Object.fromEntries(
          (payload.mirroredKeys ?? [])
            .filter((key) => Object.hasOwn(payload.expectedEnv, key))
            .map((key) => [key, payload.expectedEnv[key]!])
        );
        await reconcileStoredEnvAfterImageChange(ctx, nodeId, name, mirrored, trigger.newContainerId);
      } else {
        if (!payload.restoreEnv) return;
        await environmentService.replace(nodeId, name, payload.restoreEnv);
      }
      logger.info('Ran the env follow-up of a task settled with its node', details);
    } catch (error) {
      logger.warn('The env follow-up of a task settled with its node failed', { ...details, ...errorSummary(error) });
    }
  } finally {
    ctx.releaseTransitions(claim);
  }
}
