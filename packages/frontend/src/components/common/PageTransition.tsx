import { motion } from "framer-motion";
import { createContext, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type RegisterInitialPageLoad = () => () => void;

export const InitialPageLoadContext = createContext<RegisterInitialPageLoad | null>(null);

export function PageTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [pendingInitialLoads, setPendingInitialLoads] = useState(0);
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

  useEffect(() => {
    acceptsInitialLoads.current = false;
  }, []);

  const waitingForInitialData = pendingInitialLoads > 0;

  return (
    <InitialPageLoadContext.Provider value={registerInitialLoad}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={waitingForInitialData ? { opacity: 0, y: 8 } : { opacity: 1, y: 0 }}
        transition={
          waitingForInitialData ? { duration: 0 } : { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }
        }
        className={cn("h-full", className)}
        style={{ visibility: waitingForInitialData ? "hidden" : "visible" }}
        aria-busy={waitingForInitialData || undefined}
        data-page-transition
      >
        {children}
      </motion.div>
    </InitialPageLoadContext.Provider>
  );
}
