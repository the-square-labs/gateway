import cron, { type ScheduledTask } from 'node-cron';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('SchedulerService');

interface ScheduledJob {
  name: string;
  schedule: string; // cron expression
  task: () => Promise<void>;
  handle?: ScheduledTask;
}

interface IntervalJob {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  handle?: ReturnType<typeof setInterval>;
}

export class SchedulerService {
  private jobs: ScheduledJob[] = [];
  private intervals: IntervalJob[] = [];
  private activeTasks = new Set<Promise<void>>();
  private running = false;

  register(name: string, schedule: string, task: () => Promise<void>): void {
    this.jobs.push({ name, schedule, task });
  }

  registerInterval(name: string, intervalMs: number, task: () => Promise<void>): void {
    this.intervals.push({ name, intervalMs, task });
  }

  start(): void {
    this.running = true;
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
    job.handle?.stop();
    job.schedule = newCron;
    job.handle = cron.schedule(newCron, () => this.runTask('Job', job.name, job.task));
    logger.info(`Updated schedule for ${name}: ${newCron}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const job of this.jobs) {
      job.handle?.stop();
      logger.info(`Stopped job: ${job.name}`);
    }

    for (const interval of this.intervals) {
      if (interval.handle) {
        clearInterval(interval.handle);
      }
      logger.info(`Stopped interval job: ${interval.name}`);
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  private runTask(kind: string, name: string, task: () => Promise<void>): void {
    if (!this.running) return;
    logger.debug(`Running ${kind.toLowerCase()}: ${name}`);
    const promise = Promise.resolve()
      .then(task)
      .catch((error) => {
        logger.error(`${kind} ${name} failed`, { error });
      })
      .finally(() => this.activeTasks.delete(promise));
    this.activeTasks.add(promise);
  }
}
