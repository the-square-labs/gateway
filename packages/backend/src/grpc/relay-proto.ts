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
  const definition = loadRelayV1Definition();
  return (grpc.loadPackageDefinition(definition) as any).relay.v1;
}

const relayV1Definitions = new Map<string, protoLoader.PackageDefinition>();

/** Parsed once per proto path: lease blocks are encoded for every relay snapshot and daemon sync. */
function loadRelayV1Definition(): protoLoader.PackageDefinition {
  const path = resolveRelayV1ProtoPath();
  const cached = relayV1Definitions.get(path);
  if (cached) return cached;
  const definition = parseRelayV1Definition(path);
  relayV1Definitions.set(path, definition);
  return definition;
}

function parseRelayV1Definition(path: string): protoLoader.PackageDefinition {
  return protoLoader.loadSync(path, {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });
}

export function encodeRelayV1Message(typeName: string, value: unknown): Buffer {
  const definition = loadRelayV1Definition();
  const message = definition[`relay.v1.${typeName}`] as any;
  if (!message || !('serialize' in message)) throw new Error(`Relay protobuf message ${typeName} is unavailable`);
  return Buffer.from(message.serialize(value));
}

export function decodeRelayV1Message(typeName: string, value: Buffer): unknown {
  const definition = loadRelayV1Definition();
  const message = definition[`relay.v1.${typeName}`] as any;
  if (!message || !('deserialize' in message)) throw new Error(`Relay protobuf message ${typeName} is unavailable`);
  return message.deserialize(value);
}
