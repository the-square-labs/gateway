import { Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import {
  DEFAULT_GATEWAY_FEATURES,
  useSystemConfigStore,
  withDefaultSystemConfig,
} from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { AuthProvisioningSettings } from "@/types";
import { GracefulShutdownSettingsPanel } from "./GracefulShutdownSettingsPanel";
import {
  applySmtpPreset,
  DEFAULT_SMTP_DRAFT,
  getSmtpPresetId,
  SMTP_PRESETS,
  type SmtpDraft,
  type SmtpPresetId,
} from "./smtp-presets";

interface AuthProvisioningSectionProps {
  canEdit: boolean;
  section?: "all" | "general" | "advanced" | "features";
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_FILE_UPLOAD_MAX_BYTES = 100 * BYTES_PER_MEGABYTE;
const DEFAULT_FILE_OPEN_MAX_BYTES = 10 * BYTES_PER_MEGABYTE;
const DEFAULT_GENERAL_FEATURES = {
  pkiEnabled: DEFAULT_GATEWAY_FEATURES.pkiEnabled,
  domainsEnabled: DEFAULT_GATEWAY_FEATURES.domainsEnabled,
  siemEnabled: DEFAULT_GATEWAY_FEATURES.siemEnabled,
  inferenceEnabled: DEFAULT_GATEWAY_FEATURES.inferenceEnabled,
};
const DEFAULT_SHUTDOWN_SETTINGS = {
  userRequestDrainSeconds: 30,
  structuredLogDrainSeconds: 5,
  finalizationTimeoutSeconds: 10,
};
const DEFAULT_GENERAL_SETTINGS = {
  publicUrl: null as string | null,
  hideExternalBranding: false,
  fileUploadMaxBytes: DEFAULT_FILE_UPLOAD_MAX_BYTES,
  fileOpenMaxBytes: DEFAULT_FILE_OPEN_MAX_BYTES,
  gatewayGrpcPublicTarget: null as string | null,
  gatewayGrpcLocalIp: null as string | null,
  relayAutoRecovery: true,
  relayGrantTtlHours: 4,
  shutdown: DEFAULT_SHUTDOWN_SETTINGS,
  features: DEFAULT_GENERAL_FEATURES,
};
const DEFAULT_AUTH_METHODS = { oidc: true, password: false, emailOtp: false, passkeyLogin: false };
const DEFAULT_PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 72,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  requireSymbol: false,
};
const DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS = 3;

type SmtpTestEmailKind = "smtp_configuration" | "password_setup" | "password_reset" | "email_otp";

const SMTP_TEST_EMAIL_OPTIONS: Array<{
  value: SmtpTestEmailKind;
  label: string;
  description: string;
}> = [
  {
    value: "smtp_configuration",
    label: "SMTP configuration",
    description: "Basic delivery check.",
  },
  {
    value: "password_setup",
    label: "Set password link",
    description: "Invitation email for a new password account.",
  },
  {
    value: "password_reset",
    label: "Reset password link",
    description: "Recovery email for an existing password account.",
  },
  {
    value: "email_otp",
    label: "Email sign-in code",
    description: "One-time code used by email OTP sign-in.",
  },
];

const DEFAULT_OIDC_DRAFT = {
  issuer: "",
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  scopes: "openid email profile",
};
const DEFAULT_LOGGING_DRAFT = {
  mode: "disabled" as "disabled" | "local" | "external",
  url: "",
  username: "",
  password: "",
  database: "gateway_logs",
  table: "logs",
  requestTimeoutMs: "5000",
};

function bytesToMegabytes(bytes: number) {
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

function withDefaultGeneralSettings(settings: AuthProvisioningSettings | null) {
  if (!settings) return null;
  return {
    ...settings,
    methods: { ...DEFAULT_AUTH_METHODS, ...settings.methods },
    passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, ...settings.passwordPolicy },
    mfaExistingSessionGracePeriodDays:
      settings.mfaExistingSessionGracePeriodDays ?? DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS,
    mcpExtendedCompatibility: settings.mcpExtendedCompatibility ?? true,
    webTransport: settings.webTransport ?? {
      tlsEnabled: false,
      restartRequired: false,
      directAccess: false,
      targetUrl: null,
    },
    generalSettings: {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings.generalSettings,
      features: {
        ...DEFAULT_GENERAL_FEATURES,
        ...settings.generalSettings?.features,
      },
      shutdown: {
        ...DEFAULT_SHUTDOWN_SETTINGS,
        ...settings.generalSettings?.shutdown,
      },
    },
  };
}

function getMfaExistingSessionGracePeriodDays(
  settings: AuthProvisioningSettings | null | undefined
) {
  return (
    settings?.mfaExistingSessionGracePeriodDays ?? DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS
  );
}

export function AuthProvisioningSection({
  canEdit,
  section = "all",
}: AuthProvisioningSectionProps) {
  const licenseFeatures = useUIBootstrapStore(
    (state) => state.snapshot?.license.entitlements.features
  );
  const pkiEntitled = licenseFeatures?.includes("internal-pki") === true;
  const siemEntitled = licenseFeatures?.includes("siem-export") === true;
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(() =>
    withDefaultGeneralSettings(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning") ?? null
    )
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(settings !== null);
  const [isSavingAutoCreate, setIsSavingAutoCreate] = useState(false);
  const [isSavingVerifiedEmail, setIsSavingVerifiedEmail] = useState(false);
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [isSavingGeneral, setIsSavingGeneral] = useState(false);
  const [isSavingWebTls, setIsSavingWebTls] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [isSavingMcpCompatibility, setIsSavingMcpCompatibility] = useState(false);
  const [isSavingOAuthCompatibility, setIsSavingOAuthCompatibility] = useState(false);
  const [isSavingNetwork, setIsSavingNetwork] = useState(false);
  const [isSavingWebhookPolicy, setIsSavingWebhookPolicy] = useState(false);
  const [isSavingLocalAuth, setIsSavingLocalAuth] = useState(false);
  const [isSavingMfaGracePeriod, setIsSavingMfaGracePeriod] = useState(false);
  const [isSavingOidc, setIsSavingOidc] = useState(false);
  const [oidcDraft, setOidcDraft] = useState(DEFAULT_OIDC_DRAFT);
  const [isSavingLogging, setIsSavingLogging] = useState(false);
  const [loggingDraft, setLoggingDraft] = useState(DEFAULT_LOGGING_DRAFT);
  const [mfaGracePeriodDays, setMfaGracePeriodDays] = useState(() =>
    getMfaExistingSessionGracePeriodDays(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")
    )
  );
  const [mfaGracePeriodRaw, setMfaGracePeriodRaw] = useState(() =>
    String(
      getMfaExistingSessionGracePeriodDays(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")
      )
    )
  );
  const [mfaGracePeriodInputKey, setMfaGracePeriodInputKey] = useState(0);
  const [publicUrl, setPublicUrl] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.publicUrl ?? ""
  );
  const [hideExternalBranding, setHideExternalBranding] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.hideExternalBranding ?? false
  );
  const [smtpDraft, setSmtpDraft] = useState<SmtpDraft>(DEFAULT_SMTP_DRAFT);
  const [smtpPreset, setSmtpPreset] = useState<SmtpPresetId>("resend");
  const [smtpTestOpen, setSmtpTestOpen] = useState(false);
  const [smtpTestRecipient, setSmtpTestRecipient] = useState("");
  const [smtpTestEmailKind, setSmtpTestEmailKind] =
    useState<SmtpTestEmailKind>("smtp_configuration");
  const [isSendingSmtpTest, setIsSendingSmtpTest] = useState(false);
  const [trustedProxyCidrs, setTrustedProxyCidrs] = useState(
    () =>
      api
        .getCached<AuthProvisioningSettings>("settings:auth-provisioning")
        ?.networkSecurity.trustedProxyCidrs.join(", ") ?? ""
  );
  const [webhookPrivateCidrs, setWebhookPrivateCidrs] = useState(
    () =>
      api
        .getCached<AuthProvisioningSettings>("settings:auth-provisioning")
        ?.outboundWebhookPolicy.allowedPrivateCidrs.join(", ") ?? ""
  );
  const [fileUploadLimitMb, setFileUploadLimitMb] = useState(() =>
    String(
      bytesToMegabytes(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
          ?.fileUploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES
      )
    )
  );
  const [fileOpenLimitMb, setFileOpenLimitMb] = useState(() =>
    String(
      bytesToMegabytes(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
          ?.fileOpenMaxBytes ?? DEFAULT_FILE_OPEN_MAX_BYTES
      )
    )
  );
  const [gatewayGrpcPublicTarget, setGatewayGrpcPublicTarget] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.gatewayGrpcPublicTarget ?? ""
  );
  const [gatewayGrpcLocalIp, setGatewayGrpcLocalIp] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.gatewayGrpcLocalIp ?? ""
  );
  const [relayGrantTtlHours, setRelayGrantTtlHours] = useState(() =>
    String(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.relayGrantTtlHours ?? 4
    )
  );
  const [pkiEnabled, setPkiEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.pkiEnabled ?? DEFAULT_GATEWAY_FEATURES.pkiEnabled
  );
  const [siemEnabled, setSiemEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.siemEnabled ?? DEFAULT_GATEWAY_FEATURES.siemEnabled
  );
  const [inferenceEnabled, setInferenceEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.inferenceEnabled ?? DEFAULT_GATEWAY_FEATURES.inferenceEnabled
  );
  const skipNextCidrsBlur = useRef(false);
  const skipNextWebhookCidrsBlur = useRef(false);

  const load = useCallback(async () => {
    try {
      const settingsData = await api.getAuthProvisioningSettings();
      const normalizedSettings = withDefaultGeneralSettings(settingsData)!;
      api.setCache("settings:auth-provisioning", normalizedSettings);
      setSettings(normalizedSettings);
      const mfaGracePeriodDays = getMfaExistingSessionGracePeriodDays(normalizedSettings);
      setMfaGracePeriodDays(mfaGracePeriodDays);
      setMfaGracePeriodRaw(String(mfaGracePeriodDays));
      setMfaGracePeriodInputKey((key) => key + 1);
      const smtpPresetId = settingsData.smtp?.host
        ? getSmtpPresetId(settingsData.smtp.host)
        : "resend";
      setSmtpDraft((current) => ({
        ...current,
        host: settingsData.smtp?.host ?? DEFAULT_SMTP_DRAFT.host,
        port: String(settingsData.smtp?.port ?? DEFAULT_SMTP_DRAFT.port),
        tlsMode: settingsData.smtp?.tlsMode ?? DEFAULT_SMTP_DRAFT.tlsMode,
        username: settingsData.smtp?.username ?? DEFAULT_SMTP_DRAFT.username,
        senderName: settingsData.smtp?.senderName ?? "Gateway",
        senderEmail: settingsData.smtp?.senderEmail ?? "",
      }));
      setSmtpPreset(smtpPresetId);
      setOidcDraft({
        issuer: settingsData.oidc?.issuer ?? "",
        clientId: settingsData.oidc?.clientId ?? "",
        clientSecret: "",
        redirectUri: settingsData.oidc?.redirectUri ?? "",
        scopes: settingsData.oidc?.scopes ?? "openid email profile",
      });
      setLoggingDraft({
        mode: settingsData.logging?.mode ?? "disabled",
        url: settingsData.logging?.url ?? "",
        username: settingsData.logging?.username ?? "",
        password: "",
        database: settingsData.logging?.database ?? "gateway_logs",
        table: settingsData.logging?.table ?? "logs",
        requestTimeoutMs: String(settingsData.logging?.requestTimeoutMs ?? 5000),
      });
      setPublicUrl(settingsData.generalSettings.publicUrl ?? "");
      setHideExternalBranding(settingsData.generalSettings.hideExternalBranding ?? false);
      setTrustedProxyCidrs(settingsData.networkSecurity.trustedProxyCidrs.join(", "));
      setWebhookPrivateCidrs(settingsData.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      setFileUploadLimitMb(
        String(bytesToMegabytes(settingsData.generalSettings.fileUploadMaxBytes))
      );
      setFileOpenLimitMb(String(bytesToMegabytes(settingsData.generalSettings.fileOpenMaxBytes)));
      setGatewayGrpcPublicTarget(settingsData.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(settingsData.generalSettings.gatewayGrpcLocalIp ?? "");
      setRelayGrantTtlHours(String(settingsData.generalSettings.relayGrantTtlHours));
      setPkiEnabled(settingsData.generalSettings.features?.pkiEnabled ?? true);
      setSiemEnabled(settingsData.generalSettings.features?.siemEnabled ?? true);
      setInferenceEnabled(settingsData.generalSettings.features?.inferenceEnabled ?? false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Gateway settings");
    } finally {
      setInitialLoadComplete(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedGroup = useMemo(
    () =>
      settings?.availableGroups.find((group) => group.id === settings.oidcDefaultGroupId) ?? null,
    [settings]
  );

  const applySettings = (updated: AuthProvisioningSettings) => {
    const normalizedSettings = withDefaultGeneralSettings(updated)!;
    api.setCache("settings:auth-provisioning", normalizedSettings);
    setSettings(normalizedSettings);
  };

  const handleToggleAutoCreate = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingAutoCreate(true);
    const previous = settings;
    setSettings({ ...settings, oidcAutoCreateUsers: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({ oidcAutoCreateUsers: checked });
      applySettings(updated);
      toast.success("Gateway settings updated");
      if (updated.webTransport?.restartRequired) {
        toast.success("Gateway is restarting with the refreshed web certificate");
        useAppStatusStore
          .getState()
          .setGatewayRestartingActive(
            true,
            updated.webTransport.directAccess ? updated.webTransport.targetUrl : null
          );
      }
    } catch (err) {
      setSettings(previous);
      toast.error(err instanceof Error ? err.message : "Failed to update Gateway settings");
    } finally {
      setIsSavingAutoCreate(false);
    }
  };

  const handleChangeGroup = async (groupId: string) => {
    if (!settings || !canEdit) return;
    setIsSavingGroup(true);
    const previous = settings;
    setSettings({ ...settings, oidcDefaultGroupId: groupId });
    try {
      const updated = await api.updateAuthProvisioningSettings({ oidcDefaultGroupId: groupId });
      applySettings(updated);
      toast.success("Default OIDC group updated");
    } catch (err) {
      setSettings(previous);
      toast.error(err instanceof Error ? err.message : "Failed to update default OIDC group");
    } finally {
      setIsSavingGroup(false);
    }
  };

  const handleToggleRequireVerifiedEmail = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingVerifiedEmail(true);
    const previous = settings;
    setSettings({ ...settings, oidcRequireVerifiedEmail: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oidcRequireVerifiedEmail: checked,
      });
      applySettings(updated);
      toast.success("OIDC email verification setting updated");
    } catch (err) {
      setSettings(previous);
      toast.error(
        err instanceof Error ? err.message : "Failed to update OIDC email verification setting"
      );
    } finally {
      setIsSavingVerifiedEmail(false);
    }
  };

  const handleToggleWebTls = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingWebTls(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({ webTlsEnabled: checked });
      applySettings(withDefaultGeneralSettings(updated)!);
      if (updated.webTransport?.restartRequired) {
        toast.success("Gateway is restarting with the new internal protocol");
        useAppStatusStore
          .getState()
          .setGatewayRestartingActive(
            true,
            updated.webTransport.directAccess ? updated.webTransport.targetUrl : null
          );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update internal HTTPS");
    } finally {
      setIsSavingWebTls(false);
    }
  };

  const saveOidc = async () => {
    if (!settings || !canEdit || !oidcHasChanges) return;
    setIsSavingOidc(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oidc: {
          issuer: oidcDraft.issuer.trim(),
          clientId: oidcDraft.clientId.trim(),
          ...(oidcDraft.clientSecret ? { clientSecret: oidcDraft.clientSecret } : {}),
          redirectUri: oidcDraft.redirectUri.trim(),
          scopes: oidcDraft.scopes.trim(),
        },
      });
      applySettings(withDefaultGeneralSettings(updated)!);
      setOidcDraft((current) => ({ ...current, clientSecret: "" }));
      toast.success("OIDC provider updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update OIDC provider");
    } finally {
      setIsSavingOidc(false);
    }
  };

  const saveLogging = async () => {
    if (!settings || !canEdit || !loggingHasChanges) return;
    setIsSavingLogging(true);
    try {
      const external = loggingDraft.mode === "external";
      const updated = await api.updateAuthProvisioningSettings({
        logging: {
          mode: loggingDraft.mode,
          ...(external
            ? {
                url: loggingDraft.url.trim(),
                username: loggingDraft.username.trim(),
                ...(loggingDraft.password ? { password: loggingDraft.password } : {}),
                database: loggingDraft.database.trim(),
                table: loggingDraft.table.trim(),
                requestTimeoutMs: Number(loggingDraft.requestTimeoutMs),
              }
            : {}),
        },
      });
      applySettings(withDefaultGeneralSettings(updated)!);
      setLoggingDraft((current) => ({ ...current, password: "" }));
      toast.success(
        loggingDraft.mode === "disabled"
          ? "Structured logging disabled; local data was preserved"
          : "Structured logging updated"
      );
    } catch (err) {
      if (!handleLicenseApiError(err, "Structured logging")) {
        toast.error(err instanceof Error ? err.message : "Failed to update structured logging");
      }
    } finally {
      setIsSavingLogging(false);
    }
  };

  const updateGeneralSettings = async (
    patch: Partial<AuthProvisioningSettings["generalSettings"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingGeneral(true);
    const previous = settings;
    const nextGeneralSettings = {
      ...settings.generalSettings,
      ...patch,
      features: {
        ...settings.generalSettings.features,
        ...patch.features,
      },
    };
    setSettings({ ...settings, generalSettings: nextGeneralSettings });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        generalSettings: nextGeneralSettings,
      });
      const nextSettings = withDefaultGeneralSettings(updated)!;
      applySettings(nextSettings);
      setFileUploadLimitMb(String(bytesToMegabytes(updated.generalSettings.fileUploadMaxBytes)));
      setFileOpenLimitMb(String(bytesToMegabytes(updated.generalSettings.fileOpenMaxBytes)));
      setGatewayGrpcPublicTarget(updated.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(updated.generalSettings.gatewayGrpcLocalIp ?? "");
      setRelayGrantTtlHours(String(updated.generalSettings.relayGrantTtlHours));
      setPublicUrl(updated.generalSettings.publicUrl ?? "");
      setHideExternalBranding(updated.generalSettings.hideExternalBranding ?? false);
      setPkiEnabled(nextSettings.generalSettings.features.pkiEnabled);
      setSiemEnabled(nextSettings.generalSettings.features.siemEnabled);
      setInferenceEnabled(nextSettings.generalSettings.features.inferenceEnabled);
      const currentFeatures = useSystemConfigStore.getState().config.features;
      useSystemConfigStore.getState().setConfig(
        withDefaultSystemConfig({
          fileUploadMaxBytes: nextSettings.generalSettings.fileUploadMaxBytes,
          fileOpenMaxBytes: nextSettings.generalSettings.fileOpenMaxBytes,
          relayAutoRecovery: nextSettings.generalSettings.relayAutoRecovery,
          features: {
            ...currentFeatures,
            ...nextSettings.generalSettings.features,
          },
        })
      );
      toast.success("Gateway settings updated");
    } catch (err) {
      setSettings(previous);
      setFileUploadLimitMb(String(bytesToMegabytes(previous.generalSettings.fileUploadMaxBytes)));
      setFileOpenLimitMb(String(bytesToMegabytes(previous.generalSettings.fileOpenMaxBytes)));
      setGatewayGrpcPublicTarget(previous.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(previous.generalSettings.gatewayGrpcLocalIp ?? "");
      setRelayGrantTtlHours(String(previous.generalSettings.relayGrantTtlHours));
      setPublicUrl(previous.generalSettings.publicUrl ?? "");
      setHideExternalBranding(previous.generalSettings.hideExternalBranding ?? false);
      setPkiEnabled(previous.generalSettings.features.pkiEnabled);
      setSiemEnabled(previous.generalSettings.features.siemEnabled);
      setInferenceEnabled(previous.generalSettings.features.inferenceEnabled);
      const capability = patch.features?.pkiEnabled
        ? "Internal PKI"
        : patch.features?.siemEnabled
          ? "SIEM audit export"
          : "Gateway settings";
      if (!handleLicenseApiError(err, capability)) {
        toast.error(err instanceof Error ? err.message : "Failed to update Gateway settings");
      }
    } finally {
      setIsSavingGeneral(false);
    }
  };

  const getDraftFileUploadLimitBytes = () => {
    if (!settings) return;
    const value = Number(fileUploadLimitMb);
    if (!Number.isFinite(value)) return null;
    return Math.round(value) * BYTES_PER_MEGABYTE;
  };

  const getDraftFileOpenLimitBytes = () => {
    if (!settings) return;
    const value = Number(fileOpenLimitMb);
    if (!Number.isFinite(value)) return null;
    return Math.round(value) * BYTES_PER_MEGABYTE;
  };

  const draftFileUploadLimitBytes = getDraftFileUploadLimitBytes();
  const draftFileOpenLimitBytes = getDraftFileOpenLimitBytes();
  const draftGatewayGrpcPublicTarget = gatewayGrpcPublicTarget.trim() || null;
  const draftGatewayGrpcLocalIp = gatewayGrpcLocalIp.trim() || null;
  const draftPublicUrl = publicUrl.trim().replace(/\/$/, "");
  const draftRelayGrantTtlHours = Number(relayGrantTtlHours);
  const generalHasChanges =
    draftPublicUrl !== (settings?.generalSettings.publicUrl ?? "") ||
    hideExternalBranding !== (settings?.generalSettings.hideExternalBranding ?? false) ||
    (draftFileUploadLimitBytes != null &&
      draftFileUploadLimitBytes !== settings?.generalSettings.fileUploadMaxBytes) ||
    (draftFileOpenLimitBytes != null &&
      draftFileOpenLimitBytes !== settings?.generalSettings.fileOpenMaxBytes) ||
    draftGatewayGrpcPublicTarget !== settings?.generalSettings.gatewayGrpcPublicTarget ||
    draftGatewayGrpcLocalIp !== settings?.generalSettings.gatewayGrpcLocalIp ||
    (Number.isInteger(draftRelayGrantTtlHours) &&
      draftRelayGrantTtlHours !== settings?.generalSettings.relayGrantTtlHours) ||
    pkiEnabled !== settings?.generalSettings.features.pkiEnabled ||
    siemEnabled !== settings?.generalSettings.features.siemEnabled ||
    inferenceEnabled !== settings?.generalSettings.features.inferenceEnabled;

  const saveGeneralSettings = async () => {
    if (!settings) return;
    const nextBytes = getDraftFileUploadLimitBytes();
    const nextOpenBytes = getDraftFileOpenLimitBytes();
    if (nextBytes == null) {
      toast.error("File upload limit must be a number");
      return;
    }
    if (nextOpenBytes == null) {
      toast.error("File open limit must be a number");
      return;
    }
    if (nextBytes < BYTES_PER_MEGABYTE || nextBytes > 500 * BYTES_PER_MEGABYTE) {
      toast.error("File upload limit must be between 1 MB and 500 MB");
      return;
    }
    if (nextOpenBytes < BYTES_PER_MEGABYTE || nextOpenBytes > 100 * BYTES_PER_MEGABYTE) {
      toast.error("File open limit must be between 1 MB and 100 MB");
      return;
    }
    if (
      !Number.isInteger(draftRelayGrantTtlHours) ||
      draftRelayGrantTtlHours < 1 ||
      draftRelayGrantTtlHours > 48
    ) {
      toast.error("Relay grant lifetime must be between 1 and 48 hours");
      return;
    }
    if (!/^https?:\/\/[^/]+$/i.test(draftPublicUrl)) {
      toast.error("Public URL must be an HTTP(S) origin without a path");
      return;
    }
    if (
      draftPublicUrl === settings.generalSettings.publicUrl &&
      hideExternalBranding === (settings.generalSettings.hideExternalBranding ?? false) &&
      nextBytes === settings.generalSettings.fileUploadMaxBytes &&
      nextOpenBytes === settings.generalSettings.fileOpenMaxBytes &&
      draftGatewayGrpcPublicTarget === settings.generalSettings.gatewayGrpcPublicTarget &&
      draftGatewayGrpcLocalIp === settings.generalSettings.gatewayGrpcLocalIp &&
      draftRelayGrantTtlHours === settings.generalSettings.relayGrantTtlHours &&
      pkiEnabled === settings.generalSettings.features.pkiEnabled &&
      siemEnabled === settings.generalSettings.features.siemEnabled &&
      inferenceEnabled === settings.generalSettings.features.inferenceEnabled
    ) {
      return;
    }
    if (
      draftRelayGrantTtlHours > 24 &&
      draftRelayGrantTtlHours !== settings.generalSettings.relayGrantTtlHours
    ) {
      const ok = await confirm({
        title: "Use a long relay grant lifetime?",
        description:
          "If Gateway is unavailable, new relay connections may remain authorized for this many hours. Existing tunnels are still controlled by explicit policy revocation.",
        confirmLabel: "Save",
        variant: "default",
      });
      if (!ok) return;
    }
    await updateGeneralSettings({
      publicUrl: draftPublicUrl,
      hideExternalBranding,
      fileUploadMaxBytes: nextBytes,
      fileOpenMaxBytes: nextOpenBytes,
      gatewayGrpcPublicTarget: draftGatewayGrpcPublicTarget,
      gatewayGrpcLocalIp: draftGatewayGrpcLocalIp,
      relayGrantTtlHours: draftRelayGrantTtlHours,
      features: { ...settings.generalSettings.features, pkiEnabled, siemEnabled, inferenceEnabled },
    });
  };

  const saveShutdownSettings = async (
    shutdown: AuthProvisioningSettings["generalSettings"]["shutdown"]
  ) => {
    const updated = await api.updateAuthProvisioningSettings({
      generalSettings: { shutdown },
    });
    const normalized = withDefaultGeneralSettings(updated)!;
    applySettings(normalized);
    return normalized.generalSettings.shutdown;
  };

  const handleToggleMcpServer = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingMcp(true);
    const previous = settings;
    setSettings({ ...settings, mcpServerEnabled: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({ mcpServerEnabled: checked });
      applySettings(updated);
      toast.success("MCP server setting updated");
    } catch (err) {
      setSettings(previous);
      toast.error(err instanceof Error ? err.message : "Failed to update MCP server setting");
    } finally {
      setIsSavingMcp(false);
    }
  };

  const handleToggleMcpCompatibility = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingMcpCompatibility(true);
    const previous = settings;
    setSettings({ ...settings, mcpExtendedCompatibility: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        mcpExtendedCompatibility: checked,
      });
      applySettings(updated);
      toast.success("MCP compatibility setting updated");
    } catch (err) {
      setSettings(previous);
      toast.error(err instanceof Error ? err.message : "Failed to update MCP compatibility");
    } finally {
      setIsSavingMcpCompatibility(false);
    }
  };

  const handleToggleOAuthCompatibility = async (checked: boolean) => {
    if (!settings || !canEdit) return;

    if (checked) {
      const ok = await confirm({
        title: "Enable OAuth extended callback compatibility?",
        description:
          "Unverified OAuth clients will be allowed to register external HTTPS callback URLs, and authorization results may be sent to external origins.",
        confirmLabel: "Enable",
        variant: "destructive",
      });
      if (!ok) return;
    }

    setIsSavingOAuthCompatibility(true);
    const previous = settings;
    setSettings({ ...settings, oauthExtendedCallbackCompatibility: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oauthExtendedCallbackCompatibility: checked,
      });
      applySettings(updated);
      toast.success("OAuth compatibility setting updated");
    } catch (err) {
      setSettings(previous);
      toast.error(
        err instanceof Error ? err.message : "Failed to update OAuth compatibility setting"
      );
    } finally {
      setIsSavingOAuthCompatibility(false);
    }
  };

  const handleToggleInference = (checked: boolean) => setInferenceEnabled(checked);

  const updateNetworkSecurity = async (
    patch: Partial<AuthProvisioningSettings["networkSecurity"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingNetwork(true);
    const previous = settings;
    const nextNetworkSecurity = { ...settings.networkSecurity, ...patch };
    setSettings({ ...settings, networkSecurity: nextNetworkSecurity });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        networkSecurity: nextNetworkSecurity,
      });
      applySettings(updated);
      setTrustedProxyCidrs(updated.networkSecurity.trustedProxyCidrs.join(", "));
      toast.success("Network settings updated");
    } catch (err) {
      setSettings(previous);
      setTrustedProxyCidrs(previous.networkSecurity.trustedProxyCidrs.join(", "));
      toast.error(err instanceof Error ? err.message : "Failed to update network settings");
    } finally {
      setIsSavingNetwork(false);
    }
  };

  const saveTrustedProxyCidrs = () => {
    if (!settings) return;
    const cidrs = trustedProxyCidrs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (cidrs.join(",") === settings.networkSecurity.trustedProxyCidrs.join(",")) return;
    updateNetworkSecurity({ trustedProxyCidrs: cidrs });
  };

  const updateOutboundWebhookPolicy = async (
    patch: Partial<AuthProvisioningSettings["outboundWebhookPolicy"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingWebhookPolicy(true);
    const previous = settings;
    const nextPolicy = { ...settings.outboundWebhookPolicy, ...patch };
    setSettings({ ...settings, outboundWebhookPolicy: nextPolicy });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        outboundWebhookPolicy: nextPolicy,
      });
      applySettings(updated);
      setWebhookPrivateCidrs(updated.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      toast.success("Outbound webhook policy updated");
    } catch (err) {
      setSettings(previous);
      setWebhookPrivateCidrs(previous.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      toast.error(err instanceof Error ? err.message : "Failed to update outbound webhook policy");
    } finally {
      setIsSavingWebhookPolicy(false);
    }
  };

  const saveWebhookPrivateCidrs = () => {
    if (!settings) return;
    const cidrs = webhookPrivateCidrs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (cidrs.join(",") === settings.outboundWebhookPolicy.allowedPrivateCidrs.join(",")) return;
    updateOutboundWebhookPolicy({ allowedPrivateCidrs: cidrs });
  };

  const updateLocalAuth = async (
    patch: Parameters<typeof api.updateAuthProvisioningSettings>[0],
    successMessage = "Authentication settings updated"
  ): Promise<boolean> => {
    if (!settings || !canEdit) return false;
    setIsSavingLocalAuth(true);
    try {
      const updated = await api.updateAuthProvisioningSettings(patch);
      applySettings(withDefaultGeneralSettings(updated)!);
      toast.success(successMessage);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update authentication settings");
      return false;
    } finally {
      setIsSavingLocalAuth(false);
    }
  };

  const saveMfaGracePeriod = async () => {
    if (!settings || !canEdit || !mfaHasChanges) return;
    const gracePeriodDays = Number(mfaGracePeriodRaw);
    if (
      mfaGracePeriodRaw.trim() === "" ||
      !Number.isInteger(gracePeriodDays) ||
      gracePeriodDays < 0 ||
      gracePeriodDays > 7
    ) {
      toast.error("MFA grace period must be a whole number between 0 and 7 days");
      return;
    }

    setIsSavingMfaGracePeriod(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        mfaExistingSessionGracePeriodDays: gracePeriodDays,
      });
      const normalizedSettings = withDefaultGeneralSettings(updated)!;
      applySettings(normalizedSettings);
      setMfaGracePeriodDays(normalizedSettings.mfaExistingSessionGracePeriodDays);
      setMfaGracePeriodRaw(String(normalizedSettings.mfaExistingSessionGracePeriodDays));
      setMfaGracePeriodInputKey((key) => key + 1);
      toast.success("MFA grace period updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update MFA grace period");
    } finally {
      setIsSavingMfaGracePeriod(false);
    }
  };

  const saveSmtp = async (testRecipient?: string) => {
    if (!testRecipient && !smtpHasChanges) return;
    const port = Number(smtpDraft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("SMTP port must be between 1 and 65535");
      return;
    }
    if (testRecipient) setIsSendingSmtpTest(true);
    try {
      const saved = await updateLocalAuth(
        {
          smtp: {
            host: smtpDraft.host,
            port,
            tlsMode: smtpDraft.tlsMode,
            username: smtpDraft.username,
            ...(smtpDraft.password ? { password: smtpDraft.password } : {}),
            senderName: smtpDraft.senderName,
            senderEmail: smtpDraft.senderEmail,
            ...(testRecipient ? { testRecipient, testEmailKind: smtpTestEmailKind } : {}),
          },
        },
        testRecipient ? "Test email sent" : "SMTP settings saved"
      );
      if (!saved) return;
      setSmtpDraft((current) => ({ ...current, password: "" }));
      if (testRecipient) {
        setSmtpTestRecipient("");
        setSmtpTestOpen(false);
      }
    } finally {
      if (testRecipient) setIsSendingSmtpTest(false);
    }
  };

  const handleSmtpPresetChange = (presetId: SmtpPresetId) => {
    setSmtpPreset(presetId);
    setSmtpDraft((current) => applySmtpPreset(current, presetId));
  };

  const selectedSmtpPreset = SMTP_PRESETS[smtpPreset];
  const usesProviderPreset = smtpPreset !== "generic";
  const showsSmtpUsername = !usesProviderPreset || smtpPreset === "postmark";
  const smtpUsernameDescription =
    smtpPreset === "resend"
      ? "Resend uses the fixed username resend."
      : smtpPreset === "postmark"
        ? "Use the SMTP access key or Server API token from Postmark."
        : smtpPreset === "sendgrid"
          ? "Twilio SendGrid uses the fixed username apikey."
          : "Username used by your SMTP relay for authentication.";
  const smtpPasswordDescription =
    smtpPreset === "resend"
      ? "Paste a Resend API key."
      : smtpPreset === "postmark"
        ? "Paste the SMTP secret key or Server API token."
        : smtpPreset === "sendgrid"
          ? "Paste a Twilio SendGrid API key."
          : "Password or API key used by your SMTP relay.";

  const oidcHasChanges = Boolean(
    settings &&
      (oidcDraft.issuer.trim() !== (settings.oidc?.issuer ?? "") ||
        oidcDraft.clientId.trim() !== (settings.oidc?.clientId ?? "") ||
        oidcDraft.clientSecret.length > 0 ||
        oidcDraft.redirectUri.trim() !== (settings.oidc?.redirectUri ?? "") ||
        oidcDraft.scopes.trim() !== (settings.oidc?.scopes ?? "openid email profile"))
  );
  const loggingHasChanges = Boolean(
    settings &&
      (loggingDraft.mode !== (settings.logging?.mode ?? "disabled") ||
        (loggingDraft.mode === "external" &&
          (loggingDraft.url.trim() !== (settings.logging?.url ?? "") ||
            loggingDraft.username.trim() !== (settings.logging?.username ?? "") ||
            loggingDraft.password.length > 0 ||
            loggingDraft.database.trim() !== (settings.logging?.database ?? "gateway_logs") ||
            loggingDraft.table.trim() !== (settings.logging?.table ?? "logs") ||
            Number(loggingDraft.requestTimeoutMs) !==
              (settings.logging?.requestTimeoutMs ?? 5000))))
  );
  const mfaGracePeriodIsValid =
    mfaGracePeriodRaw.trim() !== "" &&
    Number.isInteger(Number(mfaGracePeriodRaw)) &&
    Number(mfaGracePeriodRaw) >= 0 &&
    Number(mfaGracePeriodRaw) <= 7;
  const mfaHasChanges = Boolean(
    settings && mfaGracePeriodRaw.trim() !== String(settings.mfaExistingSessionGracePeriodDays)
  );
  const smtpHasChanges = Boolean(
    settings &&
      (smtpDraft.host !== (settings.smtp?.host ?? DEFAULT_SMTP_DRAFT.host) ||
        smtpDraft.port !== String(settings.smtp?.port ?? DEFAULT_SMTP_DRAFT.port) ||
        smtpDraft.tlsMode !== (settings.smtp?.tlsMode ?? DEFAULT_SMTP_DRAFT.tlsMode) ||
        smtpDraft.username !== (settings.smtp?.username ?? DEFAULT_SMTP_DRAFT.username) ||
        smtpDraft.password.length > 0 ||
        smtpDraft.senderName !== (settings.smtp?.senderName ?? DEFAULT_SMTP_DRAFT.senderName) ||
        smtpDraft.senderEmail !== (settings.smtp?.senderEmail ?? DEFAULT_SMTP_DRAFT.senderEmail))
  );

  if (!initialLoadComplete) return <Skeleton />;
  if (!settings) return null;

  return (
    <div className="space-y-4">
      <PanelShell
        hidden={section !== "all" && section !== "general"}
        title="General settings"
        description="Gateway-wide behavior and operational limits"
        actions={
          <Button
            onClick={saveGeneralSettings}
            disabled={!canEdit || isSavingGeneral || !generalHasChanges}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={generalHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow
            title="Public URL"
            description="Canonical browser-facing origin used for redirects and links. It is never inferred from the current browser."
          >
            <Input
              type="url"
              value={publicUrl}
              placeholder="https://gateway.example.com"
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setPublicUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveGeneralSettings();
              }}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Hide external branding"
            description="Hide Wiolett Industries attribution on public status, maintenance, and not-found pages"
          >
            <Switch
              checked={hideExternalBranding}
              disabled={!canEdit || isSavingGeneral}
              ariaLabel="Hide external branding"
              onChange={setHideExternalBranding}
            />
          </SettingsControlRow>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Relay grant lifetime</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Lifetime of newly issued endpoint and connection grants, in hours (1–48)
              </p>
            </div>
            <Input
              className="w-28 shrink-0"
              type="number"
              min={1}
              max={48}
              step={1}
              value={relayGrantTtlHours}
              disabled={!canEdit || isSavingGeneral}
              aria-label="Relay grant lifetime hours"
              onChange={(event) => setRelayGrantTtlHours(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveGeneralSettings();
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Internal HTTPS on port 3000</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Uses a dedicated certificate issued by the existing Gateway System CA. Changing it
                restarts Gateway.
              </p>
            </div>
            <Switch
              checked={settings.webTransport?.tlsEnabled ?? false}
              disabled={!canEdit || isSavingWebTls}
              ariaLabel="Enable internal HTTPS"
              onChange={handleToggleWebTls}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">File upload limit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Maximum file size accepted by Gateway file managers, in MB
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-40"
              type="number"
              min={1}
              max={500}
              step={1}
              value={fileUploadLimitMb}
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setFileUploadLimitMb(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveGeneralSettings();
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">File open limit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Maximum file size opened or copied in the browser, in MB
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-40"
              type="number"
              min={1}
              max={100}
              step={1}
              value={fileOpenLimitMb}
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setFileOpenLimitMb(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveGeneralSettings();
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">gRPC public target</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Public host or IP used in public node enrollment commands
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-80"
              value={gatewayGrpcPublicTarget}
              placeholder="gateway.example.com:9443"
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setGatewayGrpcPublicTarget(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveGeneralSettings();
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">gRPC local IP</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Optional private IP override for local node enrollment commands
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-80"
              value={gatewayGrpcLocalIp}
              placeholder="Uses public target when empty"
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setGatewayGrpcLocalIp(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveGeneralSettings();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                <span>PKI</span>
                {!pkiEntitled && <LicensePlanBadge plan="enterprise" />}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Show PKI navigation and allow user access to authorities, certificates, and PKI
                templates
              </p>
            </div>
            <Switch
              checked={pkiEnabled}
              disabled={!canEdit || isSavingGeneral}
              onChange={(enabled) => {
                if (enabled && !requireLicenseFeature("internal-pki", "Internal PKI")) return;
                setPkiEnabled(enabled);
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                <span>SIEM audit export</span>
                {!siemEntitled && <LicensePlanBadge plan="enterprise" />}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Show SIEM screens and deliver privacy-reduced audit events to configured collectors
              </p>
            </div>
            <Switch
              checked={siemEnabled}
              disabled={!canEdit || isSavingGeneral}
              ariaLabel="Enable SIEM audit export"
              onChange={(enabled) => {
                if (enabled && !requireLicenseFeature("siem-export", "SIEM audit export")) return;
                setSiemEnabled(enabled);
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Inference</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable the inference proxy, user tokens, usage, and provider administration
              </p>
            </div>
            <Switch
              checked={inferenceEnabled}
              disabled={!canEdit || isSavingGeneral}
              ariaLabel="Enable inference"
              onChange={handleToggleInference}
            />
          </div>
        </div>
      </PanelShell>

      <GracefulShutdownSettingsPanel
        hidden={section !== "all" && section !== "features"}
        value={settings.generalSettings.shutdown}
        canEdit={canEdit}
        onSave={saveShutdownSettings}
      />

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="OIDC provider"
        description={
          settings.oidc?.configured
            ? "Client secret is stored encrypted"
            : "Configure the identity provider used for OIDC sign-in"
        }
        actions={
          <Button
            aria-label="Save OIDC provider"
            onClick={saveOidc}
            disabled={!canEdit || isSavingOidc || !oidcHasChanges}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={oidcHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow
            title="Issuer URL"
            description="OpenID Connect issuer used for discovery."
          >
            <Input
              type="url"
              value={oidcDraft.issuer}
              placeholder="https://id.example.com/application/o/gateway/"
              disabled={!canEdit || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, issuer: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Client ID"
            description="OAuth client identifier registered at the provider."
          >
            <Input
              value={oidcDraft.clientId}
              placeholder="gateway"
              disabled={!canEdit || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, clientId: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Client secret"
            description={
              settings.oidc?.clientSecretLast4
                ? `Stored secret ends in ${settings.oidc.clientSecretLast4}`
                : "Required for the initial configuration."
            }
          >
            <Input
              type="password"
              value={oidcDraft.clientSecret}
              placeholder={
                settings.oidc?.configured ? "Leave blank to keep current secret" : "Client secret"
              }
              disabled={!canEdit || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, clientSecret: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Redirect URI"
            description="Must exactly match the callback registered at the provider."
          >
            <Input
              type="url"
              value={oidcDraft.redirectUri}
              placeholder="https://gateway.example.com/auth/callback"
              disabled={!canEdit || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, redirectUri: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Scopes"
            description="Space-separated scopes; openid is required."
          >
            <Input
              value={oidcDraft.scopes}
              disabled={!canEdit || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, scopes: event.target.value }))
              }
            />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "features"}
        title="Structured logging storage"
        description="Keep logging disabled, let Gateway manage a local ClickHouse, or use an external ClickHouse"
        actions={
          <Button
            aria-label="Save structured logging storage"
            onClick={saveLogging}
            disabled={!canEdit || isSavingLogging || !loggingHasChanges}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={loggingHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow
            title="Storage mode"
            description="Disabling managed local storage stops its container but preserves the Docker volume."
          >
            <Select
              value={loggingDraft.mode}
              disabled={!canEdit || isSavingLogging}
              onValueChange={(mode: "disabled" | "local" | "external") => {
                if (
                  mode !== "disabled" &&
                  !requireLicenseFeature("structured-logging", "Structured logging")
                )
                  return;
                setLoggingDraft((current) => ({ ...current, mode }));
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="local">Managed local</SelectItem>
                <SelectItem value="external">External</SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {loggingDraft.mode === "local" && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Gateway uses the mounted Docker socket to run a pinned ClickHouse image on the current
              network.
            </div>
          )}
          {loggingDraft.mode === "external" && (
            <>
              <SettingsControlRow
                title="ClickHouse URL"
                description="HTTP(S) endpoint for the external ClickHouse instance."
              >
                <Input
                  type="url"
                  value={loggingDraft.url}
                  placeholder="https://clickhouse.example.com:8443"
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, url: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Username"
                description="ClickHouse account used by Gateway."
              >
                <Input
                  value={loggingDraft.username}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, username: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Password"
                description={
                  settings.logging?.passwordLast4
                    ? `Stored password ends in ${settings.logging.passwordLast4}`
                    : "Required for the initial external connection."
                }
              >
                <Input
                  type="password"
                  value={loggingDraft.password}
                  placeholder={
                    settings.logging?.passwordLast4
                      ? "Leave blank to keep current password"
                      : "Password"
                  }
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Database"
                description="Database that stores structured Gateway logs."
              >
                <Input
                  value={loggingDraft.database}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, database: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Table"
                description="MergeTree table used for structured logs."
              >
                <Input
                  value={loggingDraft.table}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, table: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Request timeout"
                description="ClickHouse request timeout in milliseconds."
              >
                <Input
                  type="number"
                  min={1}
                  max={120000}
                  value={loggingDraft.requestTimeoutMs}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({
                      ...current,
                      requestTimeoutMs: event.target.value,
                    }))
                  }
                />
              </SettingsControlRow>
            </>
          )}
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Identity provisioning"
        description="OIDC sign-in behavior for Gateway users"
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Auto-create users on OIDC sign-in</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                If disabled, only pre-created users can sign in through OIDC
              </p>
            </div>
            <Switch
              checked={settings.oidcAutoCreateUsers}
              disabled={!canEdit || isSavingAutoCreate}
              onChange={handleToggleAutoCreate}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Require verified OIDC email</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Require email_verified=true for future auto-created users and pre-created user
                claims
              </p>
            </div>
            <Switch
              checked={settings.oidcRequireVerifiedEmail}
              disabled={!canEdit || isSavingVerifiedEmail}
              onChange={handleToggleRequireVerifiedEmail}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">Default group for new OIDC users</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Applied to newly auto-created users after the first real administrator signs in
              </p>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                value={settings.oidcDefaultGroupId}
                disabled={!canEdit || isSavingGroup}
                onValueChange={handleChangeGroup}
              >
                <SelectTrigger>
                  <SelectValue placeholder={selectedGroup?.name ?? "Select group"} />
                </SelectTrigger>
                <SelectContent>
                  {settings.availableGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Sign-in methods"
        description="Enable the primary methods available to Gateway accounts"
      >
        <div className="divide-y divide-border">
          {[
            ["oidc", "OIDC", "Redirect users to the configured identity provider"],
            [
              "password",
              "Email and password",
              "Password setup and recovery links are sent over verified SMTP",
            ],
            ["emailOtp", "Email sign-in code", "A one-time code is sent over verified SMTP"],
            [
              "passkeyLogin",
              "Passkey",
              "Optional local-account passkeys can sign users in directly",
            ],
          ].map(([key, title, description]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch
                checked={settings.methods?.[key as keyof typeof DEFAULT_AUTH_METHODS] ?? false}
                disabled={!canEdit || isSavingLocalAuth}
                onChange={(checked) =>
                  updateLocalAuth({
                    methods: { [key]: checked } as Partial<
                      NonNullable<AuthProvisioningSettings["methods"]>
                    >,
                  })
                }
              />
            </div>
          ))}
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Multi-factor authentication"
        description="Controls how Gateway enforces MFA for local browser sessions"
        actions={
          <Button
            aria-label="Save MFA grace period"
            onClick={saveMfaGracePeriod}
            disabled={
              !canEdit || isSavingMfaGracePeriod || !mfaHasChanges || !mfaGracePeriodIsValid
            }
          >
            {isSavingMfaGracePeriod ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </Button>
        }
        dirty={mfaHasChanges}
      >
        <SettingsControlRow
          title="Existing-session MFA grace period"
          description="Days existing local browser sessions may continue after group MFA is enabled. New sign-ins require MFA immediately. 0 applies immediately."
        >
          <div className="flex w-full items-center gap-2 sm:w-40">
            <NumericInput
              key={mfaGracePeriodInputKey}
              aria-label="Existing-session MFA grace period in days"
              value={mfaGracePeriodDays}
              min={0}
              max={7}
              step={1}
              disabled={!canEdit || isSavingMfaGracePeriod}
              onChange={(value, raw) => {
                setMfaGracePeriodDays(value);
                setMfaGracePeriodRaw(raw);
              }}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </SettingsControlRow>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Authentication email (SMTP)"
        description={
          settings.smtp?.verifiedAt
            ? `Verified ${new Date(settings.smtp.verifiedAt).toLocaleString()}`
            : "Configure and send a test before enabling email-based sign-in"
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setSmtpTestOpen(true)}
              disabled={!canEdit || isSavingLocalAuth}
            >
              Send test
            </Button>
            <Button
              aria-label="Save SMTP settings"
              onClick={() => saveSmtp()}
              disabled={!canEdit || isSavingLocalAuth || !smtpHasChanges}
            >
              {isSavingLocalAuth ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        }
        dirty={smtpHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow title="Email provider" description={selectedSmtpPreset.description}>
            <Select
              value={smtpPreset}
              disabled={!canEdit || isSavingLocalAuth}
              onValueChange={(value) => handleSmtpPresetChange(value as SmtpPresetId)}
            >
              <SelectTrigger aria-label="SMTP provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SMTP_PRESETS).map(([id, preset]) => (
                  <SelectItem key={id} value={id}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {!usesProviderPreset && (
            <>
              <SettingsControlRow
                title="SMTP host"
                description="Hostname of the outgoing mail relay."
              >
                <Input
                  aria-label="SMTP host"
                  value={smtpDraft.host}
                  placeholder="smtp.example.com"
                  disabled={!canEdit || isSavingLocalAuth}
                  onChange={(event) =>
                    setSmtpDraft((current) => ({ ...current, host: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow title="Port" description="TCP port used to connect to the relay.">
                <Input
                  aria-label="SMTP port"
                  value={smtpDraft.port}
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="587"
                  disabled={!canEdit || isSavingLocalAuth}
                  onChange={(event) =>
                    setSmtpDraft((current) => ({ ...current, port: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Transport security"
                description="Use STARTTLS for explicit TLS or TLS for implicit TLS."
              >
                <Select
                  value={smtpDraft.tlsMode}
                  disabled={!canEdit || isSavingLocalAuth}
                  onValueChange={(tlsMode: "starttls" | "tls") =>
                    setSmtpDraft((current) => ({ ...current, tlsMode }))
                  }
                >
                  <SelectTrigger aria-label="SMTP transport security" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starttls">STARTTLS</SelectItem>
                    <SelectItem value="tls">TLS</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </>
          )}
          {showsSmtpUsername && (
            <SettingsControlRow title="SMTP username" description={smtpUsernameDescription}>
              <Input
                aria-label="SMTP username"
                value={smtpDraft.username}
                placeholder="SMTP username"
                disabled={!canEdit || isSavingLocalAuth}
                onChange={(event) =>
                  setSmtpDraft((current) => ({ ...current, username: event.target.value }))
                }
              />
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="SMTP password"
            description={`${smtpPasswordDescription} ${settings.smtp?.configured ? "Leave blank to keep the saved password." : ""}`}
          >
            <Input
              aria-label="SMTP password"
              value={smtpDraft.password}
              type="password"
              placeholder={
                settings.smtp?.configured
                  ? settings.smtp.passwordLast4
                    ? `****${settings.smtp.passwordLast4}`
                    : "Configured — enter new to replace"
                  : "SMTP password or API key"
              }
              disabled={!canEdit || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, password: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Sender name"
            description="Display name recipients see in their inbox."
          >
            <Input
              aria-label="Sender name"
              value={smtpDraft.senderName}
              placeholder="Gateway"
              disabled={!canEdit || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, senderName: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Sender email"
            description="Use an address verified by your email provider."
          >
            <Input
              aria-label="Sender email"
              value={smtpDraft.senderEmail}
              type="email"
              placeholder="security@example.com"
              disabled={!canEdit || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, senderEmail: event.target.value }))
              }
            />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <Dialog open={smtpTestOpen} onOpenChange={setSmtpTestOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send SMTP test</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save the current SMTP configuration and send a test message to this address.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="smtp-test-email-kind">
                Email type
              </label>
              <Select
                value={smtpTestEmailKind}
                disabled={isSavingLocalAuth}
                onValueChange={(value) => setSmtpTestEmailKind(value as SmtpTestEmailKind)}
              >
                <SelectTrigger
                  id="smtp-test-email-kind"
                  aria-label="SMTP test email type"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMTP_TEST_EMAIL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {
                  SMTP_TEST_EMAIL_OPTIONS.find((option) => option.value === smtpTestEmailKind)
                    ?.description
                }
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="smtp-test-recipient">
                Recipient
              </label>
              <Input
                id="smtp-test-recipient"
                aria-label="Test recipient"
                value={smtpTestRecipient}
                type="email"
                placeholder="you@example.com"
                disabled={isSavingLocalAuth}
                onChange={(event) => setSmtpTestRecipient(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSmtpTestOpen(false)}
              disabled={isSavingLocalAuth}
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveSmtp(smtpTestRecipient)}
              disabled={isSavingLocalAuth || isSendingSmtpTest || !smtpTestRecipient}
            >
              {isSendingSmtpTest && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSendingSmtpTest ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PanelShell
        hidden={section !== "all" && section !== "features"}
        title="OAuth and MCP access"
        description="Remote client compatibility and tool access"
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enable MCP server</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Allow MCP-enabled user accounts to access the remote MCP endpoint with OAuth
              </p>
            </div>
            <Switch
              checked={settings.mcpServerEnabled}
              disabled={!canEdit || isSavingMcp}
              onChange={handleToggleMcpServer}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Extended MCP compatibility</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Keep this enabled unless your harness loads every tool into its context at once and
                exhausts it. Turning it off can prevent that harness from using some Gateway tools.
              </p>
            </div>
            <Switch
              ariaLabel="Enable extended MCP compatibility"
              checked={settings.mcpExtendedCompatibility}
              disabled={!canEdit || isSavingMcpCompatibility}
              onChange={handleToggleMcpCompatibility}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">OAuth extended callback compatibility</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Allow unverified OAuth clients to register external HTTPS callback URLs. Leave
                disabled for loopback-only CLI and MCP clients.
              </p>
            </div>
            <Switch
              checked={settings.oauthExtendedCallbackCompatibility}
              disabled={!canEdit || isSavingOAuthCompatibility}
              onChange={handleToggleOAuthCompatibility}
            />
          </div>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Network trust"
        description="Client address detection for rate limits and audit records"
      >
        <div className="divide-y divide-border">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">Client IP source</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Controls which address Gateway uses for rate limits and audit records
              </p>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                value={settings.networkSecurity.clientIpSource}
                disabled={!canEdit || isSavingNetwork}
                onValueChange={(clientIpSource) =>
                  updateNetworkSecurity({
                    clientIpSource:
                      clientIpSource as AuthProvisioningSettings["networkSecurity"]["clientIpSource"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="direct">Direct connection</SelectItem>
                  <SelectItem value="reverse_proxy">Reverse proxy</SelectItem>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            <div className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Resolved IP
              </p>
              <p className="mt-1 font-mono text-sm">
                {settings.currentRequestIp.ipAddress ?? "unknown"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Remote peer
              </p>
              <p className="mt-1 font-mono text-sm">
                {settings.currentRequestIp.remoteAddress ?? "unknown"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Source</p>
              <p className="mt-1 font-mono text-sm">{settings.currentRequestIp.source}</p>
            </div>
          </div>

          {settings.currentRequestIp.warning && (
            <p className="bg-muted/60 px-4 py-3 text-xs text-muted-foreground dark:bg-muted">
              {settings.currentRequestIp.warning}
            </p>
          )}

          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">Trusted proxy CIDRs</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated proxy ranges allowed to provide forwarded client headers. Empty
                trusts all peers in reverse proxy mode.
              </p>
            </div>
            <Input
              className="w-full shrink-0 border-border bg-[#080808] text-foreground placeholder:text-muted-foreground sm:max-w-80"
              value={trustedProxyCidrs}
              disabled={!canEdit || isSavingNetwork}
              placeholder="10.0.0.0/8, 172.16.0.0/12"
              onChange={(event) => {
                skipNextCidrsBlur.current = false;
                setTrustedProxyCidrs(event.target.value);
              }}
              onBlur={() => {
                if (skipNextCidrsBlur.current) {
                  skipNextCidrsBlur.current = false;
                  return;
                }
                saveTrustedProxyCidrs();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  skipNextCidrsBlur.current = true;
                  saveTrustedProxyCidrs();
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Trust Cloudflare headers without edge IP check</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable only when direct origin access is blocked outside Cloudflare
              </p>
            </div>
            <Switch
              checked={settings.networkSecurity.trustCloudflareHeaders}
              disabled={!canEdit || isSavingNetwork}
              onChange={(trustCloudflareHeaders) =>
                updateNetworkSecurity({ trustCloudflareHeaders })
              }
            />
          </div>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Outbound webhook policy"
        description="Private-network delivery rules for notification webhooks"
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Allow private network webhooks</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Notification webhooks may call the private CIDRs below. Local Gateway addresses,
                localhost, link-local, multicast, and metadata endpoints stay blocked.
              </p>
            </div>
            <Switch
              checked={settings.outboundWebhookPolicy.allowPrivateNetworks}
              disabled={!canEdit || isSavingWebhookPolicy}
              onChange={(allowPrivateNetworks) =>
                updateOutboundWebhookPolicy({ allowPrivateNetworks })
              }
            />
          </div>

          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">Allowed private webhook CIDRs</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated private ranges for notification webhook delivery. Defaults allow
                common enterprise networks.
              </p>
            </div>
            <Input
              className="w-full shrink-0 border-border bg-[#080808] text-foreground placeholder:text-muted-foreground sm:max-w-80"
              value={webhookPrivateCidrs}
              disabled={
                !canEdit ||
                isSavingWebhookPolicy ||
                !settings.outboundWebhookPolicy.allowPrivateNetworks
              }
              placeholder="10.0.0.0/8, 172.16.0.0/12"
              onChange={(event) => {
                skipNextWebhookCidrsBlur.current = false;
                setWebhookPrivateCidrs(event.target.value);
              }}
              onBlur={() => {
                if (skipNextWebhookCidrsBlur.current) {
                  skipNextWebhookCidrsBlur.current = false;
                  return;
                }
                saveWebhookPrivateCidrs();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  skipNextWebhookCidrsBlur.current = true;
                  saveWebhookPrivateCidrs();
                }
              }}
            />
          </div>
        </div>
      </PanelShell>
    </div>
  );
}
