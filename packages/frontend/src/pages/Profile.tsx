import { startRegistration } from "@simplewebauthn/browser";
import {
  ArrowRight,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  type LucideIcon,
  Monitor,
  Moon,
  Plus,
  Printer,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/CopyButton";
import { CopyValueField } from "@/components/common/CopyValueField";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AI_APPROVAL_MODE_META,
  AI_APPROVAL_MODES,
  type AIApprovalMode,
} from "@/lib/ai-approval-mode";
import {
  confirmBypassEverythingMode,
  updateAIApprovalModeOptimistically,
} from "@/lib/ai-user-preferences";
import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import { cn, getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import {
  AI_SCOPE,
  type BrowserSession,
  type DatabaseConnection,
  type LoggingSchema,
  type Node,
  type ProxyHost,
} from "@/types";
import { InferenceTokensSection } from "./inference/InferenceTokensSection";
import { InferenceUsage } from "./inference/InferenceUsagePanels";
import { ApiTokensSection } from "./settings/ApiTokensSection";
import { InferenceEndpointSettingsPanel } from "./settings/inference/InferenceEndpointSettingsPanel";
import { OAuthApplicationsSection } from "./settings/OAuthApplicationsSection";

const PROFILE_TABS = ["preferences", "authorizations"] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

export function Profile() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { user, hasScope } = useAuthStore();
  const {
    theme,
    setTheme,
    showUpdateNotifications,
    setShowUpdateNotifications,
    showSystemCertificates,
    setShowSystemCertificates,
    aiApprovalMode,
  } = useUIStore();
  const [nodesList, setNodesList] = useState<Node[]>([]);
  const [proxyHostsList, setProxyHostsList] = useState<ProxyHost[]>([]);
  const [databasesList, setDatabasesList] = useState<DatabaseConnection[]>([]);
  const [loggingSchemasList, setLoggingSchemasList] = useState<LoggingSchema[]>([]);
  const activeTab: ProfileTab = isProfileTab(tabParam) ? tabParam : "preferences";
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const canUseAI = hasScope(AI_SCOPE);
  const canUseInference = inferenceEnabled && hasScope("feat:ai:use");
  const canViewInferenceUsage = hasScope("feat:ai:use");
  const canManageInferenceTokens = hasScope("inference:tokens:manage");
  const canViewSystemCertificates = hasScope("admin:details:certificates");
  const userScopes = user?.scopes;

  useEffect(() => {
    if (tabParam && !isProfileTab(tabParam)) {
      navigate("/profile", { replace: true });
    }
  }, [navigate, tabParam]);

  useEffect(() => {
    if (activeTab !== "authorizations") return;

    api
      .listNodes({ limit: 100 })
      .then((result) => setNodesList(result.data ?? []))
      .catch(() => {});
    api
      .listProxyHosts({ limit: 100 })
      .then((result) => setProxyHostsList(result.data ?? []))
      .catch(() => {});
    api
      .listDatabases({ limit: 200 })
      .then((result) => setDatabasesList(result.data ?? []))
      .catch(() => {});
    if (
      scopeMatches(userScopes ?? [], "logs:schemas:view") ||
      scopeMatches(userScopes ?? [], "logs:manage") ||
      (deriveAllowedResourceIdsByScope(userScopes ?? [])["logs:schemas:view"]?.length ?? 0) > 0
    ) {
      api
        .listLoggingSchemas()
        .then(setLoggingSchemasList)
        .catch(() => {});
    }
  }, [activeTab, userScopes]);

  const handleToggleSystemCertificates = (checked: boolean) => {
    setShowSystemCertificates(checked);
    api.invalidateCache("req:/api/cas");
    api.invalidateCache("req:/api/certificates");
    api.invalidateCache("req:/api/ssl-certificates");
    api.invalidateCache("req:/api/monitoring/dashboard");
    api.invalidateCache("cas:list:");
    api.invalidateCache("certificates:list:");
    api.invalidateCache("ssl:list:");
    api.invalidateCache("dashboard:stats:");
  };

  const handleAIApprovalModeChange = async (mode: AIApprovalMode) => {
    if (mode === aiApprovalMode) return;
    if (
      mode === "bypass-everything" &&
      aiApprovalMode !== "bypass-everything" &&
      !(await confirmBypassEverythingMode())
    ) {
      return;
    }

    try {
      await updateAIApprovalModeOptimistically(mode, aiApprovalMode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update AI mode");
    }
  };

  const handleTabChange = (value: string) => {
    navigate(value === "preferences" ? "/profile" : "/profile/authorizations");
  };

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <div className="flex items-center gap-3">
          <LiteModeBackButton />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">Profile</h1>
            <p className="text-sm text-muted-foreground">Personal settings and authorizations</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="preferences" className="gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Preferences
            </TabsTrigger>
            <TabsTrigger value="authorizations" className="gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              Authorizations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preferences" className="pb-0">
            <div className="space-y-4">
              <PanelShell title="Profile">
                {user && (
                  <div className="flex items-center gap-4 p-4">
                    <Avatar className="h-10 w-10 shrink-0">
                      <AvatarImage src={user.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-sm">
                        {getInitials(user.name || user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{user.name || "Not set"}</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>
                    <Badge variant="secondary" size="inline">
                      {user.groupName}
                    </Badge>
                  </div>
                )}
              </PanelShell>

              {canUseInference && <InferenceEndpointSettingsPanel />}

              {user?.authMethod !== "oidc" && <LocalAccountSecurityPanel />}

              {canUseInference && canViewInferenceUsage && <InferenceUsage />}

              <PanelShell title="Preferences">
                <div className="divide-y divide-border">
                  <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div>
                      <p className="text-sm font-medium">Theme</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Choose how the interface looks
                      </p>
                    </div>
                    <div className="flex w-fit shrink-0 gap-0 border border-border">
                      {(["light", "dark", "system"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTheme(value)}
                          className={`flex items-center gap-2 px-4 py-2 text-sm capitalize transition-colors ${
                            theme === value
                              ? "bg-primary text-primary-foreground"
                              : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {value === "light" && <Sun className="h-3.5 w-3.5" />}
                          {value === "dark" && <Moon className="h-3.5 w-3.5" />}
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">Update notifications</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Show update banners in sidebar and dashboard
                      </p>
                    </div>
                    <Switch
                      checked={showUpdateNotifications}
                      onChange={setShowUpdateNotifications}
                    />
                  </div>
                  {canViewSystemCertificates && (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Show system certificates</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Include internal PKI and SSL certificates in lists and dashboard counts
                        </p>
                      </div>
                      <Switch
                        checked={showSystemCertificates}
                        onChange={handleToggleSystemCertificates}
                      />
                    </div>
                  )}
                  {canUseAI && (
                    <AIApprovalModeRow
                      value={aiApprovalMode}
                      onChange={handleAIApprovalModeChange}
                    />
                  )}
                </div>
              </PanelShell>
            </div>
          </TabsContent>

          <TabsContent value="authorizations" className="pb-0">
            <div className="space-y-4">
              <ApiTokensSection
                user={user}
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
              />
              <OAuthApplicationsSection
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
              />
              {canUseInference && <InferenceTokensSection canManage={canManageInferenceTokens} />}
              <BrowserSessionsPanel />
            </div>
          </TabsContent>
        </Tabs>

        <PoweredByFooter />
      </div>
    </PageTransition>
  );
}

function BrowserSessionsPanel() {
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const hasOtherSessions = sessions.some((session) => !session.isCurrent);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await api.listCurrentUserSessions());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load active sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await api.revokeCurrentUserSession(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      toast.success("Session revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke session");
    }
  };

  const revokeOthers = async () => {
    try {
      const count = await api.revokeOtherCurrentUserSessions();
      setSessions((current) => current.filter((session) => session.isCurrent));
      toast.success(count === 1 ? "One other session revoked" : `${count} other sessions revoked`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke sessions");
    }
  };

  return (
    <PanelShell
      title="Active sessions"
      description="Browser sessions currently authorized for this account"
      actions={
        hasOtherSessions ? (
          <Button variant="outline" onClick={revokeOthers} disabled={loading}>
            Sign out other sessions
          </Button>
        ) : null
      }
    >
      <div className="divide-y divide-border">
        {loading ? (
          <SessionRowsSkeleton />
        ) : sessions.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No active browser sessions</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
                session.isCurrent && hasOtherSessions && "bg-muted/60 dark:bg-muted"
              )}
            >
              <div className="flex min-w-0 items-center gap-4">
                <SessionDeviceIcon
                  userAgent={session.userAgent}
                  inverted={session.isCurrent && hasOtherSessions}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {session.isCurrent ? "This browser" : sessionBrowserLabel(session.userAgent)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {session.authMethod.replace("_", " ")} · {session.ipAddress || "Unknown IP"} ·
                    Last active {new Date(session.lastSeenAt).toLocaleString()}
                  </p>
                </div>
              </div>
              {!session.isCurrent && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => revoke(session.id)}
                  aria-label={`Revoke session from ${session.userAgent ? sessionBrowserLabel(session.userAgent) : session.ipAddress || "unknown browser"}`}
                  title="Revoke session"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </PanelShell>
  );
}

function SessionRowsSkeleton() {
  return (
    <div aria-label="Loading active sessions">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-4">
            <Skeleton className="h-10 w-10 shrink-0" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-64 max-w-[60vw]" />
            </div>
          </div>
          <Skeleton className="h-9 w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function SessionDeviceIcon({
  userAgent,
  inverted,
}: {
  userAgent: string | null;
  inverted: boolean;
}) {
  const { Icon, label } = sessionDeviceFromUserAgent(userAgent);
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center",
        inverted ? "bg-card" : "bg-muted"
      )}
      title={label}
    >
      <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

function sessionDeviceFromUserAgent(userAgent: string | null): {
  Icon: LucideIcon;
  label: string;
} {
  if (!userAgent) return { Icon: Monitor, label: "Unknown device" };
  if (/iPad|Tablet|PlayBook|Silk\//i.test(userAgent)) return { Icon: Tablet, label: "Tablet" };
  if (/Mobi|Android.*Mobile|iPhone|iPod|Windows Phone/i.test(userAgent)) {
    return { Icon: Smartphone, label: "Phone" };
  }
  return { Icon: Monitor, label: "Desktop computer" };
}

function sessionBrowserLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";

  const browser = /Edg\//i.test(userAgent)
    ? "Microsoft Edge"
    : /OPR\//i.test(userAgent)
      ? "Opera"
      : /Chrome\//i.test(userAgent)
        ? "Chrome"
        : /Firefox\//i.test(userAgent)
          ? "Firefox"
          : /Version\/.*Safari\//i.test(userAgent)
            ? "Safari"
            : null;
  const platform = /iPhone|iPad/i.test(userAgent)
    ? "iOS"
    : /Android/i.test(userAgent)
      ? "Android"
      : /Macintosh/i.test(userAgent)
        ? "macOS"
        : /Windows/i.test(userAgent)
          ? "Windows"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser || "Unknown browser";
}

function LocalAccountSecurityPanel() {
  const [status, setStatus] = useState<{
    totpConfigured: boolean;
    passkeyCount: number;
    recoveryCodeCount: number;
  } | null>(null);
  const [passkeys, setPasskeys] = useState<
    Array<{ id: string; name: string; lastUsedAt: string | null; createdAt: string }>
  >([]);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [passkeysSearch, setPasskeysSearch] = useState("");
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpSaving, setTotpSaving] = useState(false);
  const [totpResetOpen, setTotpResetOpen] = useState(false);
  const [totpResetting, setTotpResetting] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryCodesOpen, setRecoveryCodesOpen] = useState(false);
  const totpCloseTimer = useRef<number | null>(null);
  const recoveryCodesCloseTimer = useRef<number | null>(null);
  const pendingRecoveryCodes = useRef<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextPasskeys] = await Promise.all([
        api.getCurrentUserMfaStatus(),
        api.listCurrentUserPasskeys(),
      ]);
      setStatus(nextStatus);
      setPasskeys(nextPasskeys);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load account security settings"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (totpCloseTimer.current !== null) window.clearTimeout(totpCloseTimer.current);
      if (recoveryCodesCloseTimer.current !== null) {
        window.clearTimeout(recoveryCodesCloseTimer.current);
      }
    },
    []
  );

  const filteredPasskeys = useMemo(() => {
    const query = passkeysSearch.trim().toLocaleLowerCase();
    if (!query) return passkeys;
    return passkeys.filter((passkey) => passkey.name.toLocaleLowerCase().includes(query));
  }, [passkeys, passkeysSearch]);

  const openRecoveryCodes = (codes: string[]) => {
    if (recoveryCodesCloseTimer.current !== null) {
      window.clearTimeout(recoveryCodesCloseTimer.current);
      recoveryCodesCloseTimer.current = null;
    }
    setRecoveryCodes(codes);
    setRecoveryCodesOpen(true);
  };

  const closeRecoveryCodes = () => {
    setRecoveryCodesOpen(false);
    if (recoveryCodesCloseTimer.current !== null) {
      window.clearTimeout(recoveryCodesCloseTimer.current);
    }
    recoveryCodesCloseTimer.current = window.setTimeout(() => {
      setRecoveryCodes(null);
      recoveryCodesCloseTimer.current = null;
    }, 250);
  };

  const finishTotpSetupClose = () => {
    if (totpCloseTimer.current !== null) window.clearTimeout(totpCloseTimer.current);
    totpCloseTimer.current = window.setTimeout(() => {
      setTotpSetup(null);
      setTotpCode("");
      if (pendingRecoveryCodes.current) {
        openRecoveryCodes(pendingRecoveryCodes.current);
        pendingRecoveryCodes.current = null;
      }
      totpCloseTimer.current = null;
    }, 250);
  };

  const closeTotpSetup = () => {
    setTotpSetupOpen(false);
    finishTotpSetupClose();
  };

  const registerPasskey = async () => {
    setAddingPasskey(true);
    try {
      const options = await api.beginCurrentUserPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.finishCurrentUserPasskeyRegistration(response, derivePasskeyName(response));
      await load();
      toast.success("Passkey added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add passkey");
    } finally {
      setAddingPasskey(false);
    }
  };

  const openTotpSetup = async () => {
    if (totpCloseTimer.current !== null) {
      window.clearTimeout(totpCloseTimer.current);
      totpCloseTimer.current = null;
    }
    pendingRecoveryCodes.current = null;
    setTotpSetupOpen(true);
    setTotpSetup(null);
    setTotpCode("");
    try {
      setTotpSetup(await api.beginCurrentUserTotpSetup());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start TOTP setup");
      closeTotpSetup();
    }
  };

  const confirmTotp = async () => {
    setTotpSaving(true);
    try {
      const nextRecoveryCodes = await api.confirmCurrentUserTotpSetup(totpCode);
      pendingRecoveryCodes.current = nextRecoveryCodes;
      closeTotpSetup();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid authentication code");
    } finally {
      setTotpSaving(false);
    }
  };

  const resetAndReconfigureTotp = async () => {
    setTotpResetting(true);
    try {
      await api.resetCurrentUserTotp();
      setTotpResetOpen(false);
      await load();
      await openTotpSetup();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset TOTP");
    } finally {
      setTotpResetting(false);
    }
  };

  const removePasskey = async (id: string) => {
    try {
      await api.removeCurrentUserPasskey(id);
      await load();
      toast.success("Passkey removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove passkey");
    }
  };

  return (
    <PanelShell
      title="Account security"
      description="Configure Gateway MFA and local sign-in credentials"
    >
      <div className="divide-y divide-border">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Passkeys</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status?.passkeyCount ?? 0} configured. A passkey can be used for local sign-in and
              MFA.
            </p>
          </div>
          <Button variant="link" className="h-auto p-0" onClick={() => setPasskeysOpen(true)}>
            Manage Passkeys <ArrowRight />
          </Button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Authenticator app (TOTP)</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status?.totpConfigured
                ? `${status.recoveryCodeCount} recovery codes remain`
                : "Not configured"}
            </p>
          </div>
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => (status?.totpConfigured ? setTotpResetOpen(true) : void openTotpSetup())}
          >
            Manage TOTP <ArrowRight />
          </Button>
        </div>
      </div>

      <Dialog
        open={passkeysOpen}
        onOpenChange={(open) => {
          setPasskeysOpen(open);
          if (!open) setPasskeysSearch("");
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Passkeys</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Passkeys can sign you in and satisfy Gateway multi-factor authentication.
          </DialogDescription>
          <div className="border border-border">
            <Input
              value={passkeysSearch}
              onChange={(event) => setPasskeysSearch(event.target.value)}
              placeholder="Search passkeys..."
              className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
            />
            {filteredPasskeys.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {passkeysSearch ? "No passkeys found." : "No passkeys configured."}
              </p>
            ) : (
              <div className="max-h-[min(25rem,48dvh)] divide-y divide-border overflow-y-auto overscroll-contain">
                {filteredPasskeys.map((passkey) => (
                  <div key={passkey.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{passkey.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {passkey.lastUsedAt
                          ? `Last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
                          : `Added ${new Date(passkey.createdAt).toLocaleString()}`}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void removePasskey(passkey.id)}
                      aria-label={`Remove ${passkey.name}`}
                      title="Remove passkey"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => void registerPasskey()} disabled={addingPasskey}>
              {addingPasskey ? <Loader2 className="animate-spin" /> : <Plus />}
              Add passkey
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={totpSetupOpen}
        onOpenChange={(open) => {
          if (open) return;
          closeTotpSetup();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set up authenticator app</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Scan this QR code with your authenticator app, then enter the generated code to activate
            TOTP.
          </DialogDescription>
          {totpSetup ? (
            <>
              <div className="flex justify-center bg-white p-4">
                <QRCodeSVG
                  value={totpSetup.uri}
                  size={176}
                  level="M"
                  marginSize={4}
                  title="TOTP setup QR code"
                />
              </div>
              <CopyValueField label="Manual setup key" value={totpSetup.secret} />
              <div className="flex gap-2">
                <Input
                  value={totpCode}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  onChange={(event) =>
                    setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
                <Button
                  className="shrink-0"
                  onClick={() => void confirmTotp()}
                  disabled={totpCode.length !== 6 || totpSaving}
                >
                  {totpSaving ? <Loader2 className="animate-spin" /> : <Check />}
                  Activate TOTP
                </Button>
              </div>
            </>
          ) : (
            <div className="flex justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 animate-spin" /> Preparing secure setup…
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={totpResetOpen} onOpenChange={setTotpResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>TOTP is already configured</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Resetting it removes the current authenticator app and recovery codes. Your passkeys
            stay available.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTotpResetOpen(false)}
              disabled={totpResetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void resetAndReconfigureTotp()}
              disabled={totpResetting}
            >
              {totpResetting && <Loader2 className="animate-spin" />}
              Reset &amp; reconfigure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={recoveryCodesOpen}
        onOpenChange={(open) => {
          if (open) return;
          closeRecoveryCodes();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save recovery codes</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Keep these ten codes somewhere safe. Each can be used once if you lose access to your
            authenticator app.
          </DialogDescription>
          {recoveryCodes && (
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code, index) => (
                <Input
                  key={code}
                  value={code}
                  readOnly
                  aria-label={`Recovery code ${index + 1}`}
                  className="font-mono"
                />
              ))}
            </div>
          )}
          <DialogFooter>
            <CopyButton
              value={recoveryCodes?.join("\n") ?? ""}
              label="recovery codes"
              className="border border-input bg-background hover:bg-accent hover:text-accent-foreground"
            />
            <Button
              variant="outline"
              onClick={() => recoveryCodes && printRecoveryCodes(recoveryCodes)}
            >
              <Printer /> Print
            </Button>
            <Button
              onClick={() => {
                closeRecoveryCodes();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}

function derivePasskeyName(response: unknown): string {
  const attachment = (response as { authenticatorAttachment?: string }).authenticatorAttachment;
  if (attachment !== "platform") return "Security key";

  const userAgent = navigator.userAgent;
  if (/Macintosh|iPhone|iPad/i.test(userAgent)) return "iCloud Keychain";
  if (/Windows/i.test(userAgent)) return "Windows Hello";
  if (/Android/i.test(userAgent)) return "Android passkey";
  return "This device's passkey";
}

function printRecoveryCodes(recoveryCodes: string[]) {
  const printWindow = window.open("", "gateway-recovery-codes", "width=640,height=720");
  if (!printWindow) {
    toast.error("Allow pop-ups to print recovery codes");
    return;
  }

  const codes = recoveryCodes.map(escapeHtml).join("<br>");
  printWindow.document.write(
    `<!doctype html><html><head><title>Gateway recovery codes</title><style>body{font-family:ui-monospace,monospace;padding:32px}h1{font-family:system-ui,sans-serif;font-size:20px}.codes{columns:2;line-height:1.8}</style></head><body><h1>Gateway recovery codes</h1><p>Store these codes safely. Each code can be used once.</p><div class="codes">${codes}</div></body></html>`
  );
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function AIApprovalModeRow({
  value,
  onChange,
}: {
  value: AIApprovalMode;
  onChange: (mode: AIApprovalMode) => void | Promise<void>;
}) {
  const current = AI_APPROVAL_MODE_META[value];
  const CurrentIcon = current.icon;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">AI approval mode</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{current.description}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between sm:w-[250px]">
            <span className="flex min-w-0 items-center gap-2">
              <CurrentIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{current.menuLabel}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
          {AI_APPROVAL_MODES.map((mode) => {
            const item = AI_APPROVAL_MODE_META[mode];
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={mode}
                className="items-start gap-3"
                onSelect={() => void onChange(mode)}
              >
                <Icon className="mt-0.5 h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.menuLabel}</span>
                  <span className="block text-xs text-muted-foreground">{item.description}</span>
                </span>
                {value === mode && <Check className="mt-0.5 h-4 w-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
