/**
 * TypeScript types matching proto/gateway/v1/nginx-daemon.proto
 * These are used with @grpc/proto-loader for runtime loading.
 */

import type { DockerMigrationCommand } from './migration-types.js';

export type * from './migration-types.js';

// ─── Enrollment ─────────────────────────────────────────────────────

export interface EnrollRequest {
  token: string;
  hostname: string;
  nginxVersion: string;
  osInfo: string;
  daemonVersion: string;
  daemonType: string;
}

export interface EnrollResponse {
  nodeId: string;
  caCertificate: Buffer;
  clientCertificate: Buffer;
  clientKey: Buffer;
  certExpiresAt: string; // int64 as string
}

export interface RenewCertRequest {
  nodeId: string;
}

export interface RenewCertResponse {
  clientCertificate: Buffer;
  clientKey: Buffer;
  certExpiresAt: string;
}

// ─── Daemon Messages (daemon → gateway) ─────────────────────────────

export interface DaemonMessage {
  register?: RegisterMessage;
  commandResult?: CommandResult;
  healthReport?: HealthReport;
  statsReport?: StatsReport;
  daemonLog?: DaemonLogEntry;
  execOutput?: ExecOutput;
}

export interface DaemonLogEntry {
  timestamp: string;
  level: string;
  message: string;
  component: string;
  fields: Record<string, string>;
}

export interface RegisterMessage {
  nodeId: string;
  hostname: string;
  nginxVersion: string;
  configVersionHash: string;
  daemonVersion: string;
  nginxUptimeSeconds: string;
  nginxRunning: boolean;
  cpuModel: string;
  cpuCores: number;
  architecture: string;
  kernelVersion: string;
  daemonType: string;
  capabilities: string[];
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  error: string;
  detail: string;
  data: Buffer;
}

export interface GpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  utilizationPercent: number;
  memoryTotalBytes: string;
  memoryUsedBytes: string;
  temperatureCelsius: number;
  powerWatts: number;
  powerLimitWatts: number;
  throttled: boolean;
  eccCorrectedErrors: string;
  eccUncorrectedErrors: string;
  health: string;
  availableMetrics: string[];
}

export interface HealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: string;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: string;
  diskFreeBytes: string;
  timestamp: string;
  // New fields (add after timestamp)
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: string;
  systemMemoryUsedBytes: string;
  systemMemoryAvailableBytes: string;
  swapTotalBytes: string;
  swapUsedBytes: string;
  systemUptimeSeconds: string;
  openFileDescriptors: string;
  maxFileDescriptors: string;
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: string;
    usedBytes: string;
    freeBytes: string;
    usagePercent: number;
  }>;
  diskReadBytes: string;
  diskWriteBytes: string;
  networkInterfaces: Array<{
    name: string;
    rxBytes: string;
    txBytes: string;
    rxPackets: string;
    txPackets: string;
    rxErrors: string;
    txErrors: string;
  }>;
  localIpAddresses: string[];
  publicIpAddresses: string[];
  nginxRssBytes: string;
  errorRate4xx: number;
  errorRate5xx: number;
  // Docker
  containerStats: ContainerStats[];
  dockerVersion: string;
  containersRunning: number;
  containersStopped: number;
  containersTotal: number;
  gpuDevices: GpuDevice[];
}

export interface StatsReport {
  activeConnections: string;
  accepts: string;
  handled: string;
  requests: string;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: string;
}

// ─── Gateway Commands (gateway → daemon) ────────────────────────────

export interface GatewayCommand {
  commandId: string;
  applyConfig?: ApplyConfigCommand;
  removeConfig?: RemoveConfigCommand;
  deployCert?: DeployCertCommand;
  removeCert?: RemoveCertCommand;
  fullSync?: FullSyncCommand;
  updateGlobalConfig?: UpdateGlobalConfigCommand;
  deployHtpasswd?: DeployHtpasswdCommand;
  testConfig?: TestConfigCommand;
  requestHealth?: RequestHealthCommand;
  requestStats?: RequestStatsCommand;
  setDaemonLogStream?: SetDaemonLogStreamCommand;
  removeHtpasswd?: RemoveHtpasswdCommand;
  deployAcmeChallenge?: DeployAcmeChallengeCommand;
  removeAcmeChallenge?: RemoveAcmeChallengeCommand;
  readGlobalConfig?: ReadGlobalConfigCommand;
  requestTrafficStats?: RequestTrafficStatsCommand;
  dockerContainer?: DockerContainerCommand;
  dockerImage?: DockerImageCommand;
  dockerVolume?: DockerVolumeCommand;
  dockerNetwork?: DockerNetworkCommand;
  dockerDeployment?: DockerDeploymentCommand;
  dockerExec?: DockerExecCommand;
  dockerFile?: DockerFileCommand;
  dockerConfigPush?: DockerConfigPushCommand;
  dockerLogs?: DockerLogsCommand;
  execInput?: ExecInput;
  nodeExec?: NodeExecCommand;
  updateDaemon?: UpdateDaemonCommand;
  nodeFile?: NodeFileCommand;
  dockerMigration?: DockerMigrationCommand;
  dockerDatabase?: DockerDatabaseCommand;
  applyTlsBundle?: ApplyTlsBundleCommand;
  inspectCertificates?: InspectCertificatesCommand;
  exportLegacyCertificates?: ExportLegacyCertificatesCommand;
  removeCertificateReplica?: RemoveCertificateReplicaCommand;
  syncRelayGrants?: SyncRelayGrantsCommand;
}

export interface ApplyConfigCommand {
  hostId: string;
  configContent: string;
  testOnly: boolean;
}

export interface RemoveConfigCommand {
  hostId: string;
}

export interface DeployCertCommand {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
}

