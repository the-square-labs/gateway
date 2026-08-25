import { motion, useReducedMotion } from "framer-motion";
import {
  createContext,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type RegisterInitialPageLoad = () => () => void;

export const InitialPageLoadContext = createContext<RegisterInitialPageLoad | null>(null);
export const InitialPageReadyContext = createContext(true);

export function PageTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [pendingInitialLoads, setPendingInitialLoads] = useState(0);
  const [initialLoadCollectionComplete, setInitialLoadCollectionComplete] = useState(false);
  const [entranceComplete, setEntranceComplete] = useState(false);
  const acceptsInitialLoads = useRef(true);

  const registerInitialLoad = useCallback<RegisterInitialPageLoad>(() => {
    if (!acceptsInitialLoads.current) return () => undefined;
    setPendingInitialLoads((current) => current + 1);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      setPendingInitialLoads((current) => Math.max(0, current - 1));
    };
  }, []);

  useLayoutEffect(() => {
    acceptsInitialLoads.current = false;
    setInitialLoadCollectionComplete(true);
    return () => {
      // React StrictMode replays layout effects in development. Reopen the
      // registration window so child Skeleton effects can register again on
      // the replay instead of leaving the page visible with partial content.
      acceptsInitialLoads.current = true;
    };
  }, []);

  const waitingForInitialData = !initialLoadCollectionComplete || pendingInitialLoads > 0;

  return (
    <InitialPageLoadContext.Provider value={registerInitialLoad}>
      <InitialPageReadyContext.Provider value={!waitingForInitialData && entranceComplete}>
        <motion.div
          initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }}
          animate={
            waitingForInitialData
              ? { opacity: 0, y: prefersReducedMotion ? 0 : 8 }
              : { opacity: 1, y: 0 }
          }
          transition={
            waitingForInitialData || prefersReducedMotion
              ? { duration: 0 }
              : { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }
          }
          className={cn("h-full", className)}
          style={{ visibility: waitingForInitialData ? "hidden" : "visible" }}
          aria-busy={waitingForInitialData || undefined}
          data-page-transition
          onAnimationComplete={() => {
            if (!waitingForInitialData) setEntranceComplete(true);
          }}
        >
          {children}
        </motion.div>
      </InitialPageReadyContext.Provider>
    </InitialPageLoadContext.Provider>
  );
}
