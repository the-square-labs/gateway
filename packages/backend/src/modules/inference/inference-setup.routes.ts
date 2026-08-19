import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv } from '@/types.js';
import { createHash } from 'node:crypto';
import { inferenceAdapterDiscovery } from './inference-setup.contract.js';
import { InferenceModelService } from './models/inference-model.service.js';
import { inferenceSetupAuthMiddleware } from './inference-setup-auth.middleware.js';
import type { InferenceSetupEvent } from './inference-setup-events.service.js';
import { InferenceSetupEventsService } from './inference-setup-events.service.js';
import { InferenceTokenService } from './inference-token.service.js';

const ManagedTokenInputSchema = z.object({
  harness: z.enum(['codex', 'claude-code']),
  deviceName: z.string().trim().min(1).max(255),
  installationId: z.string().uuid(),
  replaceExisting: z.boolean().optional(),
});

const TokenIdSchema = z.string().uuid();
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 10 * 60_000;

function encodeSse(input: { id?: string; event: string; data?: unknown; comment?: string }): Uint8Array {
  const lines: string[] = [];
  if (input.comment) lines.push(`: ${input.comment}`);
  if (input.id) lines.push(`id: ${input.id}`);
  lines.push(`event: ${input.event}`);
  if (input.data !== undefined) lines.push(`data: ${JSON.stringify(input.data)}`);
  lines.push('', '');
  return new TextEncoder().encode(lines.join('\n'));
}

/** Content hash of the user's public model catalog; clients poll it for invalidation. */
async function catalogVersionForUser(user: NonNullable<AppEnv['Variables']['user']>): Promise<string> {
  const body = await container.resolve(InferenceModelService).listForUser(user);
  return createHash('sha256').update(JSON.stringify(body)).digest('base64url');
}

export const inferenceSetupRoutes = new OpenAPIHono<AppEnv>();

inferenceSetupRoutes.use('*', inferenceSetupAuthMiddleware);

inferenceSetupRoutes.get('/me', async (c) => {
  const user = c.get('user')!;
  const discovery = inferenceAdapterDiscovery(container.resolve(OAuthService));
  const version = await catalogVersionForUser(user);
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.groupName },
    inference: { enabled: true, allowed: true },
    adapters: discovery.adapters,
    catalogVersion: version,
  });
});

inferenceSetupRoutes.get('/tokens', async (c) => {
  const tokens = await container.resolve(InferenceTokenService).listManagedTokens(c.get('user')!.id);
  return c.json({ data: tokens });
});

inferenceSetupRoutes.post('/tokens', async (c) => {
  const input = ManagedTokenInputSchema.parse(await c.req.json());
  const token = await container.resolve(InferenceTokenService).createManagedToken(c.get('user')!.id, input);
  return c.json(token, 201);
});

inferenceSetupRoutes.delete('/tokens/:id', async (c) => {
  const id = TokenIdSchema.parse(c.req.param('id'));
  await container.resolve(InferenceTokenService).revokeManagedToken(c.get('user')!.id, id);
  return c.body(null, 204);
});

inferenceSetupRoutes.get('/events', async (c) => {
  const user = c.get('user')!;
  const events = container.resolve(InferenceSetupEventsService);
  const version = await catalogVersionForUser(user);
  const replay = events.since(c.req.header('Last-Event-ID'));
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeSse({ event: 'ready', data: { catalogVersion: version } }));
      for (const event of replay) {
        controller.enqueue(encodeSse({ id: event.id, event: 'invalidate', data: event }));
      }
      unsubscribe = events.subscribe((event: InferenceSetupEvent) => {
        controller.enqueue(encodeSse({ id: event.id, event: 'invalidate', data: event }));
      });
      heartbeat = setInterval(
        () => controller.enqueue(encodeSse({ event: 'heartbeat', comment: 'keepalive' })),
        HEARTBEAT_MS
      );
      expiry = setTimeout(() => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      }, MAX_STREAM_MS);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
});
