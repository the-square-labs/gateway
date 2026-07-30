import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyValueField } from "@/components/common/CopyValueField";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { InferenceOAuthSession, InferenceProviderCatalogItem } from "@/types/inference";

type AuthType = "oauth" | "api_key" | "local";

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function InferenceProviderConnectDialog({
  open,
  catalog,
  initialProviderId,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  catalog: InferenceProviderCatalogItem[];
  initialProviderId?: string;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void | Promise<void>;
}) {
  const initial = useMemo(
    () =>
      catalog.find((provider) => provider.id === initialProviderId) ??
      catalog.find((provider) => provider.featured) ??
      catalog[0],
    [catalog, initialProviderId]
  );
  const [providerId, setProviderId] = useState("");
  const [authType, setAuthType] = useState<AuthType>("api_key");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [oauth, setOAuth] = useState<InferenceOAuthSession | null>(null);
  const [callback, setCallback] = useState("");
  const [saving, setSaving] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const lastSubmittedCallback = useRef("");
  const selected = catalog.find((provider) => provider.id === providerId);
  const contentKey = flowError
    ? "error"
    : oauth
      ? `oauth-${oauth.completionMode}`
      : `setup-${providerId}-${authType}`;

  useEffect(() => {
    if (!open || !initial) return;
    setProviderId(initial.id);
    setAuthType(
      initial.authTypes.includes("oauth") ? "oauth" : (initial.authTypes[0] ?? "api_key")
    );
    setName("");
    setApiKey("");
    setBaseUrl(initial.baseUrl);
    setAllowPrivateNetwork(false);
    setOAuth(null);
    setCallback("");
    setFlowError(null);
    lastSubmittedCallback.current = "";
  }, [initial, open]);

  const selectProvider = (id: string) => {
    const provider = catalog.find((item) => item.id === id);
    setProviderId(id);
    setAuthType(
      provider?.authTypes.includes("oauth") ? "oauth" : (provider?.authTypes[0] ?? "api_key")
    );
    setBaseUrl(provider?.baseUrl ?? "");
    setOauthState(null);
  };

  const setOauthState = useCallback((session: InferenceOAuthSession | null) => {
    setOAuth(session);
    setFlowError(
      session &&
        (session.status === "error" ||
          session.status === "expired" ||
          session.status === "cancelled")
        ? (session.errorMessage ??
            (session.status === "expired"
              ? "Authorization timed out after 10 minutes"
              : session.status === "cancelled"
                ? "Authorization was cancelled"
                : "Authorization failed"))
        : null
    );
  }, []);

  const finish = useCallback(
    async (session: InferenceOAuthSession) => {
      setOauthState(session);
      if (session.status !== "complete") return;
      toast.success("Provider connected");
      onOpenChange(false);
      await onConnected();
    },
    [onConnected, onOpenChange, setOauthState]
  );

  useEffect(() => {
    if (!open || !oauth || oauth.status !== "pending" || oauth.completionMode !== "device_poll")
      return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const session = await api.getInferenceOAuthStatus(oauth.id);
        if (cancelled) return;
        await finish(session);
        if (session.status === "pending") {
          timer = window.setTimeout(poll, Math.max(1, session.pollIntervalSeconds ?? 5) * 1000);
        }
      } catch (error) {
        if (!cancelled)
          setFlowError(
            error instanceof Error ? error.message : "Authorization status check failed"
          );
      }
    };
    timer = window.setTimeout(poll, Math.max(1, oauth.pollIntervalSeconds ?? 5) * 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [finish, oauth, open]);

  useEffect(() => {
    if (!open || !oauth || oauth.status !== "pending") return;
    const remaining = Math.max(0, new Date(oauth.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(async () => {
      try {
        await finish(await api.getInferenceOAuthStatus(oauth.id));
      } catch (error) {
        setFlowError(error instanceof Error ? error.message : "Authorization timed out");
      }
    }, remaining + 250);
    return () => window.clearTimeout(timer);
  }, [finish, oauth, open]);

  useEffect(() => {
    const value = callback.trim();
    if (
      !open ||
      !oauth ||
      oauth.status !== "pending" ||
      oauth.completionMode !== "paste_callback" ||
      !isCompleteCallback(value) ||
      lastSubmittedCallback.current === value
    )
      return;
    const timer = window.setTimeout(async () => {
      lastSubmittedCallback.current = value;
      setSaving(true);
      setFlowError(null);
      try {
        await finish(await api.completeInferenceOAuth(oauth.id, value));
      } catch (error) {
        setFlowError(error instanceof Error ? error.message : "Authorization failed");
      } finally {
        setSaving(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [callback, finish, oauth, open]);

  const connect = async () => {
    if (!selected || !name.trim()) return;
    if (
      authType === "oauth" &&
      selected.subscription &&
      !(await confirm({
        title: "Review provider terms",
        description:
          "The provider may not permit third-party subscription connectors and may restrict or block your account. Review the provider's current Terms of Service before continuing. Continue only if you accept this risk.",
        confirmLabel: "Continue to authorization",
        cancelLabel: "Go back",
        variant: "default",
      }))
    )
      return;
    setSaving(true);
    setFlowError(null);
    try {
      if (authType === "oauth") {
        const session = await api.startInferenceOAuth({
          providerId: selected.id,
          connectionName: name.trim(),
          acceptTerms: selected.subscription,
          termsVersion: selected.termsVersion,
        });
        setOauthState(session);
        window.open(session.authorizationUrl, "_blank", "noopener,noreferrer");
      } else {
        await api.createInferenceProviderConnection({
          providerId: selected.id,
          name: name.trim(),
          authType,
          ...(authType === "api_key" ? { apiKey } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          allowPrivateNetwork,
        });
        toast.success("Provider connected");
        onOpenChange(false);
        await onConnected();
      }
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : "Failed to connect provider");
    } finally {
      setSaving(false);
    }
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen && oauth?.status === "pending")
      void api.cancelInferenceOAuth(oauth.id).catch(() => {});
    onOpenChange(nextOpen);
  };

  const retry = () => {
    if (oauth?.status === "pending") void api.cancelInferenceOAuth(oauth.id).catch(() => {});
    setOauthState(null);
    setCallback("");
    lastSubmittedCallback.current = "";
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect inference provider</DialogTitle>
          <DialogDescription>Add a subscription account or API credential.</DialogDescription>
        </DialogHeader>
        <AnimatedHeight>
          <AnimatePresence initial={false} mode="wait">
            <motion.div key={contentKey} {...STEP_ANIMATION}>
              {!oauth && !flowError && (
                <div className="border border-border">
                  <SettingsControlRow title="Provider">
                    <Select
                      value={providerId}
                      onValueChange={selectProvider}
                      disabled={Boolean(initialProviderId)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {catalog.map((provider) => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsControlRow>
                  <SettingsControlRow title="Connection name">
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Team account"
                    />
                  </SettingsControlRow>
                  {selected && selected.authTypes.length > 1 && (
                    <SettingsControlRow title="Authentication">
                      <Select
                        value={authType}
                        onValueChange={(value) => setAuthType(value as AuthType)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selected.authTypes.map((type) => (
                            <SelectItem key={type} value={type}>
                              {type.replace("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsControlRow>
                  )}
                  {authType === "api_key" && (
                    <SettingsControlRow title="API key">
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        autoComplete="off"
                      />
                    </SettingsControlRow>
                  )}
                  {(selected?.allowBaseUrlOverride || !selected?.baseUrl) && (
                    <SettingsControlRow title="Base URL">
                      <Input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="https://provider.example/v1"
                      />
                    </SettingsControlRow>
                  )}
                  {(selected?.allowBaseUrlOverride || authType === "local") && (
                    <SettingsControlRow
                      title="Allow private network"
                      description="Only for an explicitly trusted private endpoint"
                    >
                      <Switch
                        checked={allowPrivateNetwork}
                        onChange={setAllowPrivateNetwork}
                        ariaLabel="Allow private network"
                      />
                    </SettingsControlRow>
                  )}
                </div>
              )}
              {oauth && !flowError && (
                <div className="space-y-3 border border-border p-4">
                  {oauth.completionMode === "device_poll" ? (
                    <>
                      <p className="text-sm">
                        Complete authorization in the provider window. Gateway checks the status
                        automatically.
                      </p>
                      {oauth.userCode && (
                        <CopyValueField
                          label="Authorization code"
                          value={oauth.userCode}
                          valueClassName="font-mono"
                        />
                      )}
                      <Button asChild variant="outline">
                        <a href={oauth.authorizationUrl} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" />
                          Open authorization
                        </a>
                      </Button>
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        Waiting for provider authorization…
                      </p>
                    </>
                  ) : (
                    <>
                      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                        <li>Open Claude authorization and sign in.</li>
                        <li>Copy the code Claude shows, or the final localhost callback URL.</li>
                        <li>Paste it below. Gateway submits it automatically.</li>
                      </ol>
                      <Button asChild variant="outline">
                        <a href={oauth.authorizationUrl} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" />
                          Open Claude authorization
                        </a>
                      </Button>
                      <Input
                        value={callback}
                        onChange={(event) => setCallback(event.target.value)}
                        placeholder="Paste code#state or callback URL"
                        autoFocus
                      />
                      {saving && (
                        <p className="text-xs text-muted-foreground">Completing authorization…</p>
                      )}
                    </>
                  )}
                </div>
              )}
              {flowError && (
                <div className="border border-destructive/50 p-4">
                  <p className="text-sm font-medium text-destructive">Authorization failed</p>
                  <p className="mt-1 text-sm text-muted-foreground">{flowError}</p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </AnimatedHeight>
        <DialogFooter>
          {flowError && (
            <Button variant="outline" onClick={retry}>
              Retry
            </Button>
          )}
          <Button variant="outline" onClick={() => close(false)}>
            {oauth ? "Close" : "Cancel"}
          </Button>
          {!oauth && (
            <Button
              onClick={() => void connect()}
              disabled={
                saving || !selected || !name.trim() || (authType === "api_key" && !apiKey.trim())
              }
            >
              {saving ? "Connecting…" : authType === "oauth" ? "Start authorization" : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isCompleteCallback(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return Boolean(url.searchParams.get("code") && url.searchParams.get("state"));
  } catch {
    const [code, state] = value.split("#", 2);
    return Boolean(code?.trim() && state?.trim());
  }
}
