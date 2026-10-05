import { hkdfSync, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import type { NodeRelayStreamReport } from '@/db/schema/nodes.js';
import type { RelayRouteResumeState } from '@/db/schema/relay.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from './crypto.service.js';

/**
 * Resumable relay streams (RSv1, packages/daemons/shared/relayresume/doc.go): Gateway's part.
 *
 * - One instance secret, envelope-encrypted in relay_policy_state. Every route resume key derives from it with
 *   HKDF-SHA256 and the route's key_version; keys reach the daemons only over their control sessions.
 * - A route is resumable only while its source (a daemon advertising the capability, or Gateway itself) and its
 *   target daemon both support it. Anything else keeps today's raw streams.
 * - Turning a route on, rotating its key and turning it off are ordered, so a source never holds a key its target
 *   does not accept: targets first when enabling or rotating, sources first when disabling. See
 *   RelayStreamResumeService.reconcile.
 */

const logger = createChildLogger('RelayStreamResume');

export const RELAY_STREAM_RESUME_CAPABILITY = 'relay_stream_resume_v1';
export const RELAY_STREAM_RESUME_VERSION = 1;
/** Gateway's own TypeScript source (database tools, storage browser) speaks RSv1 (task T6). */
export const GATEWAY_STREAM_RESUME_CAPABLE = true;
const KDF_DOMAIN = 'gw-relay-resume/v1';
const KEY_LEN = 32;
/** Route keys are replaced this often; the target keeps the previous key until the next rotation. */
export const RESUME_KEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
/** Proxy routes: what the relay's half-close reaping did (bridge.go), now enforced by the endpoints. */
export const PROXY_HALF_CLOSE_TIMEOUT_MS = 30_000;
/** Resumable streams leave a draining relay this long before its drain disconnects what is left. */
export const DRAIN_DEADLINE_MARGIN_MS = 15_000;

/** How long an update waits for a relay's streams to end on their own before it disconnects the rest. */
export const RELAY_UPDATE_DRAIN_GRACE_MS = 30 * 60_000;
/** An operator drain disconnects what is left after this long. */
export const MANUAL_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Either drain, when every stream through the relay can move to another relay on its own. */
export const RESUMABLE_DRAIN_GRACE_MS = 2 * 60_000;

/** The HKDF info of a route key: domain ‖ u16be(len(route_id)) ‖ route_id ‖ u64be(key_version). */
export function resumeKdfInfo(routeId: string, keyVersion: number | bigint): Buffer {
  const route = Buffer.from(routeId, 'utf8');
  if (route.length > 0xffff) throw new Error('Relay route id is too long for a resume key');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(route.length);
  const version = Buffer.alloc(8);
  version.writeBigUInt64BE(BigInt(keyVersion));
  return Buffer.concat([Buffer.from(KDF_DOMAIN, 'utf8'), length, route, version]);
}

export function deriveRouteResumeKey(secret: Buffer, routeId: string, keyVersion: number | bigint): Buffer {
  if (secret.length !== KEY_LEN) throw new Error('Relay stream resume secret must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), resumeKdfInfo(routeId, keyVersion), KEY_LEN));
}

export function resumeKeyId(keyVersion: number | bigint): string {
  return `v${keyVersion}`;
}

export interface RelayStreamResumeAssignment {
  version: number;
  keyId: string;
  key: Buffer;
  halfCloseTimeoutMs?: number;
}

export interface RelayRouteResumeAssignment {
  routeId: string;
  version: number;
  keyId: string;
  key: Buffer;
  prevKeyId?: string;
  prevKey?: Buffer;
}

type RouteResumeColumns = Pick<
  typeof relayRoutes.$inferSelect,
  'id' | 'ownerKind' | 'resumeState' | 'keyVersion' | 'prevKeyVersion'
>;

/** The target lists the route (accepts HELLO/RESUME) in every state but off. */
export function targetAcceptsResume(state: RelayRouteResumeState | null | undefined): boolean {
  return state === 'enabling' || state === 'on' || state === 'rotating' || state === 'disabling';
}

/** The key version sources open resumable streams with, or null for raw streams. */
export function sourceResumeKeyVersion(
  route: Pick<RouteResumeColumns, 'resumeState' | 'keyVersion' | 'prevKeyVersion'>
): number | null {
  if (route.resumeState === 'on') return route.keyVersion;
  // Until every target holds the new key, sources keep the one they have.
  if (route.resumeState === 'rotating') return route.prevKeyVersion ?? null;
  return null;
}

export function routeHalfCloseTimeoutMs(ownerKind: string): number {
  return ownerKind === 'proxy_host_secure_link' ? PROXY_HALF_CLOSE_TIMEOUT_MS : 0;
}

export function sourceStreamResume(
  secret: Buffer | null,
  route: RouteResumeColumns
): RelayStreamResumeAssignment | undefined {
  const version = sourceResumeKeyVersion(route);
  if (!secret || version == null) return undefined;
  const halfCloseTimeoutMs = routeHalfCloseTimeoutMs(route.ownerKind);
  return {
    version: RELAY_STREAM_RESUME_VERSION,
    keyId: resumeKeyId(version),
    key: deriveRouteResumeKey(secret, route.id, version),
    ...(halfCloseTimeoutMs ? { halfCloseTimeoutMs } : {}),
  };
}

export function targetRouteResume(
  secret: Buffer | null,
  route: RouteResumeColumns
): RelayRouteResumeAssignment | undefined {
  if (!secret || !targetAcceptsResume(route.resumeState)) return undefined;
  const prev = route.prevKeyVersion;
  return {
    routeId: route.id,
    version: RELAY_STREAM_RESUME_VERSION,
    keyId: resumeKeyId(route.keyVersion),
    key: deriveRouteResumeKey(secret, route.id, route.keyVersion),
    ...(prev != null && prev !== route.keyVersion
      ? { prevKeyId: resumeKeyId(prev), prevKey: deriveRouteResumeKey(secret, route.id, prev) }
      : {}),
  };
}

/** Drain grace: short when every stream through the relay moves on its own, today's otherwise. */
export function drainGraceMs(kind: 'update' | 'manual', fullyResumable: boolean): number {
  if (fullyResumable) return RESUMABLE_DRAIN_GRACE_MS;
  return kind === 'update' ? RELAY_UPDATE_DRAIN_GRACE_MS : MANUAL_DRAIN_TIMEOUT_MS;
}

/**
 * Whether every route to an endpoint assigned to this relay is resumable: its streams then leave the relay by
 * themselves when it drains. Built-in local services are left out: a draining local relay keeps serving them.
 * A relay with no routed workload counts as resumable; there is nothing to wait for. `legacySessions`: raw streams
 * the daemons report through this relay (opened before their routes turned resumable, or by an older Gateway), which
 * only today's grace lets end on their own.
 */
export async function relayInstanceFullyResumable(
  db: DrizzleClient,
  instanceId: string,
  legacySessions = 0
): Promise<boolean> {
  if (legacySessions > 0) return false;
  const rows = await db
    .selectDistinct({ routeId: relayRoutes.id, resumeState: relayRoutes.resumeState })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
    )
    .innerJoin(relayEndpoints, eq(relayEndpointAssignmentGenerations.endpointId, relayEndpoints.id))
    .innerJoin(relayRoutes, eq(relayRoutes.targetEndpointId, relayEndpoints.id))
    .where(
      and(
        eq(relayEndpointAssignments.relayInstanceId, instanceId),
        inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining']),
        ne(relayEndpoints.subjectKind, 'local_service')
      )
    );
  return rows.every(({ resumeState }) => resumeState === 'on');
}

export async function relayDrainGraceMs(
  db: DrizzleClient,
  instanceId: string,
  kind: 'update' | 'manual',
  legacySessions = 0
): Promise<number> {
  try {
    return drainGraceMs(kind, await relayInstanceFullyResumable(db, instanceId, legacySessions));
  } catch (error) {
    logger.warn('Could not tell whether a relay carries only resumable streams; using the full drain grace', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return drainGraceMs(kind, false);
  }
}

/** The deadline a drain starting now ends at, never later than one already running. */
export function drainDeadline(
  instance: { state: string; drainDeadlineAt: Date | null },
  graceMs: number,
  now = Date.now()
): Date {
  const candidate = now + graceMs;
  if (instance.state === 'draining' && instance.drainDeadlineAt) {
    return new Date(Math.min(instance.drainDeadlineAt.getTime(), candidate));
  }
  return new Date(candidate);
}

/** What a draining candidate tells resumable sources: leave before this (unix ms, int64 as a string). */
export function candidateDrainDeadline(drainDeadlineAt: Date | null | undefined): string | undefined {
  if (!drainDeadlineAt) return undefined;
  return String(Math.max(1, drainDeadlineAt.getTime() - DRAIN_DEADLINE_MARGIN_MS));
}

export type RelayStreamReports = ReadonlyArray<{ nodeId: string; report: NodeRelayStreamReport }>;

/**
 * Open streams through one relay as the daemons report them; each daemon counts the streams it opened (the source
 * side). `reporting` is false when no daemon reports streams at all.
 */
export function relaySessionSplit(
  reports: RelayStreamReports,
  relayInstanceId: string
): { resumable: number; legacy: number; reporting: boolean } {
  let resumable = 0;
  let legacy = 0;
  for (const { report } of reports) {
    for (const relay of report.byRelay) {
      if (relay.relayInstanceId !== relayInstanceId) continue;
      resumable += relay.resumable;
      legacy += relay.legacy;
    }
  }
  return { resumable, legacy, reporting: reports.length > 0 };
}

/** Per daemon: streams it moved to another relay and resumable streams it lost, since it started. */
export type RelayStreamCounters = Map<string, { moved: number; cut: number }>;

export function relayStreamCounters(reports: RelayStreamReports): RelayStreamCounters {
  return new Map(
    reports.map(({ nodeId, report }) => [nodeId, { moved: report.migrationsOkTotal, cut: report.cutTotal }])
  );
}

/**
 * What happened between two counter snapshots. A daemon that restarted meanwhile (its totals went back) counts from
 * zero; one that only appears in `after` is left out, as its totals do not start at `before`.
 */
export function relayStreamOutcome(
  before: RelayStreamCounters,
  after: RelayStreamCounters
): { moved: number; cut: number } {
  let moved = 0;
  let cut = 0;
  for (const [nodeId, current] of after) {
    const previous = before.get(nodeId);
    if (!previous) continue;
    moved += current.moved >= previous.moved ? current.moved - previous.moved : current.moved;
    cut += current.cut >= previous.cut ? current.cut - previous.cut : current.cut;
  }
  return { moved, cut };
}

function streams(count: number): string {
  return count === 1 ? '1 stream' : `${count} streams`;
}

/**
 * The step note of a drained relay: streams that moved to other relays and streams that were cut, the resumable ones
 * that could not move plus the raw ones the forced disconnect ended. Null when nothing moved or was cut.
 */
export function drainOutcomeNote(outcome: { moved: number; cut: number }, legacyDisconnected = 0): string | null {
  const cut = outcome.cut + legacyDisconnected;
  if (!outcome.moved && !cut) return null;
  if (!cut) return `${streams(outcome.moved)} moved to other relays, none cut.`;
  return `${streams(outcome.moved)} moved to other relays, ${streams(cut)} cut.`;
}

/** The step note of a local relay recreated without another relay: its resumable streams paused and resumed. */
export function localRelayPauseNote(pausedMs: number, outcome: { moved: number; cut: number }, reason: string): string {
  const seconds = Math.max(1, Math.round(pausedMs / 1000));
  const resumed = outcome.moved ? `; ${streams(outcome.moved)} resumed` : '';
  const cut = outcome.cut ? `, ${streams(outcome.cut)} cut` : '';
  return `Streams through the local relay paused for ${seconds} s while it was recreated (${reason})${resumed}${cut}.`;
}

export interface ResumeRouteState {
  id: string;
  resumeState: RelayRouteResumeState;
  keyRotatedAt: Date | null;
  /** Source and target both support resumable streams. */
  desired: boolean;
}

export interface ResumeTransitionPlan {
  /** Targets first, then sources. off → enabling, or an enabling route whose targets were not confirmed yet. */
  enable: string[];
  /** Targets first, then sources. on → rotating with a new key, or a rotation whose targets were not confirmed yet. */
  rotate: string[];
  /** Targets only: enabling → off (no source ever got a key). */
  cancel: string[];
  /** Sources first, then targets. on/rotating → disabling, or a disable whose sources were not confirmed yet. */
  disable: string[];
  /** Sources only: disabling → on (the targets never dropped the route). */
  reenable: string[];
}

export function planResumeTransitions(routes: readonly ResumeRouteState[], now = Date.now()): ResumeTransitionPlan {
  const plan: ResumeTransitionPlan = { enable: [], rotate: [], cancel: [], disable: [], reenable: [] };
  for (const route of routes) {
    switch (route.resumeState) {
      case 'off':
        if (route.desired) plan.enable.push(route.id);
        break;
      case 'enabling':
        (route.desired ? plan.enable : plan.cancel).push(route.id);
        break;
      case 'on':
        if (!route.desired) plan.disable.push(route.id);
        else if (!route.keyRotatedAt || now - route.keyRotatedAt.getTime() >= RESUME_KEY_ROTATION_MS) {
          plan.rotate.push(route.id);
        }
        break;
      case 'rotating':
        (route.desired ? plan.rotate : plan.disable).push(route.id);
        break;
      case 'disabling':
        (route.desired ? plan.reenable : plan.disable).push(route.id);
        break;
    }
  }
  return plan;
}

export interface RelayStreamResumeHost {
  /** Delivers the node's grant bundle and resolves once the daemon applied it. */
  syncNodeGrants(nodeId: string): Promise<void>;
}

interface RouteEnds {
  id: string;
  sourceKind: string;
  sourceId: string;
  targetNodeId: string | null;
}

export class RelayStreamResumeService {
  private cachedSecret: Buffer | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: Pick<CryptoService, 'encryptPrivateKey' | 'decryptPrivateKey'>,
    private readonly host: RelayStreamResumeHost
  ) {}

  /** Creates the instance secret once. Never replaced: route keys rotate through their key_version. */
  async ensureInitialized(): Promise<void> {
    const generated = randomBytes(KEY_LEN);
    const encrypted = this.cryptoService.encryptPrivateKey(generated.toString('hex'));
    await this.db
      .update(relayPolicyState)
      .set({ resumeSecretEncrypted: encrypted.encryptedPrivateKey, resumeSecretDek: encrypted.encryptedDek })
      .where(and(eq(relayPolicyState.id, 'current'), isNull(relayPolicyState.resumeSecretEncrypted)));
    this.cachedSecret = null;
    await this.secret();
  }

  /** The instance secret, or null before it exists (no route is resumable then). */
  async secret(): Promise<Buffer | null> {
    if (this.cachedSecret) return this.cachedSecret;
    const [state] = await this.db
      .select({ encrypted: relayPolicyState.resumeSecretEncrypted, dek: relayPolicyState.resumeSecretDek })
      .from(relayPolicyState)
      .where(eq(relayPolicyState.id, 'current'))
      .limit(1);
    if (!state?.encrypted || !state.dek) return null;
    const secret = Buffer.from(
      this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: state.encrypted,
        encryptedDek: state.dek,
        dekIv: '',
      }),
      'hex'
    );
    if (secret.length !== KEY_LEN) throw new Error('Stored relay stream resume secret is malformed');
    this.cachedSecret = secret;
    return secret;
  }

  /** One pass at a time; a request during a pass runs one more pass after it. */
  reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.reconcileOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async reconcileOnce(now = Date.now()): Promise<void> {
    if (!(await this.secret())) return;
    const routes = await this.db
      .select({
        id: relayRoutes.id,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
        resumeState: relayRoutes.resumeState,
        keyRotatedAt: relayRoutes.keyRotatedAt,
        endpointStatus: relayEndpoints.status,
        endpointSubjectKind: relayEndpoints.subjectKind,
        targetNodeId: relayEndpoints.subjectId,
      })
      .from(relayRoutes)
      .innerJoin(relayEndpoints, eq(relayRoutes.targetEndpointId, relayEndpoints.id));
    if (!routes.length) return;
    const nodeIds = [
      ...new Set(
        routes.flatMap((route) => [
          ...(route.endpointSubjectKind === 'daemon' ? [route.targetNodeId] : []),
          ...(route.sourceKind === 'daemon' ? [route.sourceId] : []),
        ])
      ),
    ];
    const capable = new Set(
      nodeIds.length
        ? (
            await this.db
              .select({ id: nodes.id, capabilities: nodes.capabilities })
              .from(nodes)
              .where(inArray(nodes.id, nodeIds))
          )
            .filter(
              ({ capabilities }) =>
                Array.isArray(capabilities?.capabilities) &&
                capabilities.capabilities.includes(RELAY_STREAM_RESUME_CAPABILITY)
            )
            .map(({ id }) => id)
        : []
    );
    const ends = new Map<string, RouteEnds>();
    const states: ResumeRouteState[] = routes.map((route) => {
      const targetNodeId = route.endpointSubjectKind === 'daemon' ? route.targetNodeId : null;
      ends.set(route.id, { id: route.id, sourceKind: route.sourceKind, sourceId: route.sourceId, targetNodeId });
      const sourceCapable =
        route.sourceKind === 'gateway'
          ? GATEWAY_STREAM_RESUME_CAPABLE
          : route.sourceKind === 'daemon' && capable.has(route.sourceId);
      return {
        id: route.id,
        resumeState: route.resumeState,
        keyRotatedAt: route.keyRotatedAt,
        desired:
          route.endpointStatus === 'active' && targetNodeId !== null && capable.has(targetNodeId) && sourceCapable,
      };
    });
    const plan = planResumeTransitions(states, now);
    if (!Object.values(plan).some((ids) => ids.length)) return;
    logger.info('Changing which relay routes carry resumable streams', {
      enable: plan.enable.length,
      rotate: plan.rotate.length,
      cancel: plan.cancel.length,
      disable: plan.disable.length,
      reenable: plan.reenable.length,
    });
    const pick = (ids: string[]) => ids.map((id) => ends.get(id)!);

    // Sources first when routes stop being resumable.
    if (plan.disable.length) {
      await this.setState(plan.disable, ['on', 'rotating', 'disabling'], 'disabling');
      const confirmed = await this.syncSides(pick(plan.disable), 'source');
      if (confirmed.length) {
        await this.setState(confirmed, ['disabling'], 'off');
        await this.syncSides(pick(confirmed), 'target');
      }
    }
    if (plan.reenable.length) {
      await this.setState(plan.reenable, ['disabling'], 'on');
      await this.syncSides(pick(plan.reenable), 'source');
    }
    if (plan.cancel.length) {
      await this.setState(plan.cancel, ['enabling'], 'off');
      await this.syncSides(pick(plan.cancel), 'target');
    }
    // Targets first when routes become resumable or change keys.
    if (plan.enable.length) await this.setState(plan.enable, ['off', 'enabling'], 'enabling');
    if (plan.rotate.length) await this.beginRotation(plan.rotate, new Date(now));
    const targetFirst = [...plan.enable, ...plan.rotate];
    if (targetFirst.length) {
      const confirmed = await this.syncSides(pick(targetFirst), 'target');
      if (confirmed.length) {
        await this.setState(confirmed, ['enabling', 'rotating'], 'on');
        await this.syncSides(pick(confirmed), 'source');
      }
    }
  }

  private async setState(ids: string[], from: RelayRouteResumeState[], to: RelayRouteResumeState): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(relayRoutes)
      .set({
        resumeState: to,
        ...(to === 'off' ? { prevKeyVersion: null } : {}),
        // The key an enabled route starts with is due for rotation a full period later.
        ...(to === 'enabling' ? { keyRotatedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(and(inArray(relayRoutes.id, ids), inArray(relayRoutes.resumeState, from)));
  }

  /** on → rotating with a new key version; a route already rotating keeps its new key. */
  private async beginRotation(ids: string[], now: Date): Promise<void> {
    await this.db
      .update(relayRoutes)
      .set({
        resumeState: 'rotating',
        prevKeyVersion: sql`${relayRoutes.keyVersion}`,
        keyVersion: sql`${relayRoutes.keyVersion} + 1`,
        keyRotatedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(relayRoutes.id, ids), eq(relayRoutes.resumeState, 'on')));
  }

  /**
   * Delivers the bundles of one side of these routes. Returns the routes whose every node on that side applied its
   * bundle. Gateway, as a source, reads its route at every open and needs no delivery.
   */
  private async syncSides(routes: RouteEnds[], side: 'source' | 'target'): Promise<string[]> {
    const nodeOf = (route: RouteEnds) =>
      side === 'target' ? route.targetNodeId : route.sourceKind === 'daemon' ? route.sourceId : null;
    const nodeIds = [...new Set(routes.map(nodeOf).filter((id): id is string => Boolean(id)))];
    const results = await Promise.allSettled(nodeIds.map((nodeId) => this.host.syncNodeGrants(nodeId)));
    const failed = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      failed.add(nodeIds[index]!);
      logger.debug('Resumable stream change waits for a daemon to take its grants', {
        nodeId: nodeIds[index],
        side,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    return routes.filter((route) => !failed.has(nodeOf(route) ?? '')).map(({ id }) => id);
  }
}
