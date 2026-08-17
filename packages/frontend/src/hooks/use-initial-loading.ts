import { useRef } from "react";

/**
 * Keeps initial loading separate from later refreshes. Once a view has settled,
 * background refreshes must preserve its current content or empty state.
 */
export function useInitialLoading(loading: boolean): boolean {
  const hasSettledRef = useRef(!loading);

  if (!loading) {
    hasSettledRef.current = true;
  }

  return loading && !hasSettledRef.current;
}
