import forge from 'node-forge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemCertificateRenewalRow } from '@/db/schema/system-certificate-renewals.js';
import { EVENT_BUS_MAPPINGS } from '@/modules/notifications/notification.constants.js';
import {
  certificateFingerprintSha256,
  evaluateCertificateRenewal,
  type RenewalCertificate,
  type RenewalDeliveryResult,
  renewalBackoffMs,
  type ServedCertificateInfo,
  type SystemCertificateRenewalAdapter,
  SystemCertificateRenewalService,
  type SystemCertificateRenewalStateStore,
  type SystemCertificateRenewalTarget,
} from './system-certificate-renewal.service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2027, 8, 1);
const keys = forge.pki.rsa.generateKeyPair(1024);
let serial = 1000;

function leaf(options: {
  issuedDaysAgo: number;
  lifetimeDays?: number;
  sans?: string[];
  caId?: string;
}): RenewalCertificate {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16);
  const notBefore = new Date(NOW - options.issuedDaysAgo * DAY);
  const notAfter = new Date(notBefore.getTime() + (options.lifetimeDays ?? 365) * DAY);
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: `leaf-${serial}` }]);
  certificate.setIssuer([{ name: 'commonName', value: 'storage-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    id: `certificate-${serial}`,
    serialNumber: serial.toString(16),
    caId: options.caId ?? 'ca-1',
    notBefore,
    notAfter,
    sans: options.sans ?? ['10.0.0.5', 'localhost', '127.0.0.1'],
    certificatePem: forge.pki.certificateToPem(certificate),
  };
}

function served(certificate: RenewalCertificate, names = certificate.sans): ServedCertificateInfo {
  return {
    fingerprintSha256: certificateFingerprintSha256(certificate.certificatePem),
    dnsNames: names.filter((name) => !/^\d/.test(name)),
    ipAddresses: names.filter((name) => /^\d/.test(name)),
  };
}

class MemoryStore implements SystemCertificateRenewalStateStore {
  rows = new Map<string, SystemCertificateRenewalRow>();
  async load(ownerType: string, ownerId: string) {
    return this.rows.get(`${ownerType}:${ownerId}`) ?? null;
  }
  async save(ownerType: string, ownerId: string, patch: Partial<SystemCertificateRenewalRow>, now: Date) {
    const key = `${ownerType}:${ownerId}`;
    const previous = this.rows.get(key) ?? {
      ownerType,
      ownerId,
      state: 'idle',
      reason: null,
      pendingCertificateId: null,
      pendingSerial: null,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      deliveredAt: null,
      lastSuccessAt: null,
      lastError: null,
      servedFingerprint: null,
      lastMethod: null,
      lastRestarted: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...previous } as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch)) if (value !== undefined) next[field] = value;
    this.rows.set(key, { ...(next as SystemCertificateRenewalRow), updatedAt: now });
  }
  async list(ownerType: string) {
    return [...this.rows.values()].filter((row) => row.ownerType === ownerType);
  }
  async delete(ownerType: string, ownerId: string) {
    this.rows.delete(`${ownerType}:${ownerId}`);
  }
}

