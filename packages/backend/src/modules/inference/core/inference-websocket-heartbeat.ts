import type WebSocket from 'ws';

export const INFERENCE_WEBSOCKET_PING_INTERVAL_MS = 20_000;

/** Keep the transport active; deliberately do not impose a new pong deadline. */
export function startInferenceWebSocketHeartbeat(raw: unknown, onFailure: () => void): () => void {
  const socket = raw as WebSocket | undefined;
  if (!socket || typeof socket.ping !== 'function') return () => undefined;
  let stopped = false;
  let pending = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const failed = () => {
    if (stopped) return;
    stop();
    onFailure();
  };
  const timer = setInterval(() => {
    if (socket.readyState !== 1) return stop();
    // Never stack control frames behind an unwritable socket or an unfinished send.
    if (pending || socket.bufferedAmount > 0) return;
    pending = true;
    try {
      socket.ping(undefined, false, (error?: Error) => {
        pending = false;
        if (error) failed();
      });
    } catch {
      pending = false;
      failed();
    }
  }, INFERENCE_WEBSOCKET_PING_INTERVAL_MS);
  timer.unref?.();
  return stop;
}
