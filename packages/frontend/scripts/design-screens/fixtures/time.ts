/** Fixture timestamps are relative to the export run so "3 hours ago" stays stable. */
const NOW = Date.now();

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function ago(amount: number, unit: keyof typeof UNIT_MS): string {
  return new Date(NOW - amount * UNIT_MS[unit]).toISOString();
}

export function ahead(amount: number, unit: keyof typeof UNIT_MS): string {
  return new Date(NOW + amount * UNIT_MS[unit]).toISOString();
}

export function agoMs(amount: number, unit: keyof typeof UNIT_MS): number {
  return NOW - amount * UNIT_MS[unit];
}

export const nowIso = () => new Date(NOW).toISOString();

/** Stable, random-looking UUIDs for fixture records: the same seed always gives the same id. */
export function uuid(seed: number): string {
  let state = (seed * 2654435761) >>> 0;
  let hex = "";
  while (hex.length < 32) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    hex += state.toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
