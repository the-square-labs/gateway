import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerDeploymentSlot,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerWebhooks,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerDeploymentDetail } from './docker-deployment.service.js';
import { assertDeploymentNotUsedByProxy } from './docker-proxy-link.guard.js';

export interface DockerDeploymentOperationContext {
  db: DrizzleClient;
  audit: AuditService;
  dispatch: NodeDispatchService;
  eventBus?: EventBusService;
  validateDockerNode(nodeId: string): Promise<unknown>;
  loadDeployment(nodeId: string, deploymentId: string): Promise<DockerDeploymentDetail>;
  requireDeploymentIdle(deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'status'>): void;
  setTransition(
    deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'name'>,
    transition: 'starting' | 'stopping' | 'restarting' | 'killing' | 'removing'
  ): void;
  clearTransition(deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'name'>): void;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
  emit(action: string, deploymentId: string, nodeId: string, extra?: Record<string, unknown>): void;
  removeAccessScopes?(nodeId: string, deploymentId: string): Promise<void>;
  deploy(
    nodeId: string,
    deploymentId: string,
    input: { tag?: string },
    userId: string | null,
    source?: string
  ): Promise<DockerDeploymentDetail>;
}

export async function stopSlot(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  slot: DockerDeploymentSlot,
  userId: string | null
) {
  await ctx.validateDockerNode(nodeId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  if (slot === deployment.activeSlot) throw new AppError(409, 'ACTIVE_SLOT', 'Cannot stop the active slot');
  const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'stop_slot', {
    deploymentId,
    slot,
    configJson: JSON.stringify({ deployment, slot }),
  });
  ctx.parseResult(result);
  await ctx.db
    .update(dockerDeploymentSlots)
    .set({ status: 'stopped', health: 'unknown', drainingUntil: null, updatedAt: new Date() })
    .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, slot)));
  await ctx.audit.log({
    action: 'docker.deployment.slot.stop',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId, slot },
  });
  ctx.emit('slot_stopped', deploymentId, nodeId, { slot });
}

