import cron, { type ScheduledTask } from 'node-cron';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('SchedulerService');

/**
 * A scheduled task. The scheduler always passes a signal that aborts when it stops (Gateway
 * shutdown); a task that holds a long external session must end it on abort so shutdown does not
 * wait for it. The parameter is optional so wrappers may still call a task without one.
 */
export type SchedulerTask = (signal?: AbortSignal) => Promise<void>;

interface ScheduledJob {
  name: string;
  schedule: string; // cron expression
  task: SchedulerTask;
  handle?: ScheduledTask;
}

interface IntervalJob {
  name: string;
  intervalMs: number;
  task: SchedulerTask;
  handle?: ReturnType<typeof setInterval>;
}

export class SchedulerService {
  private jobs: ScheduledJob[] = [];
  private intervals: IntervalJob[] = [];
  private activeTasks = new Set<Promise<void>>();
  private activeTaskNames = new Set<string>();
  private running = false;
  private stopController = new AbortController();

  register(name: string, schedule: string, task: SchedulerTask): void {
    this.jobs.push({ name, schedule, task });
  }

  registerInterval(name: string, intervalMs: number, task: SchedulerTask): void {
    this.intervals.push({ name, intervalMs, task });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.stopController.signal.aborted) this.stopController = new AbortController();
    for (const job of this.jobs) {
      logger.info(`Starting scheduled job: ${job.name} (${job.schedule})`);
      job.handle = cron.schedule(job.schedule, () => this.runTask('Job', job.name, job.task));
    }

    for (const interval of this.intervals) {
      logger.info(`Starting interval job: ${interval.name} (every ${interval.intervalMs}ms)`);
      interval.handle = setInterval(
        () => this.runTask('Interval job', interval.name, interval.task),
        interval.intervalMs
      );
    }
  }

  updateSchedule(name: string, newCron: string): void {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return;
    job.handle?.destroy();
    job.handle = undefined;
    job.schedule = newCron;
    if (this.running) job.handle = cron.schedule(newCron, () => this.runTask('Job', job.name, job.task));
    logger.info(`Updated schedule for ${name}: ${newCron}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const job of this.jobs) {
      job.handle?.destroy();
      job.handle = undefined;
      logger.info(`Stopped job: ${job.name}`);
    }

    for (const interval of this.intervals) {
      if (interval.handle) {
        clearInterval(interval.handle);
        interval.handle = undefined;
      }
      logger.info(`Stopped interval job: ${interval.name}`);
    }
    this.stopController.abort();
    if (this.activeTaskNames.size > 0) {
      logger.info('Waiting for running scheduled jobs', { jobs: [...this.activeTaskNames] });
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  private runTask(kind: string, name: string, task: SchedulerTask): void {
    if (!this.running) return;
    if (this.activeTaskNames.has(name)) {
      logger.debug(`Skipping overlapping ${kind.toLowerCase()}: ${name}`);
      return;
    }
    logger.debug(`Running ${kind.toLowerCase()}: ${name}`);
    this.activeTaskNames.add(name);
    const signal = this.stopController.signal;
    const promise = Promise.resolve()
      .then(() => task(signal))
      .catch((error) => {
        logger.error(`${kind} ${name} failed`, { error });
      })
      .finally(() => {
        this.activeTaskNames.delete(name);
        this.activeTasks.delete(promise);
      });
    this.activeTasks.add(promise);
  }
}