interface Harness {
  service: SystemCertificateRenewalService;
  adapter: SystemCertificateRenewalAdapter & {
    issuePending: ReturnType<typeof vi.fn>;
    deliver: ReturnType<typeof vi.fn>;
    probe: ReturnType<typeof vi.fn>;
    promote: ReturnType<typeof vi.fn>;
    fallback: ReturnType<typeof vi.fn>;
    findPending: ReturnType<typeof vi.fn>;
  };
  target: SystemCertificateRenewalTarget;
  store: MemoryStore;
  audit: { log: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
  clock: { now: number };
  pending: RenewalCertificate;
  scheduled: Array<{ task: () => void; delayMs: number }>;
}

function harness(overrides: Partial<SystemCertificateRenewalTarget> = {}): Harness {
  const clock = { now: NOW };
  const store = new MemoryStore();
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const events = { publish: vi.fn() };
  const pending = leaf({ issuedDaysAgo: 0 });
  const target: SystemCertificateRenewalTarget = {
    ownerType: 'managed_storage',
    ownerId: 'cluster-1',
    name: 'Backups',
    resourceType: 'managed_storage_cluster',
    current: leaf({ issuedDaysAgo: 250 }),
    expectedCaId: 'ca-1',
    requiredSans: ['10.0.0.5', 'localhost', '127.0.0.1'],
    supportsHotReload: true,
    ...overrides,
  };
  const adapter = {
    ownerType: 'managed_storage' as const,
    listTargets: vi.fn(async () => [target]),
    getTarget: vi.fn(async () => target),
    issuePending: vi.fn(async () => pending),
    findPending: vi.fn(async () => null),
    deliver: vi.fn(
      async (): Promise<RenewalDeliveryResult> => ({
        status: 'reloaded',
        servedFingerprint: certificateFingerprintSha256(pending.certificatePem),
        restarted: false,
        method: 'file_watch',
      })
    ),
    probe: vi.fn(async () => served(target.current!)),
    promote: vi.fn(async () => undefined),
    fallback: vi.fn(async () => undefined),
  };
  const scheduled: Harness['scheduled'] = [];
  const service = new SystemCertificateRenewalService({} as never, {
    audit,
    eventBus: events,
    store,
    now: () => new Date(clock.now),
    schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
  });
  service.registerAdapter(adapter);
  return { service, adapter, target, store, audit, events, clock, pending, scheduled };
}

describe('evaluateCertificateRenewal', () => {
  const desired = { requiredSans: ['10.0.0.5', 'localhost', '127.0.0.1'], expectedCaId: 'ca-1' };
  const now = new Date(NOW);

  it('leaves a fresh certificate alone', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 30 }), desired, now)).toMatchObject({
      due: false,
      reason: null,
      urgent: false,
    });
  });

  it('renews once two thirds of the lifetime passed', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 244 }), desired, now)).toMatchObject({
      due: true,
      reason: 'lifetime',
    });
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 242 }), desired, now).due).toBe(false);
  });

  it('renews a short-lived certificate 30 days before expiry and marks the last week urgent', () => {
    // 25 days left: expiring wins over the lifetime rule; 5 days left is urgent.
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 340 }), desired, now)).toMatchObject({
      due: true,
      reason: 'expiring',
      urgent: false,
      daysRemaining: 25,
    });
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 360 }), desired, now)).toMatchObject({
      reason: 'expiring',
      urgent: true,
    });
  });

  it('renews when a required name is missing (pre-rc.8 storage without loopback names)', () => {
    const result = evaluateCertificateRenewal(leaf({ issuedDaysAgo: 10, sans: ['10.0.0.5'] }), desired, now);
    expect(result).toMatchObject({ due: true, reason: 'names_missing', urgent: false });
    expect(result.missingNames).toEqual(['localhost', '127.0.0.1']);
  });

  it('ignores extra names but renews after a node address change', () => {
    expect(
      evaluateCertificateRenewal(
        leaf({ issuedDaysAgo: 10, sans: ['10.0.0.5', '10.0.0.6', 'localhost', '127.0.0.1'] }),
        desired,
        now
      ).due
    ).toBe(false);
    expect(
      evaluateCertificateRenewal(
        leaf({ issuedDaysAgo: 10 }),
        { ...desired, requiredSans: ['10.0.0.9', 'localhost'] },
        now
      )
    ).toMatchObject({ reason: 'names_missing', missingNames: ['10.0.0.9'] });
  });

  it('renews a certificate issued by an older CA', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 10, caId: 'ca-0' }), desired, now)).toMatchObject({
      due: true,
      reason: 'ca_changed',
    });
  });
});

describe('renewalBackoffMs', () => {
  it('backs off from one hour to a day', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempts) => renewalBackoffMs(attempts) / HOUR)).toEqual([
      1, 2, 4, 8, 16, 24, 24,
    ]);
    expect(renewalBackoffMs(6, true)).toBe(HOUR);
  });
});