export async function start(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string | null
) {
  await ctx.validateDockerNode(nodeId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  ctx.setTransition(deployment, 'starting');
  let data: any;
  try {
    const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'start', {
      deploymentId,
      configJson: JSON.stringify({ deployment }),
    });
    data = ctx.parseResult(result) ?? {};
  } catch (err) {
    ctx.emit('failed', deploymentId, nodeId, { action: 'start', error: err instanceof Error ? err.message : err });
    throw err;
  } finally {
    ctx.clearTransition(deployment);
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(dockerDeployments)
      .set({ status: 'ready', updatedAt: new Date(), updatedById: userId })
      .where(eq(dockerDeployments.id, deploymentId));
    await tx
      .update(dockerDeploymentSlots)
      .set({
        containerId:
          data.containerId ?? deployment.slots.find((slot) => slot.slot === deployment.activeSlot)?.containerId ?? null,
        status: 'running',
        health: 'healthy',
        drainingUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, deployment.activeSlot))
      );
    for (const slot of deployment.slots.filter((item) => item.slot !== deployment.activeSlot)) {
      await tx
        .update(dockerDeploymentSlots)
        .set({
          status: slot.containerId || slot.image ? 'stopped' : 'empty',
          health: 'unknown',
          drainingUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, slot.slot)));
    }
  });
  await ctx.audit.log({
    action: 'docker.deployment.start',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  ctx.emit('started', deploymentId, nodeId);
  return ctx.loadDeployment(nodeId, deploymentId);
}

export async function stop(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string | null
) {
  await ctx.validateDockerNode(nodeId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  ctx.setTransition(deployment, 'stopping');
  try {
    const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'stop', {
      deploymentId,
      configJson: JSON.stringify({ deployment }),
    });
    ctx.parseResult(result);
  } catch (err) {
    ctx.emit('failed', deploymentId, nodeId, { action: 'stop', error: err instanceof Error ? err.message : err });
    throw err;
  } finally {
    ctx.clearTransition(deployment);
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(dockerDeployments)
      .set({ status: 'stopped', updatedAt: new Date(), updatedById: userId })
      .where(eq(dockerDeployments.id, deploymentId));
    await tx
      .update(dockerDeploymentSlots)
      .set({ status: 'stopped', health: 'unknown', updatedAt: new Date() })
      .where(eq(dockerDeploymentSlots.deploymentId, deploymentId));
    for (const slot of deployment.slots) {
      if (slot.containerId || slot.image) continue;
      await tx
        .update(dockerDeploymentSlots)
        .set({ status: 'empty', health: 'unknown', drainingUntil: null, updatedAt: new Date() })
        .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, slot.slot)));
    }
  });
  await ctx.audit.log({
    action: 'docker.deployment.stop',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  ctx.emit('stopped', deploymentId, nodeId);
  return ctx.loadDeployment(nodeId, deploymentId);
}

export async function restart(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string | null
) {
  await ctx.validateDockerNode(nodeId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  ctx.setTransition(deployment, 'restarting');
  let data: any;
  try {
    const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'restart', {
      deploymentId,
      configJson: JSON.stringify({ deployment }),
    });
    data = ctx.parseResult(result) ?? {};
  } catch (err) {
    ctx.emit('failed', deploymentId, nodeId, { action: 'restart', error: err instanceof Error ? err.message : err });
    throw err;
  } finally {
    ctx.clearTransition(deployment);
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(dockerDeployments)
      .set({ status: 'ready', updatedAt: new Date(), updatedById: userId })
      .where(eq(dockerDeployments.id, deploymentId));
    await tx
      .update(dockerDeploymentSlots)
      .set({
        containerId:
          data.containerId ?? deployment.slots.find((slot) => slot.slot === deployment.activeSlot)?.containerId ?? null,
        status: 'running',
        health: 'healthy',
        drainingUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, deployment.activeSlot))
      );
    for (const slot of deployment.slots.filter((item) => item.slot !== deployment.activeSlot)) {
      await tx
        .update(dockerDeploymentSlots)
        .set({
          status: slot.containerId || slot.image ? 'stopped' : 'empty',
          health: 'unknown',
          drainingUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, slot.slot)));
    }
  });
  await ctx.audit.log({
    action: 'docker.deployment.restart',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  ctx.emit('restarted', deploymentId, nodeId);
  return ctx.loadDeployment(nodeId, deploymentId);
}

export async function kill(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string | null
) {
  await ctx.validateDockerNode(nodeId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  ctx.setTransition(deployment, 'killing');
  try {
    const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'kill', {
      deploymentId,
      configJson: JSON.stringify({ deployment }),
    });
    ctx.parseResult(result);
  } catch (err) {
    ctx.emit('failed', deploymentId, nodeId, { action: 'kill', error: err instanceof Error ? err.message : err });
    throw err;
  } finally {
    ctx.clearTransition(deployment);
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(dockerDeployments)
      .set({ status: 'stopped', updatedAt: new Date(), updatedById: userId })
      .where(eq(dockerDeployments.id, deploymentId));
    await tx
      .update(dockerDeploymentSlots)
      .set({ status: 'stopped', health: 'unknown', updatedAt: new Date() })
      .where(eq(dockerDeploymentSlots.deploymentId, deploymentId));
    for (const slot of deployment.slots) {
      if (slot.containerId || slot.image) continue;
      await tx
        .update(dockerDeploymentSlots)
        .set({ status: 'empty', health: 'unknown', drainingUntil: null, updatedAt: new Date() })
        .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, slot.slot)));
    }
  });
  await ctx.audit.log({
    action: 'docker.deployment.kill',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  ctx.emit('killed', deploymentId, nodeId);
  return ctx.loadDeployment(nodeId, deploymentId);
}

export async function remove(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await assertDeploymentNotUsedByProxy(ctx.db, deploymentId);
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  ctx.requireDeploymentIdle(deployment);
  ctx.setTransition(deployment, 'removing');
  await ctx.db
    .update(dockerDeployments)
    .set({ status: 'deleting', updatedAt: new Date() })
    .where(eq(dockerDeployments.id, deploymentId));
  try {
    const result = await ctx.dispatch.sendDockerDeploymentCommand(nodeId, 'remove', {
      deploymentId,
      configJson: JSON.stringify({ deployment }),
    });
    ctx.parseResult(result);
    ctx.clearTransition(deployment);
    await ctx.db.delete(dockerDeployments).where(eq(dockerDeployments.id, deploymentId));
    await ctx.removeAccessScopes?.(nodeId, deploymentId);
  } catch (err) {
    ctx.clearTransition(deployment);
    await ctx.db
      .update(dockerDeployments)
      .set({ status: deployment.status, updatedAt: new Date() })
      .where(eq(dockerDeployments.id, deploymentId))
      .catch(() => {});
    ctx.emit('failed', deploymentId, nodeId, { action: 'remove', error: err instanceof Error ? err.message : err });
    throw err;
  }
  await ctx.audit.log({
    action: 'docker.deployment.delete',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId, name: deployment.name },
  });
  ctx.emit('deleted', deploymentId, nodeId);
}

