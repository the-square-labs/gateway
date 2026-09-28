import { AppError } from '@/middleware/error-handler.js';

/** The registry's error for a command to a node without a live control session. */
const NODE_NOT_CONNECTED_RE = /\bNode \S+ is not connected\b/;

/**
 * Whether work failed only because its node has no control session right now, directly or wrapped by a caller
 * (for example NGINX_TLS_BUNDLE_FAILED "Failed to safely activate the TLS proxy configuration: Node … is not
 * connected"). Such work is not lost: a node's reconnect sync applies the current state. Callers log it as expected
 * (info/debug), never as an error.
 */
export function isNodeNotConnectedError(error: unknown): boolean {
  if (error instanceof AppError && error.code === 'NODE_NOT_CONNECTED') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return NODE_NOT_CONNECTED_RE.test(message);
}
