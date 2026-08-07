import type { ServerDuplexStream } from '@grpc/grpc-js';
import type { RelayAuthorizationRepository } from './authorization-repository.js';
import { extractRelayPeerCertificateIdentity } from './peer-identity.js';
import type { DatabaseTunnelMessage } from './protocol.js';
import {
  parseDatabaseTunnelCapability,
  type RelayTunnelConnection,
  type StandaloneDatabaseTunnelRelay,
} from './tunnel-relay.js';

type DatabaseTunnelStream = ServerDuplexStream<DatabaseTunnelMessage, DatabaseTunnelMessage>;

export function createStandaloneDatabaseTunnelHandlers(
  relay: StandaloneDatabaseTunnelRelay,
  authorization: RelayAuthorizationRepository,
  onProtocolFailure?: (message: string) => void
) {
  return {
    Tunnel(stream: DatabaseTunnelStream) {
      let connection: RelayTunnelConnection | null = null;
      let closed = false;
      let processing = Promise.resolve();
      stream.pause();

      const close = () => {
        if (closed) return;
        closed = true;
        if (connection) relay.disconnect(connection);
      };
      stream.on('end', () => {
        close();
        stream.end();
      });
      stream.on('error', close);

      void (async () => {
        const certificate = extractRelayPeerCertificateIdentity(stream);
        if (!certificate) throw new Error('missing authorized daemon certificate');
        const authenticated = await authorization.authenticateNode(certificate.commonName, certificate.serialNumber);
        if (!authenticated) throw new Error('daemon certificate does not match an enrolled tunnel node');

        stream.on('data', (message: DatabaseTunnelMessage) => {
          if (closed) return;
          processing = processing
            .then(async () => {
              if (!connection) {
                const hello = message.hello;
                const lane = hello ? parseDatabaseTunnelCapability(hello.capability) : null;
                if (
                  !hello ||
                  hello.nodeId !== authenticated.nodeId ||
                  !lane ||
                  !Number.isInteger(hello.maxChunkBytes) ||
                  hello.maxChunkBytes <= 0
                ) {
                  throw new Error('invalid database tunnel hello');
                }
                if (
                  (lane.lane === 'data' &&
                    authenticated.nodeType !== 'docker' &&
                    authenticated.nodeType !== 'databases') ||
                  ((lane.lane === 'interactive' || lane.lane === 'monitoring') &&
                    authenticated.nodeType !== 'databases')
                ) {
                  throw new Error('database tunnel lane is not supported by this node type');
                }
                connection = {
                  nodeId: authenticated.nodeId,
                  nodeType: authenticated.nodeType,
                  stream,
                  maxChunkBytes: Math.min(1024 * 1024, hello.maxChunkBytes),
                  ...lane,
                };
                relay.register(connection);
                stream.write({ ready: { maxChunkBytes: connection.maxChunkBytes } });
                return;
              }
              if (message.open) await relay.handleOpen(connection, message.open);
              else if (message.data) relay.handleData(connection, message.data);
              else if (message.close) relay.handleClose(connection, message.close);
              else if (message.error) relay.handleError(connection, message.error);
              else throw new Error('unexpected database tunnel frame');
            })
            .catch((error) => {
              onProtocolFailure?.(error instanceof Error ? error.message : 'database tunnel rejected');
              close();
              stream.end();
            });
        });
        stream.resume();
      })().catch((error) => {
        onProtocolFailure?.(error instanceof Error ? error.message : 'database tunnel authentication rejected');
        close();
        stream.end();
      });
    },
  };
}
