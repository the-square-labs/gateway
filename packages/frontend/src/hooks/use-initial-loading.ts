import { useRef } from "react";

/**
 * Keeps initial loading separate from later refreshes. Once a view has settled,
 * background refreshes must preserve its current content or empty state.
 *
 * Pass `true` from the first render while there is no data yet (for example
 * `loading || data === undefined`): a view whose first render passes `false`
 * counts as settled, so a fetch that starts in an effect is treated as a refresh.
 */
export function useInitialLoading(loading: boolean): boolean {
  const hasSettledRef = useRef(!loading);

  if (!loading) {
    hasSettledRef.current = true;
  }

  return loading && !hasSettledRef.current;
}