describe('SystemCertificateRenewalService', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('delivers a due certificate without a restart, verifies the served leaf, then promotes it', async () => {
    const summary = await h.service.renewDue();

    expect(summary.renewed).toBe(1);
    expect(h.adapter.issuePending).toHaveBeenCalledWith(h.target);
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: false });
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending);
    expect(h.adapter.fallback).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'idle',
      attempts: 0,
      lastError: null,
      lastMethod: 'file_watch',
      lastSuccessAt: new Date(NOW),
    });
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'certificate.system.renew',
        resourceType: 'managed_storage_cluster',
        resourceId: 'cluster-1',
        details: expect.objectContaining({ reason: 'lifetime', certificateId: h.pending.id, restarted: false }),
      })
    );
    expect(h.events.publish).toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewed', ownerType: 'managed_storage', ownerId: 'cluster-1' })
    );
  });

  it('does not promote a leaf the workload does not serve', async () => {
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'reloaded',
      servedFingerprint: 'something-else',
      restarted: false,
      method: 'sighup',
    });
    const summary = await h.service.renewDue();
    expect(summary.failed).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
  });

  it('leaves a certificate that is not due alone and checks the served leaf still matches', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
    const summary = await h.service.renewDue();
    expect(summary.not_due).toBe(1);
    expect(h.adapter.issuePending).not.toHaveBeenCalled();
    expect(h.adapter.deliver).not.toHaveBeenCalled();
    expect(h.adapter.probe).toHaveBeenCalledTimes(1);
  });

  it('redelivers the current certificate when the workload serves another one', async () => {
    const current = leaf({ issuedDaysAgo: 20 });
    h = harness({ current });
    h.adapter.probe.mockResolvedValueOnce(served(leaf({ issuedDaysAgo: 400 })));
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'reloaded',
      servedFingerprint: certificateFingerprintSha256(current.certificatePem),
      restarted: false,
      method: 'sighup',
    });
    expect((await h.service.renewDue()).redelivered).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, current, { allowRestart: false });
    expect(h.adapter.promote).not.toHaveBeenCalled();
  });

  it('promotes a staged leaf the workload already serves', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
    const staged = leaf({ issuedDaysAgo: 0 });
    h.adapter.probe.mockResolvedValueOnce(served(staged));
    h.adapter.findPending.mockResolvedValueOnce(staged);
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, staged);
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('keeps a delivered leaf pending until the engine rereads it, redelivering the same serial', async () => {
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'pending',
      servedFingerprint: certificateFingerprintSha256(h.target.current!.certificatePem),
      restarted: false,
      method: 'file_watch',
      reloadIntervalSeconds: 5 * 60 * 60,
    });
    expect((await h.service.renewDue()).awaiting_reload).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
    const awaiting = await h.store.load('managed_storage', 'cluster-1');
    expect(awaiting).toMatchObject({
      state: 'awaiting_reload',
      pendingSerial: h.pending.serialNumber,
      lastError: null,
    });
    expect(awaiting?.nextAttemptAt?.getTime()).toBe(NOW + HOUR);

    // Still waiting inside the recheck window: nothing is sent again.
    h.clock.now += 30 * 60 * 1000;
    expect((await h.service.renewDue()).backoff).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledTimes(1);

    h.clock.now += HOUR;
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.issuePending).toHaveBeenCalledTimes(2);
    expect(h.adapter.deliver).toHaveBeenLastCalledWith(h.target, h.pending, { allowRestart: false });
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending);
    expect(h.events.publish).toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_pending' })
    );
  });

  it('confirms a delivery soon after an engine with a short reread interval picks it up', async () => {
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'pending',
      servedFingerprint: certificateFingerprintSha256(h.target.current!.certificatePem),
      restarted: false,
      method: 'file_watch',
      reloadIntervalSeconds: 60,
    });
    expect((await h.service.renewDue()).awaiting_reload).toBe(1);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.delayMs).toBe(90_000);

    h.clock.now += 90_000;
    h.scheduled[0]!.task();
    await vi.waitFor(() => expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending));
  });

  it('treats a delivery the engine never loads as a failure after six hours', async () => {
    h.adapter.deliver.mockResolvedValue({
      status: 'pending',
      servedFingerprint: 'old',
      restarted: false,
      method: 'file_watch',
      reloadIntervalSeconds: 60,
    });
    await h.service.renewDue();
    h.clock.now += 7 * HOUR;
    expect((await h.service.renewDue()).failed).toBe(1);
    expect((await h.store.load('managed_storage', 'cluster-1'))?.lastError).toMatch(/still serves the previous one/);
  });

  it('records failures, alerts, and backs off from one hour to a day', async () => {
    h.adapter.deliver.mockRejectedValue(new Error('node daemon unavailable'));
    expect((await h.service.renewDue()).failed).toBe(1);
    let state = await h.store.load('managed_storage', 'cluster-1');
    expect(state).toMatchObject({ state: 'failed', attempts: 1, lastError: 'node daemon unavailable' });
    expect(state?.nextAttemptAt?.getTime()).toBe(NOW + HOUR);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'certificate.system.renew_failed', userId: null })
    );
    expect(h.events.publish).toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_failed', attempts: 1 })
    );

    h.clock.now += 30 * 60 * 1000;
    expect((await h.service.renewDue()).backoff).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledTimes(1);

    h.clock.now += HOUR;
    await h.service.renewDue();
    state = await h.store.load('managed_storage', 'cluster-1');
    expect(state).toMatchObject({ attempts: 2 });
    expect(state?.nextAttemptAt?.getTime()).toBe(h.clock.now + 2 * HOUR);
    // Every retry reuses the same staged leaf.
    expect(h.adapter.issuePending).toHaveBeenCalledTimes(2);
  });

  it('allows a restart once seven days or fewer remain', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 360 }) });
    await h.service.renewDue();
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: true });
  });

  it('waits for the daemon update instead of restarting while more than seven days remain', async () => {
    h = harness({ supportsHotReload: false });
    expect((await h.service.renewDue()).waiting_for_daemon).toBe(1);
    expect(h.adapter.issuePending).not.toHaveBeenCalled();
    expect(h.adapter.fallback).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'waiting_for_daemon',
      lastError: expect.stringMatching(/daemon/),
    });
  });

  it('falls back to a restart or recreate when the daemon cannot reload and expiry is near', async () => {
    h = harness({ supportsHotReload: false, current: leaf({ issuedDaysAgo: 360 }) });
    // The update carrying the pending leaf succeeded and its hook promoted it.
    h.adapter.fallback.mockImplementation(async () => {
      h.target.current = h.pending;
    });
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.fallback).toHaveBeenCalledWith(h.target, h.pending);
    expect(h.adapter.deliver).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'idle',
      lastMethod: 'fallback_restart',
      lastRestarted: true,
    });
  });

  it('keeps the leaf pending when the fallback update did not make it current', async () => {
    h = harness({ supportsHotReload: false, current: leaf({ issuedDaysAgo: 360 }) });
    // The update returned, but its success hook never promoted the leaf.
    expect((await h.service.renewDue()).failed).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'failed',
      pendingSerial: h.pending.serialNumber,
      lastError: expect.stringMatching(/stays pending/),
    });
  });

  it('skips a time-based renewal the issuing CA would clamp to the current end, without churning', async () => {
    const current = leaf({ issuedDaysAgo: 340 });
    // The CA ends a day after the current leaf: every renewal would end with it.
    h = harness({ current, issuerNotAfter: new Date(current.notAfter.getTime() + 60 * 60 * 1000) });
    expect((await h.service.renewDue()).skipped).toBe(1);
    h.clock.now += HOUR;
    expect((await h.service.renewDue()).skipped).toBe(1);
    expect(h.adapter.issuePending).not.toHaveBeenCalled();
    expect(h.events.publish).not.toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_failed' })
    );
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'ca_limited',
      lastError: expect.stringMatching(/issuing CA expires/),
    });
    // A CA that still outlasts a renewal leaves it alone.
    h = harness({ current, issuerNotAfter: new Date(NOW + 200 * DAY) });
    expect((await h.service.renewDue()).renewed).toBe(1);
    // Missing names are still fixed even at the CA's end.
    h = harness({
      current: leaf({ issuedDaysAgo: 340, sans: ['10.0.0.5'] }),
      issuerNotAfter: new Date(current.notAfter.getTime()),
    });
    expect((await h.service.renewDue()).renewed).toBe(1);
  });

  it('resolves a renewal failure that recovered another way, and forgets deleted or TLS-less owners', async () => {
    h.adapter.deliver.mockRejectedValueOnce(new Error('boom'));
    await h.service.renewDue();
    expect(h.events.publish).toHaveBeenLastCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_failed' })
    );
    // A user update delivered and promoted a fresh leaf.
    h.target.current = leaf({ issuedDaysAgo: 0 });
    h.clock.now += 2 * HOUR;
    expect((await h.service.renewDue()).not_due).toBe(1);
    expect(h.events.publish).toHaveBeenLastCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_recovered', ownerType: 'managed_storage', ownerId: 'cluster-1' })
    );
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({ state: 'idle', lastError: null });

    // A failing owner that disappears (deleted, TLS off) is cleared too.
    await h.store.save('managed_storage', 'gone-1', { state: 'failed', lastError: 'boom' }, new Date(NOW));
    await h.service.renewDue();
    expect(h.events.publish).toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_cleared', ownerType: 'managed_storage', ownerId: 'gone-1' })
    );
    expect(await h.store.load('managed_storage', 'gone-1')).toBeNull();
  });

  it('resolves a firing renewal alert when the renewal moves to a state that is not a failure', async () => {
    const renewalEvents = () =>
      h.events.publish.mock.calls
        .filter(([channel]) => channel === 'system-certificate.renewal')
        .map(([, payload]) => (payload as { action: string }).action);

    // Failed, then the CA turns out to end first.
    const current = leaf({ issuedDaysAgo: 340 });
    h = harness({ current });
    h.adapter.deliver.mockRejectedValueOnce(new Error('boom'));
    await h.service.renewDue();
    h.target.issuerNotAfter = new Date(current.notAfter.getTime() + HOUR);
    h.clock.now += 2 * HOUR;
    await h.service.renewDue();
    h.clock.now += HOUR;
    await h.service.renewDue();
    expect(renewalEvents()).toEqual(['renewal_failed', 'renewal_ca_limited']);
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({ state: 'ca_limited', attempts: 0 });

    // Failed, then the node turns out to run a daemon without hot reload.
    h = harness();
    h.adapter.deliver.mockRejectedValueOnce(new Error('boom'));
    await h.service.renewDue();
    h.target.supportsHotReload = false;
    h.clock.now += 2 * HOUR;
    await h.service.renewDue();
    h.clock.now += HOUR;
    await h.service.renewDue();
    expect(renewalEvents()).toEqual(['renewal_failed', 'renewal_waiting_for_daemon']);
  });

  it('opens and resolves the renewal alert on the same resource key', () => {
    const [mapping] = EVENT_BUS_MAPPINGS['system-certificate.renewal']!;
    const base = { ownerType: 'managed_storage', ownerId: 'cluster-1', resourceType: 'managed_storage_cluster' };
    const failed = { ...base, action: 'renewal_failed', name: 'Backups' };
    const statesAndKeys = [
      'renewal_failed',
      'renewed',
      'renewal_recovered',
      'renewal_cleared',
      'renewal_ca_limited',
      'renewal_waiting_for_daemon',
    ].map((action) => {
      const payload = { ...base, action };
      expect(mapping!.match(payload)).toBe(true);
      return [mapping!.stateful!.currentState(payload), mapping!.extractResource(payload).type];
    });
    expect(statesAndKeys).toEqual([
      ['internal.renewal_failed', 'managed_storage'],
      ['internal.renewal_healthy', 'managed_storage'],
      ['internal.renewal_healthy', 'managed_storage'],
      ['internal.renewal_healthy', 'managed_storage'],
      ['internal.renewal_healthy', 'managed_storage'],
      ['internal.renewal_healthy', 'managed_storage'],
    ]);
    expect(mapping!.extractResource(failed)).toEqual({ type: 'managed_storage', id: 'cluster-1', name: 'Backups' });
  });

  it('skips paused or offline owners without recording a failure', async () => {
    for (const skipReason of ['paused', 'node_offline', 'operation_pending'] as const) {
      h = harness({ skipReason });
      expect((await h.service.renewDue()).skipped).toBe(1);
      expect(h.adapter.issuePending).not.toHaveBeenCalled();
      expect(await h.store.load('managed_storage', 'cluster-1')).toBeNull();
    }
  });

  it('renews on demand even when not due, crediting the user', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
    const outcome = await h.service.renewNow('managed_storage', 'cluster-1', { actorUserId: 'user-1' });
    expect(outcome).toMatchObject({ status: 'renewed', reason: 'manual' });
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', action: 'certificate.system.renew' })
    );
    await h.service.renewNow('managed_storage', 'cluster-1', { allowRestart: true });
    expect(h.adapter.deliver).toHaveBeenLastCalledWith(h.target, h.pending, { allowRestart: true });
  });

  it('reports the certificate and renewal state for the UI', async () => {
    h.adapter.deliver.mockRejectedValueOnce(new Error('boom'));
    await h.service.renewDue();
    const status = await h.service.getStatus('managed_storage', 'cluster-1');
    expect(status.certificate?.daysRemaining).toBe(115);
    expect(status.renewal).toMatchObject({
      state: 'failed',
      due: true,
      dueReason: 'lifetime',
      hotReloadSupported: true,
      attempts: 1,
      lastError: 'boom',
    });
  });

  describe('ensureNamesServed (backups)', () => {
    it('is ready when the served certificate names the loopback identities', async () => {
      h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
      await expect(
        h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1'])
      ).resolves.toEqual({ ready: true });
      expect(h.adapter.issuePending).not.toHaveBeenCalled();
    });

    it('checks the served certificate, not the database row, and starts the repair', async () => {
      // The database already names the loopback identities (issued before the
      // daemon had it), but the cluster still serves the old leaf.
      const current = leaf({ issuedDaysAgo: 20 });
      h = harness({ current });
      h.adapter.probe.mockResolvedValue(served(current, ['10.0.0.5']));
      const readiness = await h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1']);
      expect(readiness).toMatchObject({ ready: false, reason: 'renewing' });
      await vi.waitFor(() => expect(h.adapter.promote).toHaveBeenCalled());
      expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: false });

      // A second waiting run inside a minute gets the cached answer.
      h.adapter.probe.mockClear();
      await h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1']);
      expect(h.adapter.probe).not.toHaveBeenCalled();
    });

    it('keeps the backoff of a failing renewal and reports its error', async () => {
      const current = leaf({ issuedDaysAgo: 20 });
      h = harness({ current });
      h.adapter.probe.mockResolvedValue(served(current, ['10.0.0.5']));
      h.adapter.deliver.mockRejectedValue(new Error('engine refused the key'));
      await h.service.renewNow('managed_storage', 'cluster-1');
      h.clock.now += 10 * 60 * 1000;
      const readiness = await h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1']);
      expect(readiness).toMatchObject({ ready: false, reason: 'renewal_failed' });
      expect(readiness.message).toContain('engine refused the key');
      expect(h.adapter.deliver).toHaveBeenCalledTimes(1);
    });

    it('waits for the daemon update when the node cannot reload certificates', async () => {
      h = harness({ supportsHotReload: false, current: leaf({ issuedDaysAgo: 20, sans: ['10.0.0.5'] }) });
      const readiness = await h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1']);
      expect(readiness).toMatchObject({ ready: false, reason: 'waiting_for_daemon' });
      expect(h.adapter.probe).not.toHaveBeenCalled();
    });
  });
});

