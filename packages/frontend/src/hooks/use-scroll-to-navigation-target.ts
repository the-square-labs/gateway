import { useContext, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { InitialPageReadyContext } from "@/components/common/PageTransition";

export interface ScrollNavigationState {
  scrollTarget?: string;
}

export function useScrollToNavigationTarget(targetId: string, ready = true): void {
  const initialPageReady = useContext(InitialPageReadyContext);
  const location = useLocation();
  const handledLocationKey = useRef<string | null>(null);
  const scrollTarget = (location.state as ScrollNavigationState | null)?.scrollTarget;

  useEffect(() => {
    if (
      !ready ||
      !initialPageReady ||
      scrollTarget !== targetId ||
      handledLocationKey.current === location.key
    )
      return;

    const frameId = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;

      handledLocationKey.current = location.key;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [initialPageReady, location.key, ready, scrollTarget, targetId]);
}
