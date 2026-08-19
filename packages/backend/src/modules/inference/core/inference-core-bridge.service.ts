import { injectable } from 'tsyringe';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceCoreStateRow } from '@/db/schema/inference-core.js';
import { InferenceCredentialVault } from '../inference-credential-vault.js';
import { InferenceCoreClient } from './inference-core.client.js';
import { WIOLETT_CORE_CONTRACT_ID, INFERENCE_CORE_PROTOCOL_MAJOR } from './inference-core.contract.js';
import { InferenceCoreStore } from './inference-core-store.js';
import type { InferenceCoreCredentials } from './inference-core-runtime.service.js';

const CORE_CONTAINER_ALIAS = 'inference-core';
const CORE_PORT = 10100;

/**
 * Gateway ↔ managed-core management bridge. Owns the deterministic mapping
 * between Gateway records and core resources, and builds authenticated clients
 * from the sealed runtime credentials. No browser request ever sees the core
 * endpoint or credential.
 */
@injectable()
export class InferenceCoreBridgeService {
  constructor(
    private readonly store: InferenceCoreStore,
    private readonly vault: InferenceCredentialVault
  ) {}

  /**
   * Whether the managed core is installed and ready. Provider and model
   * management delegate to it as soon as this becomes true, so every new
   * connection is core-backed.
   */
  async coreReady(): Promise<boolean> {
    const row = await this.store.loadState();
    return row?.state === 'ready';
  }

  /** Core state row, or null when the core was never installed. */
  async coreState(): Promise<InferenceCoreStateRow | null> {
    return this.store.loadState();
  }

  /**
   * Authenticated client for a ready core. Throws when the core is not
   * installed, not ready, or its credentials are missing — management calls
   * must fail closed rather than half-configure anything.
   */
  async requireClient(): Promise<InferenceCoreClient> {
    const row = await this.store.loadState();
    if (!row || row.state !== 'ready') {
      throw new AppError(409, 'CORE_NOT_READY', 'The inference core is not ready');
    }
    if (!row.credentialsPayload || !row.credentialsDek) {
      throw new AppError(409, 'CORE_CREDENTIALS_MISSING', 'Core credentials are missing; reinstall the core');
    }
    const credentials = this.vault.open<InferenceCoreCredentials>({
      encryptedPayload: row.credentialsPayload,
      encryptedDek: row.credentialsDek,
      keyVersion: row.credentialKeyVersion ?? 1,
    });
    return new InferenceCoreClient(`http://${CORE_CONTAINER_ALIAS}:${CORE_PORT}`, credentials.managementCredential);
  }

  /** Data-plane credential for the transparent proxy (T5); never exposed to browsers. */
  async dataPlaneCredential(): Promise<string> {
    const row = await this.store.loadState();
    if (!row?.credentialsPayload || !row.credentialsDek) {
      throw new AppError(409, 'CORE_CREDENTIALS_MISSING', 'Core credentials are missing; reinstall the core');
    }
    return this.vault.open<InferenceCoreCredentials>({
      encryptedPayload: row.credentialsPayload,
      encryptedDek: row.credentialsDek,
      keyVersion: row.credentialKeyVersion ?? 1,
    }).dataCredential;
  }

  /**
   * Data-plane endpoint + credential for the transparent proxy. Fails closed
   * unless the core is installed and ready — a degraded core must never
   * receive traffic it cannot settle.
   */
  async dataPlaneTarget(): Promise<{ baseUrl: string; credential: string }> {
    const row = await this.store.loadState();
    if (!row || row.state !== 'ready') {
      throw new AppError(409, 'CORE_NOT_READY', 'The inference core is not ready');
    }
    return { baseUrl: `http://${CORE_CONTAINER_ALIAS}:${CORE_PORT}`, credential: await this.dataPlaneCredential() };
  }

  /** Callback credential used to verify core → Gateway internal callbacks (T5). */
  async callbackCredential(): Promise<string> {
    const row = await this.store.loadState();
    if (!row?.credentialsPayload || !row.credentialsDek) {
      throw new AppError(409, 'CORE_CREDENTIALS_MISSING', 'Core credentials are missing; reinstall the core');
    }
    return this.vault.open<InferenceCoreCredentials>({
      encryptedPayload: row.credentialsPayload,
      encryptedDek: row.credentialsDek,
      keyVersion: row.credentialKeyVersion ?? 1,
    }).callbackCredential;
  }

  /** Deterministic core provider name for a Gateway connection row. */
  coreProviderName(connectionId: string): string {
    return `core-${connectionId}`;
  }

  /**
   * Map Gateway routing names by SEMANTICS, never by name (plan decision 27).
   * Gateway `balanced` is remaining-quota weighting, which in the current
   * OpenCodex pool vocabulary is `balanced` (proportional to remaining quota —
   * not `quota`, which is lowest-usage threshold switching). `even` is equal
   * distribution and `sequential` keeps the current account until its quota
   * threshold, matching Gateway's priority order.
   */
  mapRoutingStrategy(strategy: 'balanced' | 'even' | 'sequential'): 'balanced' | 'even' | 'sequential' {
    switch (strategy) {
      case 'balanced':
        return 'balanced';
      case 'even':
        return 'even';
      case 'sequential':
        return 'sequential';
    }
  }

  /** Verify a management response carries the contract identity. */
  async verifyCoreIdentity(client: InferenceCoreClient): Promise<boolean> {
    const identity = await client.health();
    return (
      identity != null &&
      identity.contractId === WIOLETT_CORE_CONTRACT_ID &&
      identity.coreProtocolMajor === INFERENCE_CORE_PROTOCOL_MAJOR
    );
  }
}
