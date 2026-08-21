import { useEffect, useRef } from "react";
import { eventStream } from "@/services/event-stream";

/**
 * Subscribe to a realtime channel for the lifetime of the component.
 * The handler is invoked with the event payload.
 *
 * Subscribes once per channel; the latest handler closure (which may close
 * over fresh React state) is always called via a ref. Pass `null` as the
 * channel to skip subscribing.
 */
export function useRealtime(
  channel: string | null,
  handler: (payload: unknown) => void,
  options: { onReconnect?: () => void } = {}
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const reconnectRef = useRef(options.onReconnect);
  reconnectRef.current = options.onReconnect;
  const hasReconnectHandler = options.onReconnect !== undefined;

  useEffect(() => {
    if (!channel) return;
    const unsubscribe = eventStream.subscribe(channel, (payload) => {
      handlerRef.current(payload);
    });
    const unsubscribeReconnect = hasReconnectHandler
      ? eventStream.onReconnect(() => reconnectRef.current?.())
      : undefined;
    return () => {
      unsubscribe();
      unsubscribeReconnect?.();
    };
  }, [channel, hasReconnectHandler]);
}
