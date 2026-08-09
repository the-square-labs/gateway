import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralShutdownSettings } from '@/modules/settings/general-settings.service.js';
import type { GatewayLifecycleService } from './gateway-lifecycle.service.js';

const logger = createChildLogger('ShutdownCoordinator');

export interface ShutdownHooks {
  freezeStatusPage: () => Promise<void>;
  quiesce: () => Promise<void>;
  drainUserWork: (deadline: number) => Promise<void>;
  forceCloseUserWork: () => Promise<void> | void;
  closeLogging: (deadline: number) => Promise<void>;
  closeHttp: (deadline: number) => Promise<void>;
  finalize: (deadline: number) => Promise<void>;
  closeApplicationLogger: (deadline: number) => Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  lifecycle: GatewayLifecycleService;
  getSettings: () => GeneralShutdownSettings;
  hooks: ShutdownHooks;
  exit?: (code: number) => void;
  now?: () => number;
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  request(signal: NodeJS.Signals): Promise<void> {
    if (this.shutdownPromise) {
      logger.error('Forced shutdown after repeated signal', { signal });
      this.options.exit?.(1);
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.run(signal);
    return this.shutdownPromise;
  }

  private async run(signal: NodeJS.Signals): Promise<void> {
    const shutdownId = randomUUID();
    const startedAt = this.now();
    const settings = { ...this.options.getSettings() };
    const userDeadline = startedAt + settings.userRequestDrainSeconds * 1000;
    const logDeadline = userDeadline + settings.structuredLogDrainSeconds * 1000;
    const hardDeadline = logDeadline + settings.finalizationTimeoutSeconds * 1000;
    const watchdog = setTimeout(
      () => {
        logger.error('Graceful shutdown hard deadline exceeded', { shutdownId, signal, hardDeadline });
        this.options.exit?.(1);
      },
      Math.max(0, hardDeadline - this.now())
    );

    logger.info('Graceful shutdown started', { shutdownId, signal, settings });
    try {
      this.options.lifecycle.transition('draining_user');
      const userPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'draining_user' });
      const userPhaseCompleted = await untilDeadline(
        Promise.allSettled([
          this.options.hooks.freezeStatusPage(),
          this.options.hooks.quiesce(),
          this.options.lifecycle.waitForZero('user', userDeadline),
          this.options.hooks.drainUserWork(userDeadline),
        ]).then(() => undefined),
        userDeadline,
        () => this.now()
      );
      if (this.options.lifecycle.getActiveCount('user') > 0) {
        logger.warn('User drain deadline reached', {
          shutdownId,
          activeRequests: this.options.lifecycle.getActiveCount('user'),
        });
      }
      this.options.lifecycle.forceClose('user');
      await untilDeadline(
        Promise.resolve(this.options.hooks.forceCloseUserWork()).then(() => undefined),
        userDeadline,
        () => this.now()
      );
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'draining_user',
        durationMs: this.now() - userPhaseStartedAt,
        timedOut: !userPhaseCompleted,
      });

      this.options.lifecycle.transition('draining_logs');
      const logPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'draining_logs' });
      const logRequestsDrained = await this.options.lifecycle.waitForZero('structured_logs', logDeadline);
      if (this.options.lifecycle.getActiveCount('structured_logs') > 0) {
        logger.warn('Structured log drain deadline reached', {
          shutdownId,
          activeRequests: this.options.lifecycle.getActiveCount('structured_logs'),
        });
        this.options.lifecycle.forceClose('structured_logs');
      }
      const loggingClosed = await untilDeadline(this.options.hooks.closeLogging(logDeadline), logDeadline, () =>
        this.now()
      );
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'draining_logs',
        durationMs: this.now() - logPhaseStartedAt,
        timedOut: !logRequestsDrained || !loggingClosed,
      });

      this.options.lifecycle.transition('terminating');
      const finalPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'terminating' });
      if (!(await untilDeadline(this.options.hooks.closeHttp(hardDeadline), hardDeadline, () => this.now()))) {
        throw new Error('HTTP shutdown exceeded the graceful shutdown hard deadline');
      }
      if (!(await untilDeadline(this.options.hooks.finalize(hardDeadline), hardDeadline, () => this.now()))) {
        throw new Error('Finalization exceeded the graceful shutdown hard deadline');
      }
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'terminating',
        durationMs: this.now() - finalPhaseStartedAt,
        timedOut: false,
      });

      logger.info('Graceful shutdown completed', { shutdownId, durationMs: this.now() - startedAt });
      const loggerClosed = await untilDeadline(
        this.options.hooks.closeApplicationLogger(hardDeadline),
        hardDeadline,
        () => this.now()
      );
      clearTimeout(watchdog);
      this.options.exit?.(loggerClosed ? 0 : 1);
    } catch (error) {
      logger.error('Graceful shutdown failed', { shutdownId, error });
      await untilDeadline(this.options.hooks.closeApplicationLogger(hardDeadline), hardDeadline, () =>
        this.now()
      ).catch(() => false);
      clearTimeout(watchdog);
      this.options.exit?.(1);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

async function untilDeadline(promise: Promise<void>, deadline: number, now: () => number): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - now());
  if (remainingMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  await Promise.race([
    promise.then(() => {
      completed = true;
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remainingMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

export function waitForShutdownTasks(
  tasks: Promise<unknown>[],
  deadline: number,
  now: () => number = Date.now
): Promise<boolean> {
  return untilDeadline(
    Promise.allSettled(tasks).then(() => undefined),
    deadline,
    now
  );
}
