import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'http://localhost/auth/callback';
  process.env.APP_URL = 'http://gateway.test';
  process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
  process.env.DOCKER_FILE_WRITE_MAX_BODY_BYTES ||= '3000000';
});

describe('request body limits', () => {
  async function expectPayloadTooLarge(path: string, method: string, body: string, contentType = 'application/json') {
    const { app } = createApp();
    const response = await app.request(path, {
      method,
      headers: {
        host: 'gateway.test',
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }

  async function expectNotPayloadTooLarge(path: string, method: string, body: string) {
    const { app } = createApp();
    const response = await app.request(path, {
      method,
      headers: {
        host: 'gateway.test',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(response.status).not.toBe(413);
  }

  it('rejects oversized OAuth token bodies before route parsing', async () => {
    const body = `grant_type=authorization_code&code=${'x'.repeat(40_000)}`;
    await expectPayloadTooLarge('/api/oauth/token', 'POST', body, 'application/x-www-form-urlencoded');
  });

  it('rejects oversized logging ingest bodies before route parsing', async () => {
    await expectPayloadTooLarge('/api/logging/ingest', 'POST', 'x'.repeat(1_100_000));
  });

  it('does not apply the global API body limit to Docker file write bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/write',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker file create bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/create',
      'POST',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file write bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/write',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file create bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/create',
      'POST',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to node file write bodies', async () => {
    await expectNotPayloadTooLarge('/api/nodes/node-1/files/write', 'PUT', 'x'.repeat(1_600_000));
  });

  it('does not apply the global API body limit to node file create bodies', async () => {
    await expectNotPayloadTooLarge('/api/nodes/node-1/files/create', 'POST', 'x'.repeat(1_600_000));
  });

  it('does not apply the global API body limit to node file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/nodes/node-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('uses the larger inference-specific limit instead of the global API limit', async () => {
    await expectNotPayloadTooLarge('/api/inference/codex/v1/responses', 'POST', 'x'.repeat(3_000_000));
  });

  it('still rejects inference requests above the inference-specific limit', async () => {
    await expectPayloadTooLarge('/api/inference/codex/v1/responses', 'POST', 'x'.repeat(34_000_000));
  });
});
