import { randomUUID } from 'node:crypto';
import {
  OPERATION_LEASE_PROCESS,
  type OperationLeaseClaim,
  type OperationLeaseHold,
  OperationLeaseLostError,
  type OperationLeaseStore,
  operationLeaseKey,
} from '@/db/operation-lease.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';

const logger = createChildLogger('DockerContainerTransitions');

export type ContainerTransition =
  | 'creating'
  | 'stopping'
  | 'restarting'
  | 'killing'
  | 'recreating'
  | 'updating'
  | 'migrating';

/** Proof of ownership for names claimed together with `claim`; only its holder releases them. */
export interface ContainerTransitionClaim {
  readonly nodeId: string;
  readonly names: readonly string[];
  readonly token: symbol;
}

/** Lease row data for container names: the transitions it backs. */
interface ContainerLeaseData {
  nodeId: string;
  states: Record<string, ContainerTransition | 'busy'>;
}

/** One lease token over the names acquired together; renewed while any of them is held. */
interface ContainerLeaseHold {
  token: string;
  leaseKeys: Set<string>;
  heartbeat: OperationLeaseHold;
}

export class DockerContainerTransitions {
  private readonly transitions = new Map<string, ContainerTransition>();
  /** Owner of a transition set through `claim`; `set` and `clear` drop it. */
  private readonly owners = new Map<string, symbol>();
  /** Makes transitions backed by `acquireLeases` exclusive across backend processes. */
  private leaseStore?: OperationLeaseStore;
  /** Holder of this map's leases (process and map), so it can take back a lease it failed to release. */
  private readonly leaseHolder = `${OPERATION_LEASE_PROCESS}:transitions:${randomUUID()}`;
  /** The lease backing a name's transition, until that transition ends here. */
  private readonly leases = new Map<string, { hold: ContainerLeaseHold; leaseKey: string }>();
  /** Lease keys this map holds or is claiming. */
  private readonly activeLeaseKeys = new Set<string>();

  setLeaseStore(store: OperationLeaseStore) {
    this.leaseStore = store;
  }

  requireIdle(nodeId: string, name: string) {
    const current = this.get(nodeId, name);
    if (current) {
      throw new AppError(409, 'CONTAINER_BUSY', `Container is currently ${current}`);
    }
  }

  set(nodeId: string, name: string, state: ContainerTransition): boolean {
    if (this.get(nodeId, name) === state) return false;
    const key = this.key(nodeId, name);
    this.transitions.set(key, state);
    this.owners.delete(key);
    return true;
  }

  clear(nodeId: string, name: string) {
    const key = this.key(nodeId, name);
    this.transitions.delete(key);
    this.owners.delete(key);
    this.dropLease(key);
  }

  /**
   * Claim several names at once, synchronously: either every name was idle and
   * is now held with the given state, or nothing changes and 409 is thrown.
   * Call it with no `await` between the checks it replaces and the claim.
   */
  claim(
    nodeId: string,
    entries: ReadonlyArray<{ name: string; state: ContainerTransition }>
  ): ContainerTransitionClaim {
    const unique = new Map<string, ContainerTransition>();
    for (const entry of entries) if (!unique.has(entry.name)) unique.set(entry.name, entry.state);
    for (const name of unique.keys()) {
      const current = this.get(nodeId, name);
      if (current) throw new AppError(409, 'CONTAINER_BUSY', `Container "${name}" is currently ${current}`);
    }
    const token = Symbol('container-transition-claim');
    for (const [name, state] of unique) {
      const key = this.key(nodeId, name);
      this.transitions.set(key, state);
      this.owners.set(key, token);
    }
    return { nodeId, names: [...unique.keys()], token };
  }

  /** Release a claim's names, skipping any another operation has taken over since. */
  release(claim: ContainerTransitionClaim) {
    for (const name of claim.names) {
      const key = this.key(claim.nodeId, name);
      if (this.owners.get(key) !== claim.token) continue;
      this.transitions.delete(key);
      this.owners.delete(key);
      this.dropLease(key);
    }
  }

