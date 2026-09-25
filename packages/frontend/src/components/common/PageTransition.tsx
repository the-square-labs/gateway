import { type ReactNode, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  ContentLoader,
  InitialPageLoadContext,
  InitialPageReadyContext,
  staggerReveal,
  useRevealGate,
} from "./reveal-gate";

export { InitialPageLoadContext, InitialPageReadyContext } from "./reveal-gate";

/**
 * Page and tab panel gate: hidden while its content loads, then revealed block
 * by block. A loader appears only when loading takes longer than half a second.
 */
export function PageTransition({
  children,
  className,
  offsetY = 6,
}: {
  children: ReactNode;
  className?: string;
  offsetY?: number;
}) {
  const { phase, revealed, register, animateReveal } = useRevealGate();
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!revealed || !animateReveal || !rootRef.current) return;
    staggerReveal(rootRef.current, offsetY);
  }, [revealed, animateReveal, offsetY]);

  return (
    <InitialPageLoadContext.Provider value={register}>
      <InitialPageReadyContext.Provider value={revealed}>
        <div
          ref={rootRef}
          className={cn("relative h-full", className)}
          style={{ visibility: revealed ? "visible" : "hidden" }}
          aria-busy={revealed ? undefined : true}
          data-page-transition=""
          data-reveal-phase={phase}
        >
          {children}
          {phase === "loading" ? <ContentLoader /> : null}
        </div>
      </InitialPageReadyContext.Provider>
    </InitialPageLoadContext.Provider>
  );
}
