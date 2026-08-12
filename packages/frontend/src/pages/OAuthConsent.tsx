import { AlertTriangle, Check, Loader2, Shield, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ScopeList } from "@/components/common/ScopeList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { OAuthConsentPreview } from "@/types";
import { TOKEN_SCOPES } from "@/types";

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
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<ConsentResult | null>(null);
  const [scopeSearch, setScopeSearch] = useState("");

  const load = useCallback(async () => {
    if (!requestId) {
      setError("Missing OAuth request.");
      return;
    }
    try {
      const data = await api.getOAuthConsent(requestId);
      setPreview(data);
      setSelectedScopes(
        data.grantableScopes.filter((scope) => !data.manualApprovalScopes.includes(scope))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth request could not be loaded");
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grantableScopeItems = useMemo(
    () => (preview?.grantableScopes ?? []).map(scopeItem),
    [preview]
  );
  const unavailableScopeItems = useMemo(
    () => (preview?.unavailableScopes ?? []).map(scopeItem),
    [preview]
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

  const setScopeSelected = (scope: string, checked: boolean) => {
    setSelectedScopes((current) =>
      checked ? [...new Set([...current, scope])] : current.filter((item) => item !== scope)
    );
  };

  const deliverRedirect = async (redirectUrl: string): Promise<boolean> => {
    try {
      await fetch(redirectUrl, {
        method: "GET",
        mode: "no-cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      });
      return true;
    } catch {
      return false;
    }
  };

  const approve = async () => {
    if (!requestId || selectedScopes.length === 0) return;
    setIsSubmitting(true);
    try {
      const result = await api.approveOAuthConsent(requestId, selectedScopes);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      const delivered = await deliverRedirect(result.redirectUrl);
      if (!delivered) {
        window.location.href = result.redirectUrl;
        return;
      }
      setResult({ kind: "approved", redirectUrl: result.redirectUrl, delivered });
      setIsSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setIsSubmitting(false);
    }
  };

  const deny = async () => {
    if (!requestId) return;
    setIsSubmitting(true);
    try {
      const result = await api.denyOAuthConsent(requestId);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      const delivered = await deliverRedirect(result.redirectUrl);
      if (!delivered) {
        window.location.href = result.redirectUrl;
        return;
      }
      setResult({ kind: "denied", redirectUrl: result.redirectUrl, delivered });
      setIsSubmitting(false);
    } catch (err) {
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
                <Input
                  value={scopeSearch}
                  onChange={(event) => setScopeSearch(event.target.value)}
                  placeholder="Search scopes..."
                  className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
                />
                <ScopeList
                  scopes={grantableScopeItems}
                  search={scopeSearch}
                  selected={selectedScopes}
                  onToggle={(scope) => setScopeSelected(scope, !selectedScopes.includes(scope))}
                  readOnly={isSubmitting}
                  viewportClassName="max-h-[24rem] overflow-y-auto overscroll-contain"
                />
              </div>
            </section>

            {preview.unavailableScopes.length > 0 && (
              <section className="p-5">
                <h2 className="text-sm font-semibold text-foreground">Unavailable scopes</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These were requested but cannot be granted by your account.
                </p>
                <div className="mt-3 divide-y divide-border border border-border opacity-80">
                  <ScopeList
                    scopes={unavailableScopeItems}
                    search=""
                    selected={[]}
                    onToggle={() => {}}
                    readOnly
                  />
                </div>
              </section>
            )}
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-border p-5 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={deny} disabled={isSubmitting}>
              <X className="h-4 w-4" />
              Deny
            </Button>
            <Button onClick={approve} disabled={isSubmitting || selectedScopes.length === 0}>
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
