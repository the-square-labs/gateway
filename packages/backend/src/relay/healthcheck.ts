import * as grpc from '@grpc/grpc-js';
import { loadRelayConfig } from './config.js';
import { RelayIdentityStore } from './identity.js';
import { loadRelayProto } from './proto.js';

async function main(): Promise<void> {
  const config = loadRelayConfig();
  const identity = new RelayIdentityStore(config.identityDir).load();
  const gatewayV1 = loadRelayProto();
  const credentials = grpc.credentials.createSsl(
    identity.systemCa,
    identity.relayClientPrivateKey,
    identity.relayClientCertificate
  );
  const client = new gatewayV1.GatewayRelayControl(`127.0.0.1:${config.port}`, credentials);
  const response = await new Promise<{ liveness?: boolean; readiness?: boolean }>((resolve, reject) => {
    client.GetHealth({}, { deadline: Date.now() + 2_000 }, (error: Error | null, value: unknown) =>
      error ? reject(error) : resolve(value as { liveness?: boolean; readiness?: boolean })
    );
  });
  client.close();
  if (!response.liveness || !response.readiness) process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
