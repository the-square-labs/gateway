import { describe, expect, it } from 'vitest';
import { isGatedProbeRefusal, isRetryableDispatchError, isTransientRelayPoolError } from './relay-pool-errors.js';

// Messages as the rc.20 main stand recorded them (B-17), from daemons, relays, the node registry and grpc-js.
const GATE_CLOSED =
  'rpc error: code = FailedPrecondition desc = availability lease gate closed: 2357df2a-f55b-4fb2-9484-444aa78b9c5d holds no committed slot';
const DORMANT = 'rpc error: code = Unavailable desc = target endpoint is dormant';
const BUSY = 'daemon is busy handling long-running commands; retry shortly';
const NOT_CONNECTED = 'Node 3476ad89-dd2c-4380-8fd7-9c4e679c0b97 is not connected';
const LOCAL_RELAY_DOWN =
  '14 UNAVAILABLE: No connection established. Last error: Error: connect ECONNREFUSED 172.18.0.5:9443. Resolution note: ';
const INTERRUPTED = 'Rebalance preparation was interrupted; a fresh verified attempt is required';

describe('relay pool error classification', () => {
  it.each([
    GATE_CLOSED,
    DORMANT,
    'rpc error: code = FailedPrecondition desc = availability lease gate closed: no own accept',
    'rpc error: code = FailedPrecondition desc = availability lease gate closed: expired',
    'rpc error: code = FailedPrecondition desc = availability lease gate closed: no lease manifest for the policy',
  ])('reads a lease-gated refusal as a verified source probe: %s', (message) => {
    expect(isGatedProbeRefusal(new Error(message))).toBe(true);
    expect(isTransientRelayPoolError(message)).toBe(false);
  });

  it.each([
    // A relay without lease coordination can never admit lease traffic.
    'rpc error: code = FailedPrecondition desc = availability lease gate closed: lease coordination is not running',
    'rpc error: code = PermissionDenied desc = connect grant route was revoked',
    'rpc error: code = Unavailable desc = target endpoint is not registered',
    'relay endpoint registration is not ready',
    'relay candidate lane is unavailable',
    'Pool candidate grant is unavailable',
    'Relay Pool capability is unavailable; update or repair this relay',
    'Selected remote relay is not enrolled',
  ])('keeps a genuine failure visible: %s', (message) => {
    expect(isGatedProbeRefusal(message)).toBe(false);
    expect(isTransientRelayPoolError(message)).toBe(false);
  });

  it.each([
    BUSY,
    'command expired while waiting for a free handler slot',
    NOT_CONNECTED,
    'Node disconnected',
    'Failed to send command: write after end',
  ])('retries a command the daemon never ran within the preparation: %s', (message) => {
    expect(isTransientRelayPoolError(new Error(message))).toBe(true);
    expect(isRetryableDispatchError(new Error(message))).toBe(true);
  });

  it.each([
    LOCAL_RELAY_DOWN,
    'Channel has been shut down',
    'Relay policy revision 1310 has not been durably acknowledged',
    'Command 5f0c9c1e-0ad5-4b1c-9a52-0c8d2b1c1f00 timed out after 15000ms',
    INTERRUPTED,
  ])('defers a transient condition to a later attempt: %s', (message) => {
    expect(isTransientRelayPoolError(message)).toBe(true);
    expect(isRetryableDispatchError(message)).toBe(false);
  });

  it('does not mistake a daemon-side connection refusal for the local relay restarting', () => {
    const message =
      'rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial tcp 10.0.0.7:9443: connect: connection refused"';
    expect(isTransientRelayPoolError(message)).toBe(false);
  });
});
