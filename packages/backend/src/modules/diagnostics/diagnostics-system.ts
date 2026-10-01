import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { type EventLoopUtilization, monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Host and process readings for Gateway diagnostics. Inside the app container /proc/loadavg,
 * /proc/meminfo and /proc/stat are not namespaced, so os.* and these files describe the whole
 * kernel: in an LXC that is the hypervisor. The host reading therefore narrows them to what binds
 * Gateway: the CPUs it may run on (its affinity, which an LXC's cpuset sets) and the cgroup limits
 * of its container.
 */

export interface HostReading {
  /** CPUs Gateway may run on: its CPU affinity (an LXC or container cpuset), capped by its cgroup CPU quota. */
  cpuCount: number;
  /** CPUs of the whole kernel; more than cpuCount in an LXC or a CPU-limited container. */
  kernelCpuCount: number;
  /** Busy share of the CPUs Gateway may run on since the previous reading; null on the first reading. */
  cpuPercent: number | null;
  /** Load averages of the whole kernel. */
  loadAverage: [number, number, number];
  /** The 1-minute load per kernel CPU. */
  loadPerCpu: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  /**
   * `cgroup`: the memory limit of Gateway's container and its use. `kernel`: the container has no limit, so the
   * figures are the whole kernel's; in an LXC that is the hypervisor (gateway.dockerHost.memoryBytes is then the
   * LXC's memory).
   */
  memoryScope: 'cgroup' | 'kernel';
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

/** The CPUs this process may run on (`Cpus_allowed_list`, e.g. `0-3,8`); null off Linux. */
async function readAllowedCpus(): Promise<Set<number> | null> {
  try {
    const list = /^Cpus_allowed_list:\s*(\S+)/m.exec(await readFile('/proc/self/status', 'utf8'))?.[1];
    if (!list) return null;
    const cpus = new Set<number>();
    for (const range of list.split(',')) {
      const [from, to = from] = range.split('-').map(Number);
      if (from === undefined || !Number.isInteger(from) || !Number.isInteger(to)) return null;
      for (let cpu = from; cpu <= to; cpu++) cpus.add(cpu);
    }
    return cpus.size > 0 ? cpus : null;
  } catch {
    return null;
  }
}

/** CPU times of the allowed CPUs from /proc/stat, counted as os.cpus() counts them; every CPU off Linux. */
async function allowedCpuTimes(allowed: Set<number> | null): Promise<CpuTimes> {
  if (!allowed) return hostCpuTimes();
  try {
    let busy = 0;
    let total = 0;
    for (const match of (await readFile('/proc/stat', 'utf8')).matchAll(/^cpu(\d+)\s+(.+)$/gm)) {
      if (!allowed.has(Number(match[1]))) continue;
      // user nice system idle iowait irq …
      const ticks = (match[2] ?? '').trim().split(/\s+/).map(Number);
      const [user = 0, nice = 0, sys = 0, idle = 0] = ticks;
      const irq = ticks[5] ?? 0;
      busy += user + nice + sys + irq;
      total += user + nice + sys + idle + irq;
    }
    return total > 0 ? { busy, total } : hostCpuTimes();
  } catch {
    return hostCpuTimes();
  }
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

async function readCgroupText(file: string): Promise<string | null> {
  try {
    return (await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readCgroupNumber(file: string): Promise<number | null> {
  const text = await readCgroupText(file);
  if (!text || text === 'max') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The container's CPU quota in CPUs (`cpu.max` quota / period); null without a quota. */
async function readCgroupCpuQuota(): Promise<number | null> {
  const [quota, period] = (await readCgroupText('cpu.max'))?.split(/\s+/) ?? [];
  const cpus = Number(quota) / Number(period);
  return quota !== 'max' && Number.isFinite(cpus) && cpus > 0 ? cpus : null;
}

/** The container's memory limit and the memory it uses (without reclaimable inactive file cache). */
async function readCgroupMemory(): Promise<{ limitBytes: number; usedBytes: number } | null> {
  const limitBytes = await readCgroupNumber('memory.max');
  if (limitBytes === null) return null;
  const current = (await readCgroupNumber('memory.current')) ?? 0;
  const inactiveFile = Number(/^inactive_file (\d+)$/m.exec((await readCgroupText('memory.stat')) ?? '')?.[1] ?? 0);
  return { limitBytes, usedBytes: Math.max(0, current - inactiveFile) };
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
    const allowedCpus = await readAllowedCpus();
    const cpu = await allowedCpuTimes(allowedCpus);
    const previous = this.previousHostCpu;
    if (reset || !previous) this.previousHostCpu = cpu;
    const cpuPercent =
      previous && cpu.total > previous.total
        ? round(((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100)
        : null;
    const kernelCpuCount = Math.max(1, os.cpus().length);
    const cpuQuota = await readCgroupCpuQuota();
    const cpuCount = round(Math.min(allowedCpus?.size ?? os.availableParallelism(), cpuQuota ?? Infinity), 2);
    const memInfo = await readMemInfo();
    const kernelMemoryTotalBytes = memInfo.get('MemTotal') ?? os.totalmem();
    const container = await readCgroupMemory();
    const limited = container !== null && container.limitBytes < kernelMemoryTotalBytes;
    const memoryTotalBytes = limited ? container.limitBytes : kernelMemoryTotalBytes;
    const memoryAvailableBytes = limited
      ? Math.max(0, container.limitBytes - container.usedBytes)
      : (memInfo.get('MemAvailable') ?? os.freemem());
    const loadAverage = os.loadavg().map((value) => round(value, 2)) as [number, number, number];
    return {
      cpuCount,
      kernelCpuCount,
      cpuPercent,
      loadAverage,
      loadPerCpu: round(loadAverage[0] / kernelCpuCount, 2),
      memoryTotalBytes,
      memoryAvailableBytes,
      memoryUsedPercent: round(((memoryTotalBytes - memoryAvailableBytes) / memoryTotalBytes) * 100),
      memoryScope: limited ? 'cgroup' : 'kernel',
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
