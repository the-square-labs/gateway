import { useContext, useLayoutEffect } from "react";
import { InitialPageLoadContext } from "@/components/common/PageTransition";

function Skeleton(_props: React.HTMLAttributes<HTMLDivElement>) {
  const registerInitialPageLoad = useContext(InitialPageLoadContext);

  useLayoutEffect(() => {
    if (!registerInitialPageLoad) return;
    return registerInitialPageLoad();
  }, [registerInitialPageLoad]);

  return null;
}

export { Skeleton };
