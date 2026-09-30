import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { type EventLoopUtilization, monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Host and process readings for Gateway diagnostics. Inside the app container /proc/loadavg,
 * /proc/meminfo and /proc/stat are not namespaced, so os.* and these files describe the whole host;
 * the cgroup files describe the app container itself.
 */

export interface HostReading {
  cpuCount: number;
  /** Busy share of all host CPUs since the previous reading; null on the first reading. */
  cpuPercent: number | null;
  loadAverage: [number, number, number];
  loadPerCpu: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  uptimeSeconds: number;
  kernel: string;
  /** The filesystem that holds Gateway's data, which is usually Docker's data root. */
  disk: DiskReading | null;
}

export interface DiskReading {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface ProcessReading {
  pid: number;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  /** CPU time of this process against wall time since the previous reading, in percent of one CPU. */
  cpuPercent: number | null;
  eventLoop: {
    /** Share of time the event loop was busy since the previous reading. */
    utilizationPercent: number | null;
    delayP50Ms: number | null;
    delayP99Ms: number | null;
    delayMaxMs: number | null;
  };
  container: { memoryUsageBytes: number | null; memoryLimitBytes: number | null } | null;
}

interface CpuTimes {
  busy: number;
  total: number;
}

function hostCpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

async function readMemInfo(): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    for (const line of text.split('\n')) {
      const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
      if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
    }
  } catch {
    // Not Linux (a development machine): os.freemem() stands in below.
  }
  return values;
}

async function readCgroupNumber(file: string): Promise<number | null> {
  try {
    const text = (await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim();
    if (!text || text === 'max') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readDisk(path: string): Promise<DiskReading | null> {
  try {
    const stats = await statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    if (totalBytes <= 0) return null;
    return {
      path,
      totalBytes,
      freeBytes,
      usedPercent: round(((totalBytes - freeBytes) / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const NS_PER_MS = 1_000_000;
const LOOP_DELAY_RESOLUTION_MS = 20;

/** The histogram measures whole timer intervals; the delay is what exceeds the interval. */
function loopDelayMs(nanoseconds: number): number {
  return round(Math.max(0, nanoseconds / NS_PER_MS - LOOP_DELAY_RESOLUTION_MS));
}

/**
 * Keeps the counters that readings are measured against. Readings cover the time since the last
 * reset, which the minute sampler does, so an on-demand snapshot does not shorten its window.
 */
export class SystemReader {
  private previousHostCpu: CpuTimes | null = null;
  private previousProcessCpu: { usage: NodeJS.CpuUsage; at: bigint } | null = null;
  private previousElu: EventLoopUtilization | null = null;
  private readonly loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });

  constructor(private readonly dataPath: string) {
    this.loopDelay.enable();
  }

  stop(): void {
    this.loopDelay.disable();
  }

  /** Host readings; `reset` starts a new measurement window for the CPU share. */
  async readHost(reset: boolean): Promise<HostReading> {
    const cpu = hostCpuTimes();
    const previous = this.previousHostCpu;
    if (reset || !previous) this.previousHostCpu = cpu;
    const cpuPercent =
      previous && cpu.total > previous.total
        ? round(((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100)
        : null;
    const memInfo = await readMemInfo();
    const memoryTotalBytes = memInfo.get('MemTotal') ?? os.totalmem();
    const memoryAvailableBytes = memInfo.get('MemAvailable') ?? os.freemem();
    const cpuCount = Math.max(1, os.cpus().length);
    const loadAverage = os.loadavg().map((value) => round(value, 2)) as [number, number, number];
    return {
      cpuCount,
      cpuPercent,
      loadAverage,
      loadPerCpu: round(loadAverage[0] / cpuCount, 2),
      memoryTotalBytes,
      memoryAvailableBytes,
      memoryUsedPercent: round(((memoryTotalBytes - memoryAvailableBytes) / memoryTotalBytes) * 100),
      swapTotalBytes: memInfo.get('SwapTotal') ?? null,
      swapFreeBytes: memInfo.get('SwapFree') ?? null,
      uptimeSeconds: Math.round(os.uptime()),
      kernel: `${os.type()} ${os.release()}`,
      disk: await readDisk(this.dataPath),
    };
  }

  /** Process readings; `reset` starts a new measurement window for the event-loop delay. */
  async readProcess(reset: boolean): Promise<ProcessReading> {
    const memory = process.memoryUsage();
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage();
    const previous = this.previousProcessCpu;
    const elapsedMicros = previous ? Number(now - previous.at) / 1000 : 0;
    const cpuPercent =
      previous && elapsedMicros > 0
        ? round(((usage.user - previous.usage.user + usage.system - previous.usage.system) / elapsedMicros) * 100)
        : null;
    const elu = performance.eventLoopUtilization();
    const eluDelta = this.previousElu ? performance.eventLoopUtilization(elu, this.previousElu) : null;
    const delaySamples = this.loopDelay.count > 0;
    const reading: ProcessReading = {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpuPercent,
      eventLoop: {
        utilizationPercent: eluDelta ? round(eluDelta.utilization * 100) : null,
        delayP50Ms: delaySamples ? loopDelayMs(this.loopDelay.percentile(50)) : null,
        delayP99Ms: delaySamples ? loopDelayMs(this.loopDelay.percentile(99)) : null,
        delayMaxMs: delaySamples ? loopDelayMs(this.loopDelay.max) : null,
      },
      container: await this.readContainerMemory(),
    };
    if (reset) {
      this.previousProcessCpu = { usage, at: now };
      this.previousElu = elu;
      this.loopDelay.reset();
    } else if (!previous) {
      this.previousProcessCpu = { usage, at: now };
      this.previousElu = elu;
    }
    return reading;
  }

  private async readContainerMemory(): Promise<ProcessReading['container']> {
    const [memoryUsageBytes, memoryLimitBytes] = await Promise.all([
      readCgroupNumber('memory.current'),
      readCgroupNumber('memory.max'),
    ]);
    if (memoryUsageBytes === null && memoryLimitBytes === null) return null;
    return { memoryUsageBytes, memoryLimitBytes };
  }
}
