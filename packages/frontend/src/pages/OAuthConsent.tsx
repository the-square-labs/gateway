import { AlertTriangle, Check, Loader2, Shield, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ScopeList } from "@/components/common/ScopeList";
import {
  ScopeSearchFilter,
  type ScopeSelectionFilter,
} from "@/components/common/ScopeSearchFilter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  parseScopesForForm,
} from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useCAStore } from "@/stores/ca";
import type {
  DatabaseConnection,
  LoggingSchema,
  Node,
  OAuthConsentPreview,
  ProxyHost,
} from "@/types";
import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";

type OAuthScopeItem = {
  value: string;
  label: string;
  desc: string;
  group: string;
};

type ConsentResult = {
  kind: "approved" | "denied";
  redirectUrl: string;
  delivered: boolean;
};

const OAUTH_ONLY_SCOPES: Record<string, Omit<OAuthScopeItem, "value">> = {
  "inference:setup": {
    label: "Set up inference clients",
    desc: "Configure supported inference clients and manage their dedicated runtime tokens.",
    group: "Inference",
  },
};

function scopeItem(scope: string): OAuthScopeItem {
  const oauthOnlyScope = OAUTH_ONLY_SCOPES[scope];
  if (oauthOnlyScope) return { value: scope, ...oauthOnlyScope };

  const match = [...TOKEN_SCOPES]
    .sort((a, b) => b.value.length - a.value.length)
    .find((item) => scope === item.value || scope.startsWith(`${item.value}:`));
  return {
    value: scope,
    label: match?.label ?? scope,
    desc: match?.desc ?? scope,
    group: match?.group ?? "Scope",
  };
}

