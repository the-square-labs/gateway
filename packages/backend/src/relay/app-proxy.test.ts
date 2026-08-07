import { PassThrough } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import { AppGrpcProxy, buildForwardedMetadata, RELAY_FORWARDED_METADATA } from './app-proxy.js';

describe('relay forwarded metadata', () => {
  it('strips every caller-supplied relay header before attaching authenticated identity', () => {
    const source = new grpc.Metadata();
    source.set('authorization', 'Bearer enrollment-token');
    source.set('x-wiolett-relay-node-id', 'spoofed');
    source.set('x-wiolett-relay-cert-serial', 'spoofed');
    source.set('x-wiolett-relay-node-type', 'spoofed');
    source.set('x-wiolett-relay-future-field', 'spoofed');

    const forwarded = buildForwardedMetadata(source, {
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeType: 'docker',
      serialNumber: 'aa01',
    });

    expect(forwarded.get('authorization')).toEqual(['Bearer enrollment-token']);
    expect(forwarded.get(RELAY_FORWARDED_METADATA.nodeId)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(forwarded.get(RELAY_FORWARDED_METADATA.certificateSerial)).toEqual(['aa01']);
    expect(forwarded.get(RELAY_FORWARDED_METADATA.nodeType)).toEqual(['docker']);
    expect(forwarded.get('x-wiolett-relay-future-field')).toEqual([]);
  });

  it('never forwards spoofed relay identity on unauthenticated enrollment', () => {
    const source = new grpc.Metadata();
    source.set('x-wiolett-relay-node-id', 'spoofed');
    expect(buildForwardedMetadata(source).get(RELAY_FORWARDED_METADATA.nodeId)).toEqual([]);
  });

  it('ends active daemon proxy streams with UNAVAILABLE when the app client is replaced', async () => {
    const upstream = new PassThrough({ objectMode: true }) as PassThrough & { cancel: ReturnType<typeof vi.fn> };
    upstream.cancel = vi.fn();
    const commandStream = vi.fn(() => upstream);
    const clientClose = vi.fn();
    const proxy = Object.create(AppGrpcProxy.prototype) as {
      clients: Record<string, unknown>;
      activeBidiClosers: Set<(error?: Error) => void>;
      authenticate: ReturnType<typeof vi.fn>;
      controlHandlers: AppGrpcProxy['controlHandlers'];
      close: AppGrpcProxy['close'];
    };
    proxy.clients = { control: { CommandStream: commandStream, close: clientClose } };
    proxy.activeBidiClosers = new Set();
    proxy.authenticate = vi.fn().mockResolvedValue({
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeType: 'docker',
      serialNumber: 'aa01',
    });

    const downstream = new PassThrough({ objectMode: true }) as PassThrough & {
      metadata: grpc.Metadata;
      getAuthContext: () => Record<string, unknown>;
    };
    downstream.metadata = new grpc.Metadata();
    downstream.getAuthContext = () => ({});
    const errors: Array<Error & { code?: number }> = [];
    downstream.on('error', (error: Error & { code?: number }) => errors.push(error));

    proxy.controlHandlers().CommandStream(downstream as never);
    await vi.waitFor(() => expect(commandStream).toHaveBeenCalledOnce());

    proxy.close();

    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(clientClose).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: grpc.status.UNAVAILABLE });
  });
});
