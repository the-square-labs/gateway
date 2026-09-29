import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '@/types.js';
import { errorHandler } from './error-handler.js';

function appThrowing(error: unknown) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get('/boom', () => {
    throw error;
  });
  return app;
}

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function drizzleWrapped(cause: unknown) {
  return Object.assign(new Error('Failed query: select ... where "id" = $1 params: profile'), { cause });
}

describe('errorHandler PostgreSQL uuid errors', () => {
  it('maps an invalid uuid text representation to 404, also when Drizzle wraps it', async () => {
    const cause = pgError('22P02', 'invalid input syntax for type uuid: "profile"');
    for (const error of [cause, drizzleWrapped(cause)]) {
      const res = await appThrowing(error).request('/boom');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Resource not found' });
    }
  });

  it('leaves other 22P02 cases and other errors as 500', async () => {
    const other22P02 = drizzleWrapped(pgError('22P02', 'invalid input syntax for type integer: "x"'));
    const otherCode = drizzleWrapped(pgError('23505', 'invalid input syntax for type uuid'));
    // The wrapper text mentions uuid but the driver error does not.
    const wrapperOnly = Object.assign(new Error('Failed query: uuid'), {
      cause: pgError('22P02', 'invalid input syntax for type json'),
    });
    for (const error of [other22P02, otherCode, wrapperOnly, new Error('boom')]) {
      const res = await appThrowing(error).request('/boom');
      expect(res.status).toBe(500);
    }
  });
});
