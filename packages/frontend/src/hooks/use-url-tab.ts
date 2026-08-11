import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useStableNavigate } from "@/hooks/use-stable-navigate";

/**
 * Syncs active tab state with the URL path.
 * Reads the initial tab from :tab route param and updates URL on tab change.
 */
export function useUrlTab(
  validTabs: string[],
  defaultTab: string,
  buildUrl: (tab: string) => string
): [string, (tab: string) => void] {
  const navigate = useStableNavigate();
  const location = useLocation();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const validTabsKey = validTabs.join("\0");
  const validTabSet = useMemo(
    () => new Set(validTabsKey ? validTabsKey.split("\0") : []),
    [validTabsKey]
  );
  const routeTab = tabParam && validTabSet.has(tabParam) ? tabParam : defaultTab;
  const [activeTab, setActiveTabState] = useState(routeTab);
  const lastRouteTabRef = useRef(tabParam);

  useEffect(() => {
    // A resource-backed tab can become valid only after the resource finishes
    // loading. Keep honoring the URL when that happens instead of preserving
    // the temporary default tab selected during the loading state.
    if (tabParam && validTabSet.has(tabParam)) {
      lastRouteTabRef.current = tabParam;
      setActiveTabState(tabParam);
      return;
    }
    if (tabParam !== lastRouteTabRef.current) {
      lastRouteTabRef.current = tabParam;
      setActiveTabState(routeTab);
      return;
    }

    setActiveTabState((current) => (validTabSet.has(current) ? current : routeTab));
  }, [routeTab, tabParam, validTabSet]);

  const setActiveTab = useCallback(
    (tab: string) => {
      if (!validTabSet.has(tab)) return;
      setActiveTabState(tab);
      navigate(buildUrl(tab), { replace: true, state: location.state });
    },
    [buildUrl, location.state, navigate, validTabSet]
  );

  return [activeTab, setActiveTab];
}
