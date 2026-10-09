/**
 * An error of a command to a node that got no answer: the node's control stream dropped while the command was in flight
 * (`Node disconnected`, raised for every pending command when the stream ends), its answer did not come in time, or
 * the node is not connected. Such errors are plain Errors from the node registry; their messages are matched on by
 * internal callers, so they are mapped only where an API answer is made (errorHandler, nodeLossHttpError).
 */
export function isNodeConnectionError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'Error') return false;
  return (
    error.message === 'Node disconnected' ||
    /^Command \S+ timed out after \d+ms$/.test(error.message) ||
    /^Node \S+ is not connected$/.test(error.message)
  );
}
