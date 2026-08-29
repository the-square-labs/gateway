/**
 * Minimal semver comparison — no npm dependency needed.
 * Handles versions like "1.2.3", "v1.2.3".
 */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  rc: number | null;
}

export const RELEASE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

export function isReleaseCandidateVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-rc\.\d+$/.test(version);
}

export function parseSemver(version: string): ParsedSemver | null {
  const clean = version.replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    rc: match[4] === undefined ? null : parseInt(match[4], 10),
  };
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  if (pa.rc === pb.rc) return 0;
  if (pa.rc === null) return 1;
  if (pb.rc === null) return -1;
  if (pa.rc > pb.rc) return 1;
  if (pa.rc < pb.rc) return -1;
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

/** Returns true if both versions share the same major and are fewer than 2 minors apart. */
export function isMinorCompatible(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return true; // unknown versions (dev) are compatible
  return pa.major === pb.major && Math.abs(pa.minor - pb.minor) < 2;
}
