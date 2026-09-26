import { Loader2 } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Content reveal pipeline shared by pages, tab panels and dialogs.
 *
 * A gate keeps its content hidden while anything inside it reports loading.
 * If the content is ready within `loaderDelayMs` it appears at once; otherwise
 * a loader shows and stays at least `loaderMinMs`, so a load that finishes just
 * after the loader appeared does not flicker. Loads reported after the reveal
 * no longer hide the gate: nested gates (tab panels, dialogs) handle their own.
 */

export type RevealPhase = "pending" | "loading" | "revealed";

type RegisterLoad = () => () => void;

export const InitialPageLoadContext = createContext<RegisterLoad | null>(null);
export const InitialPageReadyContext = createContext(true);
/** When the enclosing gate revealed; null outside any gate or before it revealed. */
export const RevealedAtContext = createContext<number | null>(null);

/** Pages wait this long before showing a loader. */
export const PAGE_LOADER_DELAY_MS = 500;
/** A page loader, once visible, stays at least this long. */
export const PAGE_LOADER_MIN_MS = 500;
/** After the last load ends, wait this long for a follow-up load to start. */
const SETTLE_MS = 50;
/** A route guard's loader is continued by the page mounted right after it. */
const HANDOFF_WINDOW_MS = 150;
/**
 * A nested gate (a tab panel) that reveals this soon after its parent does not play its own
 * entrance, so the page never animates twice in a row.
 */
const NESTED_ANIMATION_QUIET_MS = 700;
/** A page remounted at the same address this soon after revealing appears without animating again. */
const REMOUNT_ANIMATION_QUIET_MS = 1000;

let lastPageReveal: { path: string; at: number } | null = null;

/** Forgets the page loader and reveal history kept across gates. For tests only. */
export function resetRevealGateHistory() {
  lastPageReveal = null;
  visibleLoader = null;
}