export interface ApplyTlsBundleCommand {
  hostId: string;
  configContent: string;
  certificates: VersionedCertBundle[];
  generation: string;
}

export interface VersionedCertBundle {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
  version: string;
  replicaGeneration: string;
}

export interface InspectCertificatesCommand {
  certIds: string[];
}

export interface ExportLegacyCertificatesCommand {
  certIds: string[];
}

export interface RemoveCertificateReplicaCommand {
  certId: string;
  expectedVersion: string;
  expectedReplicaGeneration: string;
}

export interface RemoveCertCommand {
  certId: string;
}

export interface FullSyncCommand {
  hosts: HostConfig[];
  certs: CertBundle[];
  globalConfig: string;
  htpasswdFiles: HtpasswdFile[];
  versionHash: string;
}

export interface HostConfig {
  hostId: string;
  configContent: string;
}

export interface CertBundle {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
}

export interface HtpasswdFile {
  accessListId: string;
  content: string;
}

export interface UpdateGlobalConfigCommand {
  content: string;
  backupContent: string;
}

export interface DeployHtpasswdCommand {
  accessListId: string;
  content: string;
}

export interface RemoveHtpasswdCommand {
  accessListId: string;
}

export type TestConfigCommand = Record<string, never>;
export type RequestHealthCommand = Record<string, never>;
export type RequestStatsCommand = Record<string, never>;
export type ReadGlobalConfigCommand = Record<string, never>;

export interface RequestTrafficStatsCommand {
  tailLines: number;
}

export interface SetDaemonLogStreamCommand {
  enabled: boolean;
  minLevel: string;
  tailLines: number;
}

export interface DeployAcmeChallengeCommand {
  token: string;
  content: string;
}

export interface RemoveAcmeChallengeCommand {
  token: string;
}

// ─── Docker Commands ────────────────────────────────────────────────

export interface DockerContainerCommand {
  action: string;
  containerId: string;
  configJson: string;
  timeoutSeconds: number;
  signal: string;
  newName: string;
  force: boolean;
}

export interface DockerImageCommand {
  action: string;
  imageRef: string;
  registryAuthJson: string;
  force: boolean;
}

export interface DockerVolumeCommand {
  action: string;
  name: string;
  driver: string;
  labels: Record<string, string>;
  force: boolean;
  path: string;
  maxBytes: number;
  newName: string;
  content: Buffer;
  targetPath: string;
}

export interface DockerNetworkCommand {
  action: string;
  networkId: string;
  containerId: string;
  driver: string;
  subnet: string;
  gatewayAddr: string;
}

export interface DockerDeploymentCommand {
  action: string;
  deploymentId: string;
  slot: string;
  configJson: string;
  force: boolean;
}

export interface DockerExecCommand {
  action: string;
  containerId: string;
  command: string[];
  tty: boolean;
  stdin: boolean;
  rows: number;
  cols: number;
  user?: string;
  sessionKey?: string;
}

export interface DockerFileCommand {
  action: string;
  containerId: string;
  path: string;
  targetPath: string;
  maxBytes: number;
  content?: Buffer;
}

export interface DockerConfigPushCommand {
  registries: RegistryConfig[];
  allowlist: string[];
}

export interface RegistryConfig {
  url: string;
  username: string;
  password: string;
}

export interface DockerLogsCommand {
  containerId: string;
  tailLines: number;
  follow: boolean;
  timestamps: boolean;
  since?: string;
  until?: string;
}

/** Restricted lifecycle command accepted only by a database-profile docker daemon. */
export interface DockerDatabaseCommand {
  action: string;
  managedDatabaseId: string;
  configJson: string;
}

/** Admission control for a first-party database connector sidecar on a Docker node. */
export interface SyncRelayGrantsCommand {
  policyRevision: string;
  generatedAtUnixMs: string;
  grants: RelayGrantAssignment[];
}

export interface RelayGrantAssignment {
  role: string;
  ownerKind: string;
  ownerId: string;
  endpointId?: string;
  routeId?: string;
  targetEndpointId?: string;
  grant: RelaySignedGrant;
}

export interface RelaySignedGrant {
  keyId: string;
  payload: Buffer;
  signature: Buffer;
}

export interface NodeExecCommand {
  action: string;
  command: string[];
  tty: boolean;
  rows: number;
  cols: number;
  sessionKey?: string;
}

export interface NodeFileCommand {
  action: string;
  path: string;
  targetPath: string;
  maxBytes: number;
  content?: Buffer;
}

export interface ExecInput {
  execId: string;
  data: Buffer;
}

export interface ExecOutput {
  execId: string;
  data: Buffer;
  exited: boolean;
  exitCode: number;
}

export interface ContainerStats {
  containerId: string;
  name: string;
  image: string;
  state: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

// ─── Log Streaming ──────────────────────────────────────────────────

export interface LogStreamMessage {
  subscribeAck?: LogSubscribeAck;
  entry?: LogEntry;
}

export interface LogSubscribeAck {
  hostId: string;
}

export interface LogEntry {
  hostId: string;
  timestamp: string;
  remoteAddr: string;
  method: string;
  path: string;
  status: number;
  bodyBytesSent: string;
  referer: string;
  userAgent: string;
  upstreamResponseTime: string;
  raw: string;
  logType: string;
  level: string;
}

export interface LogStreamControl {
  subscribe?: LogSubscribe;
  unsubscribe?: LogUnsubscribe;
}

export interface LogSubscribe {
  hostId: string;
  tailLines: number;
}

export interface LogUnsubscribe {
  hostId: string;
}

export interface UpdateDaemonCommand {
  downloadUrl: string;
  targetVersion: string;
  checksum: string;
  signedManifest: string;
}