  /**
   * Backs the transitions this process holds on `names` with database leases,
   * so another backend process cannot start a leased operation (rename,
   * update, migration admission) on them meanwhile. Call it right after
   * claiming the names here. Each lease lasts until the name's transition ends
   * here (`clear` or `release`) and is renewed until then; a process that stops
   * leaves leases that lapse. All names or none: when another process holds
   * one, 409 CONTAINER_BUSY and this process's own transitions are left for
   * the caller to give back. Without a lease store this is a no-op.
   *
   * Names whose transition this map already backs with a lease are confirmed
   * instead: renewed at once, so no other process can take them for a full
   * TTL from here. Call it again right before a step only the lease's owner
   * may take. A lease that was lost meanwhile (it lapsed and another process
   * took it over, or it could not be renewed in time) no longer protects the
   * transition: 409 CONTAINER_BUSY (details.leaseLost), and the operation must
   * stop.
   */
  async acquireLeases(nodeId: string, names: readonly string[]): Promise<void> {
    const store = this.leaseStore;
    if (!store) return;
    const unique = [...new Set(names)];
    await this.confirmLeases(
      nodeId,
      unique.filter((name) => this.leases.has(this.key(nodeId, name)))
    );
    const wanted = unique.filter((name) => !this.leases.has(this.key(nodeId, name)));
    if (wanted.length === 0) return;
    const leaseKeys = wanted.map((name) => containerLeaseKey(nodeId, name));
    if (leaseKeys.some((leaseKey) => this.activeLeaseKeys.has(leaseKey))) {
      throw new AppError(409, 'CONTAINER_BUSY', 'Container is currently being claimed by another operation');
    }
    const states: ContainerLeaseData['states'] = Object.fromEntries(
      wanted.map((name) => [name, this.get(nodeId, name) ?? ('busy' as const)])
    );
    for (const leaseKey of leaseKeys) this.activeLeaseKeys.add(leaseKey);
    let claim: OperationLeaseClaim<ContainerLeaseData>;
    try {
      claim = await store.claim<ContainerLeaseData>(
        leaseKeys,
        { nodeId, states },
        {
          holder: this.leaseHolder,
          // A lease of this map on a key it no longer uses is one whose release
          // has not landed yet (or failed): it is taken back.
          replaceable: (lease, leaseKey) => lease.holder === this.leaseHolder && !this.leaseKeyInUse(leaseKey),
        }
      );
    } finally {
      for (const leaseKey of leaseKeys) this.activeLeaseKeys.delete(leaseKey);
    }
    if (!claim.acquired) {
      const name = wanted[leaseKeys.indexOf(claim.key)] ?? wanted[0]!;
      const state = claim.lease.data.states?.[name] ?? 'busy';
      throw new AppError(409, 'CONTAINER_BUSY', `Container "${name}" is currently ${state}`, { name, elsewhere: true });
    }
    const heldKeys = new Set(leaseKeys);
    // Once lost, the lease is no longer renewed, and confirming it (above)
    // refuses the operation's further owner-only steps.
    const heartbeat = store.hold(
      () => [...heldKeys],
      claim.token,
      (leaseKey) =>
        logger.error('Container operation lost its lease while running; it no longer holds the container', {
          nodeId,
          leaseKey,
        }),
      { since: claim.claimedAt }
    );
    const hold: ContainerLeaseHold = { token: claim.token, leaseKeys: heldKeys, heartbeat };
    for (const [index, name] of wanted.entries()) {
      const key = this.key(nodeId, name);
      // The transition may have ended here while the lease was being claimed.
      if (!this.transitions.has(key) || this.leases.has(key)) this.releaseLease(hold, leaseKeys[index]!);
      else this.leases.set(key, { hold, leaseKey: leaseKeys[index]! });
    }
  }

  /** Renews the leases backing transitions here on `names`; 409 CONTAINER_BUSY when one was lost. */
  private async confirmLeases(nodeId: string, names: readonly string[]): Promise<void> {
    const byHold = new Map<ContainerLeaseHold, string[]>();
    for (const name of names) {
      const lease = this.leases.get(this.key(nodeId, name));
      if (lease) byHold.set(lease.hold, [...(byHold.get(lease.hold) ?? []), name]);
    }
    for (const [hold, heldNames] of byHold) {
      if (await hold.heartbeat.confirm()) continue;
      const reason = hold.heartbeat.signal.reason;
      const lostKeys = reason instanceof OperationLeaseLostError ? reason.keys : [];
      const name = heldNames.find((item) => lostKeys.includes(containerLeaseKey(nodeId, item))) ?? heldNames[0]!;
      throw new AppError(
        409,
        'CONTAINER_BUSY',
        `Container "${name}" is no longer held by this operation: its lease lapsed or another backend process took it over`,
        { name, elsewhere: true, leaseLost: true }
      );
    }
  }

  /** Whether a lease key backs a transition here; claims in flight do not count, they claim for themselves. */
  private leaseKeyInUse(leaseKey: string): boolean {
    for (const lease of this.leases.values()) if (lease.leaseKey === leaseKey) return true;
    return false;
  }

  isClaimedBy(nodeId: string, name: string, claim: ContainerTransitionClaim | undefined): boolean {
    return !!claim && claim.nodeId === nodeId && this.owners.get(this.key(nodeId, name)) === claim.token;
  }

  get(nodeId: string, name: string): ContainerTransition | undefined {
    return this.transitions.get(this.key(nodeId, name));
  }

  private key(nodeId: string, name: string) {
    return `${nodeId}:${name}`;
  }

  private dropLease(key: string) {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);
    this.releaseLease(lease.hold, lease.leaseKey);
  }

  private releaseLease(hold: ContainerLeaseHold, leaseKey: string) {
    hold.leaseKeys.delete(leaseKey);
    if (hold.leaseKeys.size === 0) hold.heartbeat.stop();
    // Not awaited: `clear` and `release` stay synchronous. A lease whose
    // release is still in flight (or failed) is taken back by this map's next
    // claim of the name, and lapses for other processes.
    void this.leaseStore?.release([leaseKey], hold.token).catch((error) =>
      logger.warn('Could not release a container operation lease', {
        leaseKey,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

function containerLeaseKey(nodeId: string, name: string) {
  return operationLeaseKey('docker-container', `${nodeId}:${name}`);
}
