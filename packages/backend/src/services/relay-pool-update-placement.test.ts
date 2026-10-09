import { describe, expect, it, vi } from 'vitest';
import { RelayPoolService } from './relay-pool.service.js';
import { relayBackSincePlanned } from './relay-topology.js';

/**
 * Stand rc.8, F-2 (Relay Pool update rc.7 → rc.8, netem NL 300 ms / UK 60 ms): UK drained for its update at
 * 20:51:25 and endpoint 15046c02 was placed on generation 149 `local:primary, nl:fallback`; UK was ready again at
 * 20:51:36; generation 149 was activated at 20:51:37.167; the local relay drained at 20:51:38 onto it and its traffic
 * went to NL; generation 150 `uk:primary, nl:fallback`, planned at 20:51:40.368, was active only at 20:51:48.595.
 */
const at = (time: string) => Date.parse(`2026-10-09T${time}Z`);
const LOCAL = '00000000-0000-4000-8000-000000000000';
const UK = '54fa7622-afe1-4cb9-be1d-23f1cb5f3e0f';
const NL = '42bd4ee8-0000-4000-8000-000000000000';

describe('A placement planned while a relay drained (stand rc.8, F-2)', () => {
  it('is out of date once that relay serves again, and current when planned after its return', () => {
    const backAt = new Map([[UK, at('20:51:36.000')]]);
    const serving = new Set([LOCAL, UK, NL]);
    expect(relayBackSincePlanned(at('20:51:25.180'), new Set([LOCAL, NL]), backAt, serving)).toBe(UK);
    expect(relayBackSincePlanned(at('20:51:40.368'), new Set([UK, NL]), backAt, serving)).toBeNull();
    // A relay it already includes, or one that does not serve, changes nothing.
    expect(relayBackSincePlanned(at('20:51:25.180'), new Set([LOCAL, UK]), backAt, serving)).toBeNull();
    expect(relayBackSincePlanned(at('20:51:25.180'), new Set([LOCAL, NL]), backAt, new Set([LOCAL, NL]))).toBeNull();
  });
});

describe('A Relay Pool update settles placement before it drains the next relay (stand rc.8, F-2)', () => {
  function pool(staged: () => boolean, rebalanceEndpointIds: string[]) {
    const query = () => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where']) chain[method] = () => chain;
      chain.limit = async () => (staged() ? [{ id: 'staging-1' }] : []);
      return chain;
    };
    const service = new RelayPoolService(
      { select: query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const snapshot = vi.spyOn(service, 'getSnapshot').mockResolvedValue({ rebalanceEndpointIds } as never);
    const stage = vi.spyOn(service, 'stageRebalance').mockResolvedValue([]);
    return { service, snapshot, stage };
  }

  it('waits for the placement in flight, then places the workloads whose plan changed with the relay that is back', async () => {
    vi.useFakeTimers();
    try {
      let staging = true;
      const t = pool(() => staging, ['15046c02', '33a9e639']);
      const settled = t.service.settleForUpdate();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.stage).not.toHaveBeenCalled();
      staging = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;
      expect(t.stage).toHaveBeenCalledWith(undefined, {
        allowNoop: true,
        automatic: true,
        evacuation: true,
        endpointIds: ['15046c02', '33a9e639'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never holds the update for longer than its bound', async () => {
    vi.useFakeTimers();
    try {
      const t = pool(() => true, ['15046c02']);
      const settled = t.service.settleForUpdate(undefined, 5_000);
      await vi.advanceTimersByTimeAsync(6_000);
      await settled;
      expect(t.stage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
