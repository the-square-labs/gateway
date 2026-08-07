import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export function resolveRelayProtoPath(cwd = process.cwd()): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(cwd, 'proto/gateway/v1/nginx-daemon.proto'),
    resolve(cwd, '../proto/gateway/v1/nginx-daemon.proto'),
    resolve(cwd, '../../proto/gateway/v1/nginx-daemon.proto'),
    resolve(moduleDir, '../../../../proto/gateway/v1/nginx-daemon.proto'),
    resolve(moduleDir, '../../../../../proto/gateway/v1/nginx-daemon.proto'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Could not locate nginx-daemon.proto. Tried: ${candidates.join(', ')}`);
  return found;
}

export function loadRelayProto(): any {
  const definition = protoLoader.loadSync(resolveRelayProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });
  return (grpc.loadPackageDefinition(definition) as any).gateway.v1;
}
