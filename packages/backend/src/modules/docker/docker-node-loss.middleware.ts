import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { nodeLossHttpError } from './docker-node-loss.js';

/**
 * The middleware of a container operation's route (update, env update, recreate), with node loss answered: a node
 * lost anywhere in the request (the scope check's or the operation's reads before it was sent, its dispatch, the lost
 * answer) is answered with nodeLossHttpError, and a loss before anything was sent is recorded as a failed task (stand
 * rc.8, F-4: the update's own wrapper missed the reads before it).
 */
export function answerNodeLoss(
  operation: string,
  taskType: string,
  middleware: MiddlewareHandler<AppEnv>
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let thrown: unknown;
    try {
      // The route's middleware runs here; its handler runs inside `next`, whose errors the route's error handler
      // has answered already (c.error).
      await middleware(c, next);
    } catch (error) {
      thrown = error;
    }
    const error = thrown ?? c.error;
    if (!error) return;
    const nodeId = c.req.param('nodeId');
    const containerId = c.req.param('containerId');
    const answer = await nodeLossHttpError(error, operation, async (message) =>
      nodeId && containerId
        ? container.resolve(DockerManagementService).recordNodeLostTask(nodeId, containerId, taskType, message)
        : undefined
    );
    if (!answer) {
      if (thrown) throw thrown;
      return;
    }
    c.error = answer;
    c.res = await errorHandler(answer, c);
  };
}
