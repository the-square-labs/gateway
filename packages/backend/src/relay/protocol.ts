export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_DATABASE_CONTRACT_VERSION = 1;
export const RELAY_DEFAULT_VERSION = '1';
export const RELAY_MAX_CHUNK_BYTES = 1024 * 1024;
export const RELAY_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type RelayNodeType = 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases';
export type RelayManagedDatabaseLane = 'interactive' | 'monitoring';
export type RelayTunnelLane = 'data' | RelayManagedDatabaseLane;

export type RelayHealthReason =
  | 'unreachable'
  | 'tls_unavailable'
  | 'database_unavailable'
  | 'listener_unavailable'
  | 'app_grpc_unavailable'
  | 'contract_mismatch'
  | 'unexpected_image'
  | 'docker_unavailable'
  | 'ownership_unverified';

export interface DatabaseTunnelMessage {
  hello?: { nodeId: string; capability: string; maxChunkBytes: number };
  ready?: { maxChunkBytes: number };
  open?: { tunnelId: string; bindingId: string; managedDatabaseId: string };
  data?: { tunnelId: string; bindingId: string; data: Buffer | Uint8Array };
  close?: { tunnelId: string; bindingId: string };
  error?: { tunnelId: string; bindingId: string; code: string; message: string };
}

export interface RelayManagedDatabaseTunnelMessage {
  open?: { managedDatabaseId: string; lane: string; maxChunkBytes: number };
  ready?: { maxChunkBytes: number };
  data?: { data: Buffer | Uint8Array };
  close?: Record<string, never>;
  error?: { code: string; message: string };
}

export interface RelayStream {
  write(message: DatabaseTunnelMessage): boolean;
  pause(): void;
  resume(): void;
  once(event: 'drain', listener: () => void): RelayStream;
  end?(): void;
}
