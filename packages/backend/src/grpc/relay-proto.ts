import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export function resolveRelayV1ProtoPath(cwd = process.cwd()): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(cwd, 'proto/relay/v1/relay.proto'),
    resolve(cwd, '../proto/relay/v1/relay.proto'),
    resolve(cwd, '../../proto/relay/v1/relay.proto'),
    resolve(moduleDir, '../../../../proto/relay/v1/relay.proto'),
    resolve(moduleDir, '../../../../../proto/relay/v1/relay.proto'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Could not locate relay.proto. Tried: ${candidates.join(', ')}`);
  return found;
}

export function loadRelayV1Proto(): any {
  const definition = protoLoader.loadSync(resolveRelayV1ProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });
  return (grpc.loadPackageDefinition(definition) as any).relay.v1;
}