function currentPath() {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

const noop = () => undefined;

// The page loader on screen. A route guard's gate and the resolved page's gate
// swap in one commit, so the new page reads this during render, before the old
// gate's cleanup has run.
let visibleLoader: { owner: object; shownAt: number; releasedAt: number | null } | null = null;

// Read without consuming: StrictMode runs state initializers twice.
function recentLoaderHandoff() {
  if (!visibleLoader) return null;
  if (
    visibleLoader.releasedAt !== null &&
    Date.now() - visibleLoader.releasedAt > HANDOFF_WINDOW_MS
  )
    return null;
  return visibleLoader.shownAt;
}

/**
 * Reports a load to the nearest gate while `isLoading` is true. Use it for
 * every request the first render of a page, tab or dialog depends on.
 */
export function useContentLoading(isLoading: boolean) {
  const register = useContext(InitialPageLoadContext);
  useLayoutEffect(() => {
    if (!isLoading || !register) return;
    return register();
  }, [isLoading, register]);
}

interface RevealGateOptions {
  loaderDelayMs?: number;
  loaderMinMs?: number;
  /** Ignore the enclosing gate: a dialog neither holds nor waits for the page behind it. */
  isolated?: boolean;
}

export function useRevealGate({
  loaderDelayMs = PAGE_LOADER_DELAY_MS,
  loaderMinMs = PAGE_LOADER_MIN_MS,
  isolated = false,
}: RevealGateOptions = {}) {
  const inheritedRegister = useContext(InitialPageLoadContext);
  const inheritedReady = useContext(InitialPageReadyContext);
  const inheritedRevealedAt = useContext(RevealedAtContext);
  const parentRegister = isolated ? null : inheritedRegister;
  const parentReady = isolated ? true : inheritedReady;
  const topLevel = parentRegister === null;

  const [handoffShownAt] = useState(() => (topLevel && !isolated ? recentLoaderHandoff() : null));
  const [pending, setPending] = useState(0);
  const [phase, setPhase] = useState<RevealPhase>(handoffShownAt === null ? "pending" : "loading");
  const loaderShownAt = useRef<number | null>(handoffShownAt);
  const revealedRef = useRef(false);
  const owner = useRef({}).current;
  const tracksPageLoader = topLevel && !isolated;
  // Only a gate whose parent is already on screen animates its own reveal;
  // during the first page load the outermost gate animates for everyone.
  const [animateReveal, setAnimateReveal] = useState(true);

  // Loads a gate has seen. Content with none reveals in the same commit, as
  // before; once a load was reported, the gate waits a moment after the last
  // one ends, so a follow-up request (list, then its details) is caught too.
  const hadLoads = useRef(false);
  const register = useCallback<RegisterLoad>(() => {
    if (revealedRef.current) return noop;
    hadLoads.current = true;
    setPending((count) => count + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      setPending((count) => Math.max(0, count - 1));
    };
  }, []);

  const revealed = phase === "revealed";
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const reveal = useCallback(() => {
    const now = Date.now();
    let animate = parentReady;
    if (
      animate &&
      !isolated &&
      inheritedRevealedAt !== null &&
      now - inheritedRevealedAt < NESTED_ANIMATION_QUIET_MS
    ) {
      animate = false;
    }
    if (tracksPageLoader) {
      const path = currentPath();
      if (
        lastPageReveal &&
        lastPageReveal.path === path &&
        now - lastPageReveal.at < REMOUNT_ANIMATION_QUIET_MS
      ) {
        animate = false;
      }
      lastPageReveal = { path, at: now };
    }
    revealedRef.current = true;
    setAnimateReveal(animate);
    setRevealedAt(now);
    setPhase("revealed");
  }, [parentReady, isolated, inheritedRevealedAt, tracksPageLoader]);

  useLayoutEffect(() => {
    if (!tracksPageLoader) return;
    if (phase === "loading" && loaderShownAt.current !== null) {
      visibleLoader = { owner, shownAt: loaderShownAt.current, releasedAt: null };
    } else if (phase === "revealed" && visibleLoader?.owner === owner) {
      visibleLoader = null;
    }
  }, [phase, owner, tracksPageLoader]);

  // A nested gate that is waiting for data holds its parent, so a page never
  // shows a half-loaded tab during its first reveal.
  const holdsParent = !revealed && (pending > 0 || hadLoads.current);
  useLayoutEffect(() => {
    if (!holdsParent) return;
    return parentRegister?.();
  }, [parentRegister, holdsParent]);

  // Children report their loads in their own layout effects, before this
  // gate's; the commit after the first one knows whether anything is loading.
  const [collected, setCollected] = useState(false);
  useLayoutEffect(() => {
    setCollected(true);
  }, []);
  useLayoutEffect(() => {
    if (!collected || phase !== "pending" || pending > 0 || hadLoads.current) return;
    reveal();
  }, [collected, phase, pending, reveal]);

  useEffect(() => {
    if (phase !== "pending" || !parentReady) return;
    const timer = setTimeout(() => {
      loaderShownAt.current = Date.now();
      setPhase("loading");
    }, loaderDelayMs);
    return () => clearTimeout(timer);
  }, [phase, parentReady, loaderDelayMs]);

  useEffect(() => {
    if (revealed || pending > 0 || !(hadLoads.current || phase === "loading")) return;
    const shownAt = loaderShownAt.current;
    const loaderRemaining =
      phase === "loading" && shownAt !== null ? shownAt + loaderMinMs - Date.now() : 0;
    const timer = setTimeout(reveal, Math.max(SETTLE_MS, loaderRemaining));
    return () => clearTimeout(timer);
  }, [pending, phase, revealed, loaderMinMs, reveal]);

  // A page gate that unmounts while its loader shows (a route guard handing
  // over to the resolved page) leaves the loader to the next page for a moment.
  useLayoutEffect(() => {
    return () => {
      if (visibleLoader?.owner === owner) visibleLoader.releasedAt = Date.now();
    };
  }, [owner]);

  return { phase, revealed, register, animateReveal, revealedAt };
}

const REVEAL_EASING = "cubic-bezier(0.25, 0.1, 0.25, 1)";
const REVEAL_STEP_MS = 35;
const REVEAL_DURATION_MS = 220;
const REVEAL_MAX_STAGGERED = 10;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Brings a gate's content in block by block: the children of the first
 * element with more than one child, so a page wrapped in one layout div
 * still staggers its sections. Loader elements are skipped.
 */
export function staggerReveal(root: HTMLElement, offsetY = 6) {
  if (prefersReducedMotion()) return;
  let container: Element = root;
  for (let depth = 0; depth < 3; depth += 1) {
    const children = Array.from(container.children).filter(
      (child) => !child.hasAttribute("data-reveal-skip")
    );
    if (children.length !== 1) break;
    container = children[0];
  }
  let blocks = Array.from(container.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.hasAttribute("data-reveal-skip")
  );
  if (blocks.length === 0) blocks = [root];
  blocks.forEach((block, index) => {
    if (typeof block.animate !== "function") return;
    block.animate(
      [
        { opacity: 0, transform: `translateY(${offsetY}px)` },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: REVEAL_DURATION_MS,
        delay: Math.min(index, REVEAL_MAX_STAGGERED) * REVEAL_STEP_MS,
        easing: REVEAL_EASING,
        fill: "backwards",
      }
    );
  });
}

/** Grows an element from its current height to its natural height. */
export function growToNaturalHeight(element: HTMLElement, fromHeight: number) {
  if (prefersReducedMotion() || typeof element.animate !== "function") return;
  const toHeight = element.scrollHeight;
  if (Math.abs(toHeight - fromHeight) < 2) return;
  element.animate([{ height: `${fromHeight}px` }, { height: `${toHeight}px` }], {
    duration: 200,
    easing: REVEAL_EASING,
  });
}

/** The loader a gate shows once content takes longer than its delay. */
export function ContentLoader({ className }: { className?: string }) {
  return (
    <div
      data-reveal-skip=""
      role="status"
      aria-label="Loading"
      className={
        className ??
        "content-loader pointer-events-none absolute inset-0 flex min-h-32 items-center justify-center"
      }
      style={{ visibility: "visible" }}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    </div>
  );
}
