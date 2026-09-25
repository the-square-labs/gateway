import { useContentLoading } from "./reveal-gate";

/**
 * Reports a load to the enclosing page, tab or dialog gate. Use it in a
 * component that renders the gate itself (a page around its `PageTransition`,
 * a dialog around its `DialogContent`): place it inside the gate and pass the
 * component's own loading flag.
 */
export function ContentLoading({ loading }: { loading: boolean }) {
  useContentLoading(loading);
  return null;
}
