import fs from 'node:fs/promises';
import path from 'node:path';

export const SANDBOX_DISK_USAGE_LIMIT = 0.8;

export interface WorkspaceFilesystemUsage {
  totalBytes: number;
  usedBytes: number;
}

export interface WorkspaceAdmissionInput extends WorkspaceFilesystemUsage {
  activeReservationBytes: number;
  requestedReservationBytes: number;
}

export interface WorkspaceAdmission {
  allowed: boolean;
  limitBytes: number;
  projectedBytes: number;
}

export function remainingWorkspaceReservationBytes(reservationBytes: number, usageBytes: number): number {
  if (
    !Number.isSafeInteger(reservationBytes) ||
    reservationBytes <= 0 ||
    !Number.isSafeInteger(usageBytes) ||
    usageBytes < 0
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, reservationBytes - usageBytes);
}

export function evaluateWorkspaceAdmission(input: WorkspaceAdmissionInput): WorkspaceAdmission {
  const limitBytes = Math.floor(input.totalBytes * SANDBOX_DISK_USAGE_LIMIT);
  const projectedBytes = input.usedBytes + input.activeReservationBytes + input.requestedReservationBytes;
  const hasValidInputs =
    Number.isSafeInteger(input.totalBytes) &&
    input.totalBytes > 0 &&
    Number.isSafeInteger(input.usedBytes) &&
    input.usedBytes >= 0 &&
    input.usedBytes <= input.totalBytes &&
    Number.isSafeInteger(input.activeReservationBytes) &&
    input.activeReservationBytes >= 0 &&
    Number.isSafeInteger(input.requestedReservationBytes) &&
    input.requestedReservationBytes > 0 &&
    Number.isSafeInteger(projectedBytes);
  return {
    allowed: hasValidInputs && projectedBytes < limitBytes,
    limitBytes,
    projectedBytes,
  };
}

export async function measureWorkspaceUsageBytes(directory: string): Promise<number> {
  let total = 0;

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (stat.isFile()) {
        const allocatedBytes = typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
        total += Math.max(stat.size, allocatedBytes);
      }
    }
  };

  await walk(directory);
  return total;
}
