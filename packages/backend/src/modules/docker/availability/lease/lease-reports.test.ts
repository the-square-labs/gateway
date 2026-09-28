import { describe, expect, it } from 'vitest';
import { leaseReporterClockOffset } from './lease-reports.js';

// N-15: a daemon's clock offset, measured on the report that carries its times.
describe('lease reporter clock offset', () => {
  const receivedAtMs = 1_800_000_100_000;

  it('takes the report clock, else the health report seconds, else leaves it unknown', () => {
    expect(leaseReporterClockOffset({ reportedAtUnixMs: String(receivedAtMs - 101_000) }, { receivedAtMs })).toBe(
      -101_000
    );
    // A daemon without the report clock: its health timestamp is whole seconds, truncated.
    expect(leaseReporterClockOffset({}, { healthTimestampMs: receivedAtMs - 101_000 - 400, receivedAtMs })).toBe(
      -100_900
    );
    expect(leaseReporterClockOffset({ reportedAtUnixMs: '0' }, { healthTimestampMs: 0, receivedAtMs })).toBeNull();
    expect(leaseReporterClockOffset({}, { receivedAtMs })).toBeNull();
    // Without a measured arrival (a report replayed from storage) the times are taken as reported.
    expect(leaseReporterClockOffset({ reportedAtUnixMs: '5' }, undefined)).toBe(0);
  });
});