describe('certificate attention summary', () => {
  it('lists failed, waiting and soon-expiring certificates and leaves healthy ones out', async () => {
    const h = harness();
    expect(await h.service.listAttention()).toEqual([]);

    const expiring = harness({ current: leaf({ issuedDaysAgo: 360 }) });
    expect(await expiring.service.listAttention()).toEqual([
      expect.objectContaining({
        ownerType: 'managed_storage',
        ownerId: 'cluster-1',
        reason: 'expiring',
        daysRemaining: 5,
      }),
    ]);

    const failed = harness();
    await failed.store.save(
      'managed_storage',
      'cluster-1',
      { state: 'failed', lastError: 'daemon offline' },
      new Date(NOW)
    );
    expect(await failed.service.listAttention()).toEqual([expect.objectContaining({ reason: 'renewal_failed' })]);
  });

  it('forgets the cached summary as soon as a renewal changes the state', async () => {
    const h = harness({ current: leaf({ issuedDaysAgo: 360 }) });
    h.adapter.probe.mockImplementation(async () => served(h.pending));
    expect(await h.service.listAttention()).toHaveLength(1);

    // The renewal replaces the expiring leaf; the summary must not keep reporting it.
    h.adapter.promote.mockImplementation(async () => {
      h.target.current = h.pending;
    });
    await h.service.renewDue();
    expect(await h.service.listAttention()).toEqual([]);
  });
});
