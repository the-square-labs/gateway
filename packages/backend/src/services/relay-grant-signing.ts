import type { KeyObject } from 'node:crypto';

/** What signing a grant needs: the policy state, settings and the active key, decrypted once. */
export interface RelayGrantSigningKey {
  state: { revision: number; gatewayInstanceId: string };
  settings: { relayGrantTtlHours: number; relayPolicyLeaseHours: number };
  keyId: string;
  /** Null for an unsigned build (see RelayGrantSigningContext.unsigned). */
  privateKey: KeyObject | null;
}

/**
 * One grant bundle's signing: the state and key are loaded (and the key decrypted) at the first grant and reused for
 * the rest, instead of three reads and a decryption per grant. An unsigned build carries the same claims without
 * signatures: what a bundle allows is compared on its claims (relayGrantBundleFingerprint), so an unchanged bundle is
 * recognised without signing anything.
 */
export class RelayGrantSigningContext {
  private loading?: Promise<RelayGrantSigningKey>;
  /** Per bundle: whether a node and an endpoint's path support the Relay Pool, read once each. */
  private readonly capabilities = new Map<string, Promise<boolean>>();

  constructor(
    private readonly load: (unsigned: boolean) => Promise<RelayGrantSigningKey>,
    readonly unsigned = false
  ) {}

  /** Whether any grant was signed, so the bundle must be checked against the acknowledged revision at its end. */
  get loaded(): boolean {
    return this.loading !== undefined;
  }

  key(): Promise<RelayGrantSigningKey> {
    this.loading ??= this.load(this.unsigned);
    return this.loading;
  }

  capability(key: string, read: () => Promise<boolean>): Promise<boolean> {
    let result = this.capabilities.get(key);
    if (!result) {
      result = read();
      this.capabilities.set(key, result);
    }
    return result;
  }
}
