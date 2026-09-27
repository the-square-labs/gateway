/**
 * Availability data-plane lease constants. The protocol timing is fixed in daemon-shared/availabilitylease
 * (timing.go, D5 amended by A1/A3); the values here only mirror what the Gateway needs to wait for.
 */

/** Capability advertised by docker daemons, nginx daemons and relays that run the lease protocol (D10). */
export const AVAILABILITY_LEASE_CAPABILITY = 'availability_lease_v1';

/** Acceptor lease T. Manifests restate it; it is not configurable. */
export const LEASE_TERM_MS = 30_000;

/** An acceptor refuses other proposers for T x 1.1 after its last accept (D5). */
export const ACCEPTOR_HOLD_MS = (LEASE_TERM_MS * 11) / 10;

/** ACCEPTOR_HOLD_MS measured by a clock running 10% fast, rounded up (A1). */
const DRIFTED_ACCEPTOR_HOLD_MS = Math.ceil((ACCEPTOR_HOLD_MS * 10) / 9);

/**
 * How long after both majorities persisted a joint epoch the Gateway waits before it settles the new epoch when it
 * cannot see every active lease renewed under it. A lease not renewed within this window has expired everywhere.
 * Matches the rule the availabilitylease simulator proves.
 */
export const EPOCH_SETTLE_MS = DRIFTED_ACCEPTOR_HOLD_MS + 2_000;

/** Upper bound for a holder's graceful stop after it fenced (D5: min(stop timeout, 10 s) then kill). */
const FENCE_STOP_MARGIN_MS = 10_000;

/**
 * Closing a lease (A5): once a voter majority persisted the lease-closed manifest, no renewal can succeed, so every
 * holder has fenced within T x 1.1 plus its stop margin.
 */
export const CLOSE_SETTLE_MS = DRIFTED_ACCEPTOR_HOLD_MS + FENCE_STOP_MARGIN_MS;

/** At most this many daemons vote besides the relays (D2). */
export const MAX_DAEMON_VOTERS = 12;

/** A member whose last lease report is older than this does not count as reachable. */
export const MEMBER_REPORT_FRESH_MS = 90_000;

/** A daemon voter offline this long is replaced by the next spread choice. */
export const VOTER_OFFLINE_REPLACE_MS = 10 * 60_000;

/** A planned handoff classifies the next holder change as a handoff for this long (D9). */
export const PLANNED_HANDOFF_TTL_MS = 5 * 60_000;

/** Rotation links kept in the published chain; daemon-shared keeps as many trusted keys. */
export const MAX_KEY_ROTATION_LINKS = 8;

/** A daemon that has not confirmed the current distribution revision gets it again after this long. */
export const DAEMON_SYNC_RETRY_MS = 30_000;

/**
 * Daemon roles (availabilitylease.Role) in which the daemon's copy of the workload may run. A key whose claimants
 * include anyone but the reserved holder is not bootstrapped yet.
 */
export const ACTIVE_LEASE_ROLES: ReadonlySet<string> = new Set([
  'bootstrapping',
  'recovering',
  'holding',
  'fencing',
  'abandoned',
  'releasing',
]);

/** Roles in which a daemon holds a committed lease and may serve. */
export const HOLDING_LEASE_ROLES: ReadonlySet<string> = new Set(['holding', 'recovering']);

/** Cluster row id of the singleton voter config. */
export const LEASE_CLUSTER_ID = 'default';
