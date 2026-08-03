import { Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import {
  DEFAULT_GATEWAY_FEATURES,
  useSystemConfigStore,
  withDefaultSystemConfig,
} from "@/stores/system-config";
import type { AuthProvisioningSettings } from "@/types";

interface AuthProvisioningSectionProps {
  canEdit: boolean;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_FILE_UPLOAD_MAX_BYTES = 100 * BYTES_PER_MEGABYTE;
const DEFAULT_FILE_OPEN_MAX_BYTES = 10 * BYTES_PER_MEGABYTE;
const DEFAULT_GENERAL_FEATURES = {
  pkiEnabled: DEFAULT_GATEWAY_FEATURES.pkiEnabled,
  domainsEnabled: DEFAULT_GATEWAY_FEATURES.domainsEnabled,
  inferenceEnabled: DEFAULT_GATEWAY_FEATURES.inferenceEnabled,
};
const DEFAULT_GENERAL_SETTINGS = {
  fileUploadMaxBytes: DEFAULT_FILE_UPLOAD_MAX_BYTES,
  fileOpenMaxBytes: DEFAULT_FILE_OPEN_MAX_BYTES,
  gatewayPublicIps: [] as string[],
  gatewayGrpcPublicTarget: null as string | null,
  gatewayGrpcLocalIp: null as string | null,
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
const DEFAULT_OIDC_DRAFT = {
  issuer: "",
  clientId: "gateway",
  clientSecret: "",
  redirectUri: "",
  scopes: "openid email profile",
};

const SMTP_PRESETS = {
  generic: {
    label: "Generic SMTP",
    description: "Configure any standards-compliant SMTP relay manually.",
  },
  resend: {
    label: "Resend",
    description: "smtp.resend.com · STARTTLS · API key as the password",
    host: "smtp.resend.com",
    port: "587",
    tlsMode: "starttls" as const,
    username: "resend",
  },
  postmark: {
    label: "Postmark",
    description: "smtp.postmarkapp.com · STARTTLS · SMTP or Server API token",
    host: "smtp.postmarkapp.com",
    port: "587",
    tlsMode: "starttls" as const,
    username: "",
  },
  sendgrid: {
    label: "Twilio SendGrid",
    description: "smtp.sendgrid.net · STARTTLS · API key as the password",
    host: "smtp.sendgrid.net",
    port: "587",
    tlsMode: "starttls" as const,
    username: "apikey",
  },
} as const;

export type SmtpPresetId = keyof typeof SMTP_PRESETS;
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

export interface SmtpDraft {
  host: string;
  port: string;
  tlsMode: "starttls" | "tls";
  username: string;
  password: string;
  senderName: string;
  senderEmail: string;
}

const DEFAULT_SMTP_DRAFT: SmtpDraft = {
  host: SMTP_PRESETS.resend.host,
  port: SMTP_PRESETS.resend.port,
  tlsMode: SMTP_PRESETS.resend.tlsMode,
  username: SMTP_PRESETS.resend.username,
  password: "",
  senderName: "Gateway",
  senderEmail: "",
};

function getSmtpPresetId(host: string | null | undefined): SmtpPresetId {
  return (Object.entries(SMTP_PRESETS).find(
    ([, preset]) => "host" in preset && preset.host === host
  )?.[0] ?? "generic") as SmtpPresetId;
}

export function applySmtpPreset(draft: SmtpDraft, presetId: SmtpPresetId): SmtpDraft {
  const preset = SMTP_PRESETS[presetId];
  if (!("host" in preset)) return draft;
  return {
    ...draft,
    host: preset.host,
    port: preset.port,
    tlsMode: preset.tlsMode,
    username: preset.username,
  };
}

function bytesToMegabytes(bytes: number) {
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

function withDefaultGeneralSettings(settings: AuthProvisioningSettings | null) {
  if (!settings) return null;
  return {
    ...settings,
    methods: { ...DEFAULT_AUTH_METHODS, ...settings.methods },
    passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, ...settings.passwordPolicy },
    mcpExtendedCompatibility: settings.mcpExtendedCompatibility ?? false,
    generalSettings: {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings.generalSettings,
      features: {
        ...DEFAULT_GENERAL_FEATURES,
        ...settings.generalSettings?.features,
      },
    },
  };
}

export function AuthProvisioningSection({ canEdit }: AuthProvisioningSectionProps) {
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(() =>
    withDefaultGeneralSettings(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning") ?? null
    )
  );
  const [isSavingAutoCreate, setIsSavingAutoCreate] = useState(false);
  const [isSavingVerifiedEmail, setIsSavingVerifiedEmail] = useState(false);
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [isSavingGeneral, setIsSavingGeneral] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [isSavingMcpCompatibility, setIsSavingMcpCompatibility] = useState(false);
  const [isSavingOAuthCompatibility, setIsSavingOAuthCompatibility] = useState(false);
  const [isSavingNetwork, setIsSavingNetwork] = useState(false);
  const [isSavingWebhookPolicy, setIsSavingWebhookPolicy] = useState(false);
  const [isSavingLocalAuth, setIsSavingLocalAuth] = useState(false);
  const [oidcDraft, setOidcDraft] = useState(DEFAULT_OIDC_DRAFT);
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
  const [gatewayPublicIps, setGatewayPublicIps] = useState(
    () =>
      api
        .getCached<AuthProvisioningSettings>("settings:auth-provisioning")
        ?.generalSettings?.gatewayPublicIps.join(", ") ?? ""
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
  const [pkiEnabled, setPkiEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.pkiEnabled ?? DEFAULT_GATEWAY_FEATURES.pkiEnabled
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
      api.setCache("settings:auth-provisioning", settingsData);
      setSettings(withDefaultGeneralSettings(settingsData));
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
        clientId: settingsData.oidc?.clientId ?? "gateway",
        clientSecret: "",
        redirectUri: settingsData.oidc?.redirectUri ?? "",
        scopes: settingsData.oidc?.scopes ?? "openid email profile",
      });
      setTrustedProxyCidrs(settingsData.networkSecurity.trustedProxyCidrs.join(", "));
      setWebhookPrivateCidrs(settingsData.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      setFileUploadLimitMb(
        String(bytesToMegabytes(settingsData.generalSettings.fileUploadMaxBytes))
      );
      setFileOpenLimitMb(String(bytesToMegabytes(settingsData.generalSettings.fileOpenMaxBytes)));
      setGatewayPublicIps(settingsData.generalSettings.gatewayPublicIps.join(", "));
      setGatewayGrpcPublicTarget(settingsData.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(settingsData.generalSettings.gatewayGrpcLocalIp ?? "");
      setPkiEnabled(settingsData.generalSettings.features?.pkiEnabled ?? true);
      setInferenceEnabled(settingsData.generalSettings.features?.inferenceEnabled ?? false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Gateway settings");
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
    api.setCache("settings:auth-provisioning", updated);
    setSettings(updated);
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
      setGatewayPublicIps(updated.generalSettings.gatewayPublicIps.join(", "));
      setGatewayGrpcPublicTarget(updated.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(updated.generalSettings.gatewayGrpcLocalIp ?? "");
      setPkiEnabled(nextSettings.generalSettings.features.pkiEnabled);
      setInferenceEnabled(nextSettings.generalSettings.features.inferenceEnabled);
      const currentFeatures = useSystemConfigStore.getState().config.features;
      useSystemConfigStore.getState().setConfig(
        withDefaultSystemConfig({
          fileUploadMaxBytes: nextSettings.generalSettings.fileUploadMaxBytes,
          fileOpenMaxBytes: nextSettings.generalSettings.fileOpenMaxBytes,
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
      setGatewayPublicIps(previous.generalSettings.gatewayPublicIps.join(", "));
      setGatewayGrpcPublicTarget(previous.generalSettings.gatewayGrpcPublicTarget ?? "");
      setGatewayGrpcLocalIp(previous.generalSettings.gatewayGrpcLocalIp ?? "");
      setPkiEnabled(previous.generalSettings.features.pkiEnabled);
      setInferenceEnabled(previous.generalSettings.features.inferenceEnabled);
      toast.error(err instanceof Error ? err.message : "Failed to update Gateway settings");
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
  const draftGatewayPublicIps = gatewayPublicIps
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const draftGatewayGrpcPublicTarget = gatewayGrpcPublicTarget.trim() || null;
  const draftGatewayGrpcLocalIp = gatewayGrpcLocalIp.trim() || null;
  const generalHasChanges =
    (draftFileUploadLimitBytes != null &&
      draftFileUploadLimitBytes !== settings?.generalSettings.fileUploadMaxBytes) ||
    (draftFileOpenLimitBytes != null &&
      draftFileOpenLimitBytes !== settings?.generalSettings.fileOpenMaxBytes) ||
    draftGatewayPublicIps.join(",") !== settings?.generalSettings.gatewayPublicIps.join(",") ||
    draftGatewayGrpcPublicTarget !== settings?.generalSettings.gatewayGrpcPublicTarget ||
    draftGatewayGrpcLocalIp !== settings?.generalSettings.gatewayGrpcLocalIp ||
    pkiEnabled !== settings?.generalSettings.features.pkiEnabled ||
    inferenceEnabled !== settings?.generalSettings.features.inferenceEnabled;

  const saveGeneralSettings = () => {
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
      nextBytes === settings.generalSettings.fileUploadMaxBytes &&
      nextOpenBytes === settings.generalSettings.fileOpenMaxBytes &&
      draftGatewayPublicIps.join(",") === settings.generalSettings.gatewayPublicIps.join(",") &&
      draftGatewayGrpcPublicTarget === settings.generalSettings.gatewayGrpcPublicTarget &&
      draftGatewayGrpcLocalIp === settings.generalSettings.gatewayGrpcLocalIp &&
      pkiEnabled === settings.generalSettings.features.pkiEnabled &&
      inferenceEnabled === settings.generalSettings.features.inferenceEnabled
    ) {
      return;
    }
    updateGeneralSettings({
      fileUploadMaxBytes: nextBytes,
      fileOpenMaxBytes: nextOpenBytes,
      gatewayPublicIps: draftGatewayPublicIps,
      gatewayGrpcPublicTarget: draftGatewayGrpcPublicTarget,
      gatewayGrpcLocalIp: draftGatewayGrpcLocalIp,
      features: { ...settings.generalSettings.features, pkiEnabled, inferenceEnabled },
    });
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

  const saveSmtp = async (testRecipient?: string) => {
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

  const saveOidc = async () => {
    if (!oidcDraft.issuer || !oidcDraft.clientId || !oidcDraft.redirectUri) {
      toast.error("OIDC issuer, client ID, and redirect URI are required");
      return;
    }
    if (!settings?.oidc?.configured && !oidcDraft.clientSecret) {
      toast.error("OIDC client secret is required for the first configuration");
      return;
    }
    const saved = await updateLocalAuth(
      {
        oidc: {
          issuer: oidcDraft.issuer,
          clientId: oidcDraft.clientId,
          redirectUri: oidcDraft.redirectUri,
          scopes: oidcDraft.scopes,
          ...(oidcDraft.clientSecret ? { clientSecret: oidcDraft.clientSecret } : {}),
        },
      },
      "OIDC configuration saved"
    );
    if (saved) setOidcDraft((current) => ({ ...current, clientSecret: "" }));
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

  if (!settings) return null;

  return (
    <div className="space-y-4">
      <PanelShell
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
              <p className="text-sm font-medium">Gateway public IP(s)</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Public IPv4/IPv6 addresses used for Cloudflare A/AAAA records
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-80"
              value={gatewayPublicIps}
              placeholder="203.0.113.10, 2001:db8::10"
              disabled={!canEdit || isSavingGeneral}
              onChange={(event) => setGatewayPublicIps(event.target.value)}
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
              <p className="text-sm font-medium">PKI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Show PKI navigation and allow user access to authorities, certificates, and PKI
                templates
              </p>
            </div>
            <Switch
              checked={pkiEnabled}
              disabled={!canEdit || isSavingGeneral}
              onChange={setPkiEnabled}
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

      <PanelShell
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
        title="OIDC provider"
        description={settings.oidc?.configured ? "Configured in Gateway settings" : "Configure the identity provider before enabling OIDC"}
        actions={<Button onClick={saveOidc} disabled={!canEdit || isSavingLocalAuth}>Save</Button>}
      >
        <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
          <SettingsControlRow title="Issuer URL" description="OpenID Connect issuer URL.">
            <Input value={oidcDraft.issuer} placeholder="https://id.example.com" disabled={!canEdit || isSavingLocalAuth} onChange={(event) => setOidcDraft((current) => ({ ...current, issuer: event.target.value }))} />
          </SettingsControlRow>
          <SettingsControlRow title="Client ID" description="Client registered with the identity provider.">
            <Input value={oidcDraft.clientId} placeholder="gateway" disabled={!canEdit || isSavingLocalAuth} onChange={(event) => setOidcDraft((current) => ({ ...current, clientId: event.target.value }))} />
          </SettingsControlRow>
          <SettingsControlRow title="Redirect URI" description="Callback URL registered with the identity provider.">
            <Input value={oidcDraft.redirectUri} placeholder="https://gateway.example.com/auth/callback" disabled={!canEdit || isSavingLocalAuth} onChange={(event) => setOidcDraft((current) => ({ ...current, redirectUri: event.target.value }))} />
          </SettingsControlRow>
          <SettingsControlRow title="Client secret" description={settings.oidc?.configured ? "Leave blank to keep the current secret." : "Stored encrypted in Gateway settings."}>
            <Input type="password" value={oidcDraft.clientSecret} placeholder={settings.oidc?.configured ? "Unchanged" : "Client secret"} disabled={!canEdit || isSavingLocalAuth} onChange={(event) => setOidcDraft((current) => ({ ...current, clientSecret: event.target.value }))} />
          </SettingsControlRow>
          <SettingsControlRow title="Scopes" description="Scopes requested during sign-in.">
            <Input value={oidcDraft.scopes} placeholder="openid email profile" disabled={!canEdit || isSavingLocalAuth} onChange={(event) => setOidcDraft((current) => ({ ...current, scopes: event.target.value }))} />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <PanelShell
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
            <Button onClick={() => saveSmtp()} disabled={!canEdit || isSavingLocalAuth}>
              Save
            </Button>
          </div>
        }
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
                Return all OAuth-scoped tools in the initial tool list for clients that cannot
                refresh after discovery. This increases the initial tool catalog size.
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