export async function getWebhook(ctx: DockerDeploymentOperationContext, nodeId: string, deploymentId: string) {
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  return deployment.webhook ?? null;
}

export async function upsertWebhook(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  input: { enabled?: boolean },
  userId: string
) {
  const deployment = await ctx.loadDeployment(nodeId, deploymentId);
  const existing = deployment.webhook;
  if (existing) {
    const [updated] = await ctx.db
      .update(dockerWebhooks)
      .set({
        enabled: input.enabled ?? existing.enabled,
        updatedAt: new Date(),
      })
      .where(eq(dockerWebhooks.id, existing.id))
      .returning();
    emitWebhook(ctx, 'updated', updated);
    return updated;
  }
  const [created] = await ctx.db
    .insert(dockerWebhooks)
    .values({
      nodeId,
      containerName: deployment.name,
      targetType: 'deployment',
      deploymentId,
      enabled: input.enabled ?? true,
    })
    .returning();
  await ctx.audit.log({
    action: 'docker.deployment.webhook.created',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId, name: deployment.name },
  });
  emitWebhook(ctx, 'created', created);
  return created;
}

export async function deleteWebhook(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string
) {
  const webhook = await getWebhook(ctx, nodeId, deploymentId);
  if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
  await ctx.db.delete(dockerWebhooks).where(eq(dockerWebhooks.id, webhook.id));
  await ctx.audit.log({
    action: 'docker.deployment.webhook.deleted',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  emitWebhook(ctx, 'deleted', webhook);
}

export async function regenerateWebhook(
  ctx: DockerDeploymentOperationContext,
  nodeId: string,
  deploymentId: string,
  userId: string
) {
  const webhook = await getWebhook(ctx, nodeId, deploymentId);
  if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
  const [updated] = await ctx.db
    .update(dockerWebhooks)
    .set({ token: randomUUID(), updatedAt: new Date() })
    .where(eq(dockerWebhooks.id, webhook.id))
    .returning();
  await ctx.audit.log({
    action: 'docker.deployment.webhook.regenerated',
    userId,
    resourceType: 'docker-deployment',
    resourceId: deploymentId,
    details: { nodeId },
  });
  emitWebhook(ctx, 'updated', updated);
  return updated;
}

function emitWebhook(ctx: DockerDeploymentOperationContext, action: string, data: typeof dockerWebhooks.$inferSelect) {
  const { token: _token, ...safeData } = data;
  ctx.eventBus?.publish('docker.webhook.changed', { ...safeData, action });
}

export async function triggerWebhook(ctx: DockerDeploymentOperationContext, webhookId: string, tag?: string) {
  const [webhook] = await ctx.db.select().from(dockerWebhooks).where(eq(dockerWebhooks.id, webhookId)).limit(1);
  if (!webhook?.deploymentId) throw new AppError(404, 'NOT_FOUND', 'Deployment webhook not found');
  const deployment = await ctx.loadDeployment(webhook.nodeId, webhook.deploymentId);
  const result = await ctx.deploy(webhook.nodeId, webhook.deploymentId, { tag }, null, 'webhook');
  return { deploymentId: deployment.id, message: `Deploying ${deployment.name}`, deployment: result };
}
