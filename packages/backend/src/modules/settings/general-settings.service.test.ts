import { describe, expect, it, vi } from 'vitest';
import type { EventBusService } from '@/services/event-bus.service.js';
import { type GeneralSettings, GeneralSettingsService } from './general-settings.service.js';

describe('GeneralSettingsService change events', () => {
  function changed(current: Partial<GeneralSettings>, next: Partial<GeneralSettings>) {
    const publish = vi.fn();
    const service = new GeneralSettingsService({} as never, undefined, { publish } as unknown as EventBusService);
    const base = { relay: {}, features: {}, hideExternalBranding: false, relayPolicyLeaseHours: 72 };
    return (service as unknown as { afterConfigChanged(a: unknown, b: unknown): Promise<void> })
      .afterConfigChanged({ ...base, ...current }, { ...base, ...next })
      .then(() => publish.mock.calls[0]?.[1] as { relayChanged: boolean });
  }

  it('publishes a changed relay policy lease to the relays at once', async () => {
    expect(await changed({ relayPolicyLeaseHours: 72 }, { relayPolicyLeaseHours: 1 })).toMatchObject({
      relayChanged: true,
    });
    expect(await changed({}, {})).toMatchObject({ relayChanged: false });
  });
});
