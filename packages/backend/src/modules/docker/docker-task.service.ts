import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerTasks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('DockerTaskService');
const ACTIVE_TASK_STATUSES = ['pending', 'running'] as const;
const COMPLETED_TASK_STATUSES = ['completed', 'succeeded', 'failed'] as const;
const STALE_ACTIVE_TASK_TIMEOUT_MS = 60 * 60 * 1000;
const LOST_STARTUP_TRACKING_ERROR = 'Task tracking interrupted by backend restart';

export class DockerTaskService {
  constructor(private db: DrizzleClient) {}

  private eventBus?: EventBusService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  private emit(task: { id: string; nodeId: string; status: string; progress?: string | null; error?: string | null }) {
    this.eventBus?.publish('docker.task.changed', {
      taskId: task.id,
      nodeId: task.nodeId,
      status: task.status,
      progress: task.progress ?? null,
      error: task.error ?? null,
    });
  }

  async list(filters?: { nodeId?: string; status?: string; type?: string; allowedNodeIds?: string[] }) {
    await this.markStaleActiveTasksFailed();
    const conditions = [];
    if (filters?.nodeId) conditions.push(eq(dockerTasks.nodeId, filters.nodeId));
    if (filters?.status) conditions.push(eq(dockerTasks.status, filters.status));
    if (filters?.type) conditions.push(eq(dockerTasks.type, filters.type));
    if (filters?.allowedNodeIds) {
      if (filters.allowedNodeIds.length === 0) return [];
      conditions.push(inArray(dockerTasks.nodeId, filters.allowedNodeIds));
    }

    return this.db.select().from(dockerTasks).where(buildWhere(conditions)).orderBy(desc(dockerTasks.createdAt));
  }

  async get(id: string) {
    await this.markStaleActiveTasksFailed();
    const [row] = await this.db.select().from(dockerTasks).where(eq(dockerTasks.id, id)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    return row;
  }

  async forceCancel(id: string) {
    await this.markStaleActiveTasksFailed();
    const [existing] = await this.db.select().from(dockerTasks).where(eq(dockerTasks.id, id)).limit(1);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    if (!ACTIVE_TASK_STATUSES.includes(existing.status as (typeof ACTIVE_TASK_STATUSES)[number])) {
      throw new AppError(409, 'TASK_NOT_ACTIVE', 'Only pending or running Docker tasks can be force-cancelled');
    }

    return this.update(id, {
      status: 'failed',
      error: 'Force-cancelled by user',
      completedAt: new Date(),
    });
  }

  async create(input: { nodeId: string; containerId?: string; containerName?: string; type: string }) {
    await this.markStaleActiveTasksFailed();
    const [row] = await this.db
      .insert(dockerTasks)
      .values({
        nodeId: input.nodeId,
        containerId: input.containerId ?? null,
        containerName: input.containerName ?? null,
        type: input.type,
        status: 'pending',
      })
      .returning();

    this.emit(row);
    return row;
  }

  async markStaleActiveTasksFailed(now = new Date()) {
    const cutoff = new Date(now.getTime() - STALE_ACTIVE_TASK_TIMEOUT_MS);
    const rows = await this.db
      .update(dockerTasks)
      .set({
        status: 'failed',
        error: 'Timed out after backend restart or lost task watcher',
        completedAt: now,
      })
      .where(and(inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]), lt(dockerTasks.createdAt, cutoff)))
      .returning();

    for (const row of rows) this.emit(row);
    if (rows.length > 0) {
      logger.warn(`Marked ${rows.length} stale docker task(s) as failed`);
    }
    return rows.length;
  }

  async markActiveTasksLostOnStartup(now = new Date()) {
    const rows = await this.db
      .update(dockerTasks)
      .set({
        status: 'failed',
        error: LOST_STARTUP_TRACKING_ERROR,
        completedAt: now,
      })
      .where(inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]))
      .returning();

    for (const row of rows) this.emit(row);
    if (rows.length > 0) {
      logger.warn(`Marked ${rows.length} active docker task(s) as failed after backend startup`);
    }
    return rows.length;
  }

  async update(
    id: string,
    updates: {
      status?: string;
      progress?: string;
      error?: string;
      completedAt?: Date;
    }
  ) {
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.progress !== undefined) values.progress = updates.progress;
    if (updates.error !== undefined) values.error = updates.error;
    if (updates.completedAt !== undefined) values.completedAt = updates.completedAt;

    const [row] = await this.db.update(dockerTasks).set(values).where(eq(dockerTasks.id, id)).returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    this.emit(row);
    return row;
  }

  /**
   * Handle a task progress/status update from a daemon CommandResult.
   * The detail field is expected to be a JSON string with task information.
   */
  async handleTaskUpdate(nodeId: string, detail: string) {
    try {
      const data = JSON.parse(detail) as {
        taskId?: string;
        containerId?: string;
        containerName?: string;
        type?: string;
        status?: string;
        progress?: string;
        error?: string;
      };

      if (data.taskId) {
        // Update existing task
        const updates: Record<string, unknown> = {};
        if (data.status) updates.status = data.status;
        if (data.progress) updates.progress = data.progress;
        if (data.error) updates.error = data.error;
        if (data.status === 'completed' || data.status === 'failed') {
          updates.completedAt = new Date();
        }

        await this.db
          .update(dockerTasks)
          .set(updates)
          .where(and(eq(dockerTasks.id, data.taskId), inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES])));
      } else if (data.type) {
        // Create a new task from the update
        await this.create({
          nodeId,
          containerId: data.containerId,
          containerName: data.containerName,
          type: data.type,
        });
      }
    } catch (error) {
      logger.error('Failed to handle task update', { nodeId, error });
    }
  }

  /**
   * Delete tasks that were completed more than 24 hours ago.
   */
  async cleanup() {
    await this.markStaleActiveTasksFailed();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.db
      .delete(dockerTasks)
      .where(and(inArray(dockerTasks.status, [...COMPLETED_TASK_STATUSES]), lt(dockerTasks.completedAt, cutoff)))
      .returning({ id: dockerTasks.id });

    if (result.length > 0) {
      logger.info(`Cleaned up ${result.length} completed docker tasks`);
    }
    return result.length;
  }
}
