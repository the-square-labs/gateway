import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const BOTTOM_THRESHOLD_PX = 24;

export function useAIMessageScroll(contentSignature: string, conversationKey: string) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const scrollToBottom = useCallback((force = false) => {
    const node = viewportRef.current;
    if (!node || (!force && !pinnedRef.current)) return;
    pinnedRef.current = true;
    programmaticRef.current = true;
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
    requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
  }, []);

  const pinToBottom = useCallback(() => scrollToBottom(true), [scrollToBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing chats intentionally resets the scroll pin.
  useLayoutEffect(() => {
    pinnedRef.current = true;
    const frame = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [conversationKey, scrollToBottom]);

  const onScroll = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const nextTop = node.scrollTop;
    const movedUp = nextTop < lastScrollTopRef.current - 1;
    const atBottom = node.scrollHeight - nextTop - node.clientHeight <= BOTTOM_THRESHOLD_PX;
    if (!programmaticRef.current && movedUp) {
      pinnedRef.current = false;
    } else if (!programmaticRef.current && atBottom) {
      pinnedRef.current = true;
    }
    lastScrollTopRef.current = nextTop;
  }, []);

  useLayoutEffect(() => {
    if (!contentSignature || !pinnedRef.current) return;
    const frame = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [contentSignature, scrollToBottom]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scrollToBottom());
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return { viewportRef, onScroll, pinToBottom };
}
