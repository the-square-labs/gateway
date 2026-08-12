import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

const MAX_SAVED_ROUTES = 50;
const RESTORE_SETTLE_TIMEOUT_MS = 4_000;
const routeScrollPositions = new Map<string, number>();

function routeScrollKey(
  userId: string | null | undefined,
  pathname: string,
  search: string,
  hash: string
) {
  return `${userId ?? "anonymous"}:${pathname}${search}${hash}`;
}

function rememberScrollPosition(key: string, scrollTop: number) {
  routeScrollPositions.delete(key);
  routeScrollPositions.set(key, Math.max(0, scrollTop));
  while (routeScrollPositions.size > MAX_SAVED_ROUTES) {
    const oldestKey = routeScrollPositions.keys().next().value;
    if (oldestKey === undefined) break;
    routeScrollPositions.delete(oldestKey);
  }
}

function findRouteScrollContainer(): HTMLElement | null {
  const page = document.querySelector<HTMLElement>("[data-page-transition]");
  if (!page) return null;

  for (const child of page.children) {
    if (child instanceof HTMLElement && child.matches(".overflow-y-auto, .overflow-auto")) {
      return child;
    }
  }

  const explicit = page.querySelector<HTMLElement>("[data-route-scroll-container]");
  if (explicit) return explicit;

  return page.querySelector<HTMLElement>(".overflow-y-auto, .overflow-auto");
}

/**
 * Preserve the active route scroll container across list/detail component swaps.
 *
 * Resource pages own their vertical scrollers instead of scrolling `window`, so
 * React Router cannot restore them. This hook lives in the persistent shell and
 * remembers the scroller by route until the list component mounts again.
 */
export function useRouteScrollRestoration(userId: string | null | undefined) {
  const location = useLocation();
  const key = routeScrollKey(userId, location.pathname, location.search, location.hash);

  useLayoutEffect(() => {
    if (location.pathname === "/" || location.pathname.startsWith("/ai/")) return;

    const savedScrollTop = routeScrollPositions.get(key);
    let scrollContainer: HTMLElement | null = null;
    let restorePending = savedScrollTop !== undefined && savedScrollTop > 0;
    let contentObserver: MutationObserver | null = null;
    let discoveryObserver: MutationObserver | null = null;
    let settleTimer: number | null = null;

    const finishRestore = () => {
      restorePending = false;
      contentObserver?.disconnect();
      contentObserver = null;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    };

    const attemptRestore = () => {
      if (!scrollContainer || !restorePending || savedScrollTop === undefined) return;
      scrollContainer.scrollTop = savedScrollTop;
      if (scrollContainer.scrollTop >= savedScrollTop - 1) finishRestore();
    };

    const cancelRestoreForUserInput = () => {
      if (!scrollContainer || !restorePending) return;
      finishRestore();
      rememberScrollPosition(key, scrollContainer.scrollTop);
    };

    const trackScroll = () => {
      if (!scrollContainer || restorePending) return;
      rememberScrollPosition(key, scrollContainer.scrollTop);
    };

    const attach = () => {
      if (scrollContainer) return;
      const candidate = findRouteScrollContainer();
      if (!candidate) return;
      scrollContainer = candidate;
      discoveryObserver?.disconnect();
      discoveryObserver = null;

      scrollContainer.addEventListener("scroll", trackScroll, { passive: true });
      scrollContainer.addEventListener("wheel", cancelRestoreForUserInput, { passive: true });
      scrollContainer.addEventListener("touchstart", cancelRestoreForUserInput, { passive: true });
      scrollContainer.addEventListener("pointerdown", cancelRestoreForUserInput, { passive: true });
      scrollContainer.addEventListener("keydown", cancelRestoreForUserInput);

      if (!restorePending) return;
      contentObserver = new MutationObserver(attemptRestore);
      contentObserver.observe(scrollContainer, { childList: true, subtree: true });
      settleTimer = window.setTimeout(() => {
        if (!scrollContainer || savedScrollTop === undefined) return;
        scrollContainer.scrollTop = Math.min(
          savedScrollTop,
          Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
        );
        finishRestore();
        rememberScrollPosition(key, scrollContainer.scrollTop);
      }, RESTORE_SETTLE_TIMEOUT_MS);
      attemptRestore();
    };

    attach();
    if (!scrollContainer) {
      discoveryObserver = new MutationObserver(attach);
      discoveryObserver.observe(document.body, { childList: true, subtree: true });
      attach();
    }

    return () => {
      discoveryObserver?.disconnect();
      contentObserver?.disconnect();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (!scrollContainer) return;
      scrollContainer.removeEventListener("scroll", trackScroll);
      scrollContainer.removeEventListener("wheel", cancelRestoreForUserInput);
      scrollContainer.removeEventListener("touchstart", cancelRestoreForUserInput);
      scrollContainer.removeEventListener("pointerdown", cancelRestoreForUserInput);
      scrollContainer.removeEventListener("keydown", cancelRestoreForUserInput);
      if (!restorePending || savedScrollTop === undefined) {
        rememberScrollPosition(key, scrollContainer.scrollTop);
      }
    };
  }, [key, location.pathname]);
}

export const routeScrollRestorationTestApi = {
  clear: () => routeScrollPositions.clear(),
};