export function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request") ?? "";
  const [preview, setPreview] = useState<OAuthConsentPreview | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [resourceScopes, setResourceScopes] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<ConsentResult | null>(null);
  const [scopeSearch, setScopeSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeSelectionFilter>("all");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [databases, setDatabases] = useState<DatabaseConnection[]>([]);
  const [loggingSchemas, setLoggingSchemas] = useState<LoggingSchema[]>([]);
  const { cas, fetchCAs } = useCAStore();

  const load = useCallback(async () => {
    if (!requestId) {
      setError("Missing OAuth request.");
      return;
    }
    try {
      const data = await api.getOAuthConsent(requestId);
      setPreview(data);
      const defaults = parseScopesForForm(
        data.grantableScopes.filter((scope) => !data.manualApprovalScopes.includes(scope))
      );
      setSelectedScopes(defaults.baseScopes);
      setResourceScopes(defaults.resources);
      setScopeSearch("");
      setScopeFilter("all");
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth request could not be loaded");
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchCAs();
    void Promise.all([
      api
        .listNodes({ limit: 100 })
        .then((response) => setNodes(response.data ?? []))
        .catch(() => setNodes([])),
      api
        .listProxyHosts({ limit: 100 })
        .then((response) => setProxyHosts(response.data ?? []))
        .catch(() => setProxyHosts([])),
      api
        .listDatabases({ limit: 200 })
        .then((response) => setDatabases(response.data ?? []))
        .catch(() => setDatabases([])),
      api
        .listLoggingSchemas()
        .then(setLoggingSchemas)
        .catch(() => setLoggingSchemas([])),
    ]);
  }, [fetchCAs]);

  const grantableParsed = useMemo(
    () => parseScopesForForm(preview?.grantableScopes ?? []),
    [preview?.grantableScopes]
  );

  const grantableScopeItems = useMemo(
    () => grantableParsed.baseScopes.map(scopeItem),
    [grantableParsed.baseScopes]
  );
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(preview?.grantableScopes ?? []),
    [preview?.grantableScopes]
  );
  const finalSelectedScopes = useMemo(
    () => buildFinalScopes(selectedScopes, resourceScopes),
    [resourceScopes, selectedScopes]
  );
  const hasMissingResourceSelection = selectedScopes.some(
    (scope) =>
      (allowedResourceIdsByScope[scope]?.length ?? 0) > 0 &&
      (resourceScopes[scope]?.length ?? 0) === 0
  );
  const hasManualApprovalScopes = (preview?.manualApprovalScopes.length ?? 0) > 0;

  const resourceLabel = preview?.resourceInfo.name ?? "Gateway API";
  const redirectHost = useMemo(() => {
    if (!preview?.redirect.uri) return null;
    try {
      return new URL(preview.redirect.uri).host;
    } catch {
      return preview.redirect.uri;
    }
  }, [preview?.redirect.uri]);

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) => {
      if (current.includes(scope)) {
        setResourceScopes((resources) => {
          const next = { ...resources };
          delete next[scope];
          return next;
        });
        return current.filter((item) => item !== scope);
      }
      const allowedIds = allowedResourceIdsByScope[scope];
      if (allowedIds?.length) {
        setResourceScopes((resources) => ({ ...resources, [scope]: allowedIds }));
      }
      return [...current, scope];
    });
  };

  const openLoopbackCallbackWindow = () =>
    window.open(
      "about:blank",
      "gateway-oauth-callback",
      "popup,width=520,height=320,left=120,top=120"
    );

  const approve = async () => {
    if (!requestId || finalSelectedScopes.length === 0 || hasMissingResourceSelection) return;
    const callbackWindow = preview?.redirect.isExternal ? null : openLoopbackCallbackWindow();
    setIsSubmitting(true);
    try {
      const result = await api.approveOAuthConsent(requestId, finalSelectedScopes);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      if (!callbackWindow) {
        window.location.href = result.redirectUrl;
        return;
      }
      callbackWindow.location.replace(result.redirectUrl);
      setResult({ kind: "approved", redirectUrl: result.redirectUrl, delivered: true });
      setIsSubmitting(false);
    } catch (err) {
      callbackWindow?.close();
      setError(err instanceof Error ? err.message : "Authorization failed");
      setIsSubmitting(false);
    }
  };

  const deny = async () => {
    if (!requestId) return;
    const callbackWindow = preview?.redirect.isExternal ? null : openLoopbackCallbackWindow();
    setIsSubmitting(true);
    try {
      const result = await api.denyOAuthConsent(requestId);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      if (!callbackWindow) {
        window.location.href = result.redirectUrl;
        return;
      }
      callbackWindow.location.replace(result.redirectUrl);
      setResult({ kind: "denied", redirectUrl: result.redirectUrl, delivered: true });
      setIsSubmitting(false);
    } catch (err) {
      callbackWindow?.close();
      setError(err instanceof Error ? err.message : "Could not deny authorization");
      setIsSubmitting(false);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md border border-border bg-card p-5">
          <h1 className="text-lg font-semibold text-foreground">OAuth authorization failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading authorization request...
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted">
              {result.kind === "approved" ? (
                <Check className="h-5 w-5 text-foreground" />
              ) : (
                <X className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Gateway OAuth</p>
              <h1 className="text-lg font-semibold text-foreground">
                {result.kind === "approved" ? "Authorization complete" : "Authorization denied"}
              </h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            The OAuth response was sent to the application. If the application did not finish
            signing in, use the callback button to open the authorization result directly.
          </p>
          <div className="mt-5 flex justify-start">
            <Button asChild>
              <a href={result.redirectUrl} rel="noreferrer">
                Open callback
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-[100dvh] overflow-y-auto bg-background px-4 py-4 sm:py-8"
      data-oauth-consent-scroll-viewport=""
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          className="flex w-full max-w-2xl flex-col border border-border bg-card"
          data-oauth-consent-card=""
        >
          <div className="border-b border-border p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <img src="/android-chrome-192x192.png" alt="Gateway" className="h-9 w-9" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Gateway OAuth</p>
                    <h1 className="text-xl font-semibold text-foreground">
                      Authorize {resourceLabel} access
                    </h1>
                  </div>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{preview.client.name}</span> is
                  requesting scoped access to{" "}
                  <span className="font-medium text-foreground">{resourceLabel}</span>.
                </p>
              </div>
              <Badge variant="warning" className="shrink-0">
                Unverified client
              </Badge>
            </div>
          </div>

          <div className="flex flex-col divide-y divide-border" data-oauth-consent-body="">
            <section className="p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted text-sm font-semibold">
                  {(preview.account.name || preview.account.email).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {preview.account.name ?? preview.account.email}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{preview.account.email}</p>
                </div>
              </div>
            </section>

            <section className="bg-warning/15 px-5 py-3">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 shrink-0 text-warning-foreground" />
                <p className="text-sm font-semibold text-warning-foreground">
                  Only authorize tools you trust. Gateway cannot verify this client; it can only
                  enforce the scopes you approve and the permissions your account currently has.
                </p>
              </div>
            </section>

            {preview.redirect.isExternal && (
              <section className="bg-destructive/10 px-5 py-3">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                  <p className="text-sm font-semibold text-destructive">
                    External OAuth callback. If you authorize this request, the authorization result
                    will be sent to {redirectHost ?? "an external callback URL"}.
                  </p>
                </div>
              </section>
            )}

            {hasManualApprovalScopes && (
              <section className="bg-destructive/10 px-5 py-3">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                  <p className="text-sm font-semibold text-destructive">
                    Some requested scopes can reveal sensitive data, export private key material, or
                    perform high-risk operations. They are unchecked until you explicitly approve
                    them.
                  </p>
                </div>
              </section>
            )}

            <section className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Requested scopes</h2>
              </div>
              <div className="flex min-h-0 flex-col border border-border">
                <ScopeSearchFilter
                  search={scopeSearch}
                  onSearchChange={setScopeSearch}
                  filter={scopeFilter}
                  onFilterChange={setScopeFilter}
                  placeholder="Search scopes..."
                />
                <ScopeList
                  scopes={grantableScopeItems}
                  search={scopeSearch}
                  selectionFilter={scopeFilter}
                  selected={selectedScopes}
                  onToggle={toggleScope}
                  resources={resourceScopes}
                  onToggleResource={(scope, resourceId) => {
                    setResourceScopes((current) => {
                      const selected = current[scope] ?? [];
                      return {
                        ...current,
                        [scope]: selected.includes(resourceId)
                          ? selected.filter((id) => id !== resourceId)
                          : [...selected, resourceId],
                      };
                    });
                    setSelectedScopes((current) => [...new Set([...current, scope])]);
                  }}
                  cas={cas}
                  nodes={nodes}
                  proxyHosts={proxyHosts}
                  databases={databases}
                  loggingSchemas={loggingSchemas}
                  restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
                  allowedResourceIds={allowedResourceIdsByScope}
                  readOnly={isSubmitting}
                  viewportClassName="max-h-[24rem] overflow-y-auto overscroll-contain"
                />
              </div>
            </section>
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-border p-5 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={deny} disabled={isSubmitting}>
              <X className="h-4 w-4" />
              Deny
            </Button>
            <Button
              onClick={approve}
              disabled={
                isSubmitting || finalSelectedScopes.length === 0 || hasMissingResourceSelection
              }
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Authorize
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
