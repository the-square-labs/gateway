import { Check, Cloud, GitBranch, Github, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { FinalizeSetupState, FinalizeSetupStepStatus } from "@/types";
import type { GitConnectorMode, GitConnectorProvider } from "@/types/integrations";
import { GitHubDeviceFlow } from "@/pages/settings/GitHubDeviceFlow";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

export type ConnectorSetupKind = "cloudflare" | "gitlab" | "github" | "git";
type TrackedIntegration = Extract<ConnectorSetupKind, "cloudflare" | "gitlab">;
type OptionalIntegration = Exclude<ConnectorSetupKind, TrackedIntegration>;
type IntegrationScreen =
  | "overview"
  | ConnectorSetupKind
  | "cloudflare_complete"
  | "gitlab_complete"
  | "github_complete"
  | "git_complete";

export interface ConnectorSetupRequest {
  connector: ConnectorSetupKind;
  baseUrl?: string;
  repositoryUrl?: string;
  repositoryMode?: GitConnectorMode;
}

const INTEGRATION_OPTIONS = [
  {
    id: "cloudflare",
    title: "Cloudflare",
    description: "Manage DNS zones and proxied host records.",
    icon: Cloud,
  },
  {
    id: "gitlab",
    title: "GitLab",
    description: "Connect repositories, CI, and container registries.",
    icon: GitBranch,
  },
  {
    id: "github",
    title: "GitHub",
    description: "Connect repositories, Actions, and packages.",
    icon: Github,
  },
  {
    id: "git",
    title: "Git",
    description: "Connect one repository or an explicit repository allowlist.",
    icon: GitBranch,
  },
] as const;

function isTrackedIntegration(connector: ConnectorSetupKind): connector is TrackedIntegration {
  return connector === "cloudflare" || connector === "gitlab";
}

function activeConnector(screen: IntegrationScreen): ConnectorSetupKind | null {
  switch (screen) {
    case "cloudflare":
    case "cloudflare_complete":
      return "cloudflare";
    case "gitlab":
    case "gitlab_complete":
      return "gitlab";
    case "github":
    case "github_complete":
      return "github";
    case "git":
    case "git_complete":
      return "git";
    default:
      return null;
  }
}

function completionScreen(connector: ConnectorSetupKind): IntegrationScreen {
  switch (connector) {
    case "cloudflare":
      return "cloudflare_complete";
    case "gitlab":
      return "gitlab_complete";
    case "github":
      return "github_complete";
    case "git":
      return "git_complete";
  }
}

function connectorLabel(connector: ConnectorSetupKind): string {
  switch (connector) {
    case "cloudflare":
      return "Cloudflare";
    case "gitlab":
      return "GitLab";
    case "github":
      return "GitHub";
    case "git":
      return "Git";
  }
}

function statusLabel(status: FinalizeSetupStepStatus | undefined) {
  if (status === "configured") return "Configured";
  if (status === "skipped") return "Skipped";
  if (status === "pending") return "Not started";
  return "Optional";
}

function repositoryEntries(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function IntegrationsSetupWizard({
  open,
  state,
  onBack,
  onStep,
  directSetup = null,
  onFinished,
}: {
  open: boolean;
  state?: FinalizeSetupState;
  onBack?: () => void;
  onStep?: (step: TrackedIntegration, status: "configured" | "skipped") => Promise<void>;
  /**
   * Opens one concrete connector form without mounting the Finalize Setup
   * checklist. Used by the assistant after the user has selected a path.
   */
  directSetup?: ConnectorSetupRequest | null;
  onFinished?: (status: "configured" | "cancelled") => void;
}) {
  const isDirectSetup = directSetup !== null;
  const [screen, setScreen] = useState<IntegrationScreen>("overview");
  const [cloudflareName, setCloudflareName] = useState("Cloudflare");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [gitlabName, setGitlabName] = useState("GitLab");
  const [gitlabUrl, setGitlabUrl] = useState("https://gitlab.com");
  const [gitlabToken, setGitlabToken] = useState("");
  const [githubName, setGithubName] = useState("GitHub");
  const [githubUrl, setGithubUrl] = useState("https://github.com");
  const [githubRepositoryUrls, setGithubRepositoryUrls] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubOAuthAvailable, setGithubOAuthAvailable] = useState(false);
  const [githubAuthMode, setGithubAuthMode] = useState<"oauth" | "token">("token");
  const [gitName, setGitName] = useState("Git");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRepositoryUrls, setGitRepositoryUrls] = useState("");
  const [gitRepositoryMode, setGitRepositoryMode] = useState<GitConnectorMode>("single_repository");
  const [gitUsername, setGitUsername] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [configuredOptionalConnectors, setConfiguredOptionalConnectors] = useState<
    Set<OptionalIntegration>
  >(new Set());

  useEffect(() => {
    if (!open) return;

    const connector = directSetup?.connector;
    setScreen(connector ?? "overview");
    setCloudflareName("Cloudflare");
    setCloudflareToken("");
    setGitlabName("GitLab");
    setGitlabUrl(directSetup?.baseUrl ?? "https://gitlab.com");
    setGitlabToken("");
    setGithubName("GitHub");
    setGithubUrl(directSetup?.baseUrl ?? "https://github.com");
    setGithubRepositoryUrls(directSetup?.repositoryUrl ?? "");
    setGithubUsername("");
    setGithubToken("");
    setGitName("Git");
    setGitUrl(directSetup?.baseUrl ?? "");
    setGitRepositoryUrls(directSetup?.repositoryUrl ?? "");
    setGitRepositoryMode(directSetup?.repositoryMode ?? "single_repository");
    setGitUsername("");
    setGitToken("");
    setSaving(false);
    setConfiguredOptionalConnectors(new Set());
  }, [
    directSetup?.baseUrl,
    directSetup?.connector,
    directSetup?.repositoryMode,
    directSetup?.repositoryUrl,
    open,
  ]);

  useEffect(() => {
    if (!open || (directSetup?.connector !== "github" && screen !== "github")) return;
    let cancelled = false;
    void api
      .getGitHubOAuthAvailability()
      .then(({ available }) => {
        if (cancelled) return;
        setGithubOAuthAvailable(available);
        setGithubAuthMode(available ? "oauth" : "token");
      })
      .catch(() => {
        if (!cancelled) {
          setGithubOAuthAvailable(false);
          setGithubAuthMode("token");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [directSetup?.connector, open, screen]);

  const updateTrackedStep = async (step: TrackedIntegration, status: "configured" | "skipped") => {
    if (isDirectSetup || !onStep) return;
    await onStep(step, status);
  };

  const saveCloudflare = async () => {
    if (!cloudflareName.trim() || !cloudflareToken.trim()) return;
    setSaving(true);
    try {
      await api.createCloudflareConnector({
        name: cloudflareName.trim(),
        token: cloudflareToken.trim(),
        enabled: true,
      });
      await updateTrackedStep("cloudflare", "configured");
      setScreen(completionScreen("cloudflare"));
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Failed to create Cloudflare integration"
      );
    } finally {
      setSaving(false);
    }
  };

  const saveGitLab = async () => {
    if (!gitlabName.trim() || !gitlabUrl.trim() || !gitlabToken.trim()) return;
    setSaving(true);
    try {
      await api.createGitLabConnector({
        name: gitlabName.trim(),
        baseUrl: gitlabUrl.trim().replace(/\/$/, ""),
        token: gitlabToken.trim(),
        enabled: true,
        allowlistMode: "all_visible",
      });
      await updateTrackedStep("gitlab", "configured");
      setScreen(completionScreen("gitlab"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to create GitLab integration");
    } finally {
      setSaving(false);
    }
  };

  const saveGitConnector = async (provider: GitConnectorProvider) => {
    const isGithub = provider === "github";
    const name = isGithub ? githubName : gitName;
    const baseUrl = isGithub ? githubUrl : gitUrl;
    const token = isGithub ? githubToken : gitToken;
    const username = isGithub ? githubUsername : gitUsername;
    const mode = isGithub ? "single_repository" : gitRepositoryMode;
    const urls = repositoryEntries(isGithub ? githubRepositoryUrls : gitRepositoryUrls);
    if (
      !name.trim() ||
      !baseUrl.trim() ||
      !token.trim() ||
      urls.length === 0 ||
      (!isGithub && !username.trim())
    )
      return;

    setSaving(true);
    try {
      await api.createGitConnector(provider, {
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/$/, ""),
        enabled: true,
        username: username.trim() || undefined,
        token: token.trim(),
        repositoryMode: mode,
        repositoryUrl: mode === "single_repository" ? urls[0] : undefined,
        allowlistEntries:
          mode === "multi_repository"
            ? urls.map((url) => ({
                entryType: "project",
                remoteId: url,
                fullPath: url,
                name: url,
                webUrl: url,
              }))
            : undefined,
      });
      setConfiguredOptionalConnectors((current) => new Set(current).add(provider));
      setScreen(completionScreen(provider));
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : `Failed to create ${connectorLabel(provider)} integration`
      );
    } finally {
      setSaving(false);
    }
  };

  const skipCurrent = async () => {
    if (isDirectSetup) {
      onFinished?.("cancelled");
      return;
    }

    const connector = activeConnector(screen);
    if (connector) {
      if (isTrackedIntegration(connector)) {
        setSaving(true);
        try {
          await updateTrackedStep(connector, "skipped");
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
          return;
        } finally {
          setSaving(false);
        }
      }
      setScreen("overview");
      return;
    }

    const pending = (["cloudflare", "gitlab"] as const).filter(
      (step) => state?.steps[step] === "pending"
    );
    setSaving(true);
    try {
      for (const step of pending) await updateTrackedStep(step, "skipped");
      onBack?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
    } finally {
      setSaving(false);
    }
  };

  const connector = activeConnector(screen);
  const completedIntegration = screen.endsWith("_complete");
  const currentStatus =
    connector && isTrackedIntegration(connector) ? state?.steps[connector] : undefined;
  const directTitle =
    directSetup === null ? null : `Add ${connectorLabel(directSetup.connector)} connector`;
  const directDescription =
    directSetup === null
      ? null
      : "Only this connector is being configured. Credentials are sent to Gateway and stored encrypted; they are never added to the AI conversation.";

  const footer =
    completedIntegration && connector ? (
      <Button
        onClick={() => {
          if (isDirectSetup) onFinished?.("configured");
          else setScreen("overview");
        }}
      >
        <Check /> {isDirectSetup ? "Continue scenario" : "Back to integrations"}
      </Button>
    ) : screen === "cloudflare" ? (
      <Button
        onClick={() => void saveCloudflare()}
        disabled={saving || !cloudflareName.trim() || !cloudflareToken.trim()}
      >
        {saving ? <Loader2 className="animate-spin" /> : <Cloud />}
        Save Cloudflare
      </Button>
    ) : screen === "gitlab" ? (
      <Button
        onClick={() => void saveGitLab()}
        disabled={saving || !gitlabName.trim() || !gitlabUrl.trim() || !gitlabToken.trim()}
      >
        {saving ? <Loader2 className="animate-spin" /> : <GitBranch />}
        Save GitLab
      </Button>
    ) : screen === "github" && githubAuthMode === "oauth" ? (
      <GitHubDeviceFlow
        request={{
          name: githubName.trim(),
          baseUrl: githubUrl.trim(),
          enabled: true,
          repositoryMode: "single_repository",
          repositoryUrl: githubRepositoryUrls.trim(),
        }}
        disabled={!githubName.trim() || !githubUrl.trim() || !githubRepositoryUrls.trim()}
        onCompleted={() => {
          setConfiguredOptionalConnectors((current) => new Set(current).add("github"));
          setScreen(completionScreen("github"));
        }}
      />
    ) : screen === "github" ? (
      <Button
        onClick={() => void saveGitConnector("github")}
        disabled={
          saving ||
          !githubName.trim() ||
          !githubUrl.trim() ||
          !githubRepositoryUrls.trim() ||
          !githubToken.trim()
        }
      >
        {saving ? <Loader2 className="animate-spin" /> : <Github />}
        Save GitHub
      </Button>
    ) : screen === "git" ? (
      <Button
        onClick={() => void saveGitConnector("git")}
        disabled={
          saving ||
          !gitName.trim() ||
          !gitUrl.trim() ||
          !gitRepositoryUrls.trim() ||
          !gitUsername.trim() ||
          !gitToken.trim()
        }
      >
        {saving ? <Loader2 className="animate-spin" /> : <GitBranch />}
        Save Git connector
      </Button>
    ) : null;

  return (
    <FinalizeSetupWizardDialog
      open={open}
      title={directTitle ?? "Connect integrations"}
      description={
        directDescription ?? (
          <>
            <p>
              Integrations let Gateway work with the systems that already surround your
              infrastructure, without requiring you to leave the control plane for routine setup and
              deployment tasks.
            </p>
            <p>
              Cloudflare lets Gateway manage authorized DNS records. GitLab, GitHub, and generic Git
              connectors provide repository access for source, CI, and deployment workflows.
            </p>
            <p>
              Each connection is independent and optional. Grant only the access you need, then
              refine connectors and permissions later in Settings.
            </p>
          </>
        )
      }
      stepKey={screen}
      onClose={isDirectSetup && !completedIntegration ? () => onFinished?.("cancelled") : undefined}
      onBack={
        isDirectSetup
          ? undefined
          : screen === "overview"
            ? onBack
            : completedIntegration
              ? undefined
              : () => setScreen("overview")
      }
      backDisabled={saving}
      onSkip={isDirectSetup || completedIntegration ? undefined : skipCurrent}
      skipDisabled={saving || currentStatus === "configured"}
      footerLeft={
        isDirectSetup && !completedIntegration ? (
          <Button variant="outline" onClick={() => onFinished?.("cancelled")} disabled={saving}>
            Cancel
          </Button>
        ) : undefined
      }
      footer={footer}
    >
      {screen === "cloudflare_complete" ? (
        <FinalizeSetupCompletion
          title="Cloudflare connected"
          continueIn={
            isDirectSetup
              ? "Gateway can now use this Cloudflare connection in the current scenario."
              : "Continue from Settings → Integrations → Cloudflare to limit zones, rotate the token, and manage connector access."
          }
        >
          Gateway can now use the authorized Cloudflare account when you configure eligible DNS
          zones and proxied hosts.
        </FinalizeSetupCompletion>
      ) : screen === "gitlab_complete" ? (
        <FinalizeSetupCompletion
          title="GitLab connected"
          continueIn={
            isDirectSetup
              ? "Gateway can now re-check this scenario's GitLab prerequisite."
              : "Continue from Settings → Integrations → GitLab to choose projects, registries, and synchronization settings."
          }
        >
          Gateway can now discover the repositories, CI projects, and container registries visible
          to this token.
        </FinalizeSetupCompletion>
      ) : screen === "github_complete" ? (
        <FinalizeSetupCompletion
          title="GitHub connected"
          continueIn={
            isDirectSetup
              ? "Gateway can now re-check this scenario's GitHub prerequisite."
              : "Continue from Settings → Integrations → GitHub to manage this connector."
          }
        >
          Gateway can now use the selected GitHub repository for source and deployment workflows.
        </FinalizeSetupCompletion>
      ) : screen === "git_complete" ? (
        <FinalizeSetupCompletion
          title="Git connector connected"
          continueIn={
            isDirectSetup
              ? "Gateway can now re-check this scenario's repository prerequisite."
              : "Continue from Settings → Integrations → Git to manage this connector."
          }
        >
          Gateway can now use the configured repository or allowlist for source workflows.
        </FinalizeSetupCompletion>
      ) : screen === "overview" ? (
        <div className="space-y-3">
          {INTEGRATION_OPTIONS.map(({ id, title, description, icon: Icon }) => {
            const status = isTrackedIntegration(id) ? state?.steps[id] : undefined;
            const configured =
              status === "configured" ||
              (!isTrackedIntegration(id) && configuredOptionalConnectors.has(id));
            return (
              <Button
                key={id}
                type="button"
                variant="outline"
                className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
                disabled={saving || configured}
                onClick={() => setScreen(id)}
              >
                <span className="flex w-full items-center gap-3">
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium text-foreground">{title}</span>
                    <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                      {description}
                    </span>
                  </span>
                  <Badge
                    className="shrink-0"
                    variant={
                      configured
                        ? "success"
                        : status === "skipped"
                          ? "outline"
                          : status === "pending"
                            ? "secondary"
                            : "outline"
                    }
                  >
                    {configured && <Check className="mr-1 h-3 w-3" />}
                    {configured ? "Configured" : statusLabel(status)}
                  </Badge>
                </span>
              </Button>
            );
          })}
        </div>
      ) : screen === "cloudflare" ? (
        <PanelShell
          title="Cloudflare connector"
          description="Create a connection Gateway can use for authorized DNS zones and proxy-host records."
        >
          <SettingsControlRow
            title="Connector name"
            description="A label for this Cloudflare connection in Gateway."
          >
            <Input
              value={cloudflareName}
              onChange={(event) => setCloudflareName(event.target.value)}
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="API token"
            description="Requires Zone and DNS permissions for the zones Gateway should manage."
          >
            <Input
              type="password"
              value={cloudflareToken}
              onChange={(event) => setCloudflareToken(event.target.value)}
              autoComplete="off"
            />
          </SettingsControlRow>
        </PanelShell>
      ) : screen === "gitlab" ? (
        <PanelShell
          title="GitLab connector"
          description="Connect the GitLab instance Gateway should use for projects, CI, and container registries."
        >
          <SettingsControlRow
            title="Connector name"
            description="A label for this GitLab connection in Gateway."
          >
            <Input
              value={gitlabName}
              onChange={(event) => setGitlabName(event.target.value)}
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="GitLab URL"
            description="The base URL of GitLab Cloud or your self-managed instance."
          >
            <Input
              value={gitlabUrl}
              onChange={(event) => setGitlabUrl(event.target.value)}
              placeholder="https://gitlab.com"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Personal access token"
            description="Gateway initially imports projects visible to this token; refine access later in Settings."
          >
            <Input
              type="password"
              value={gitlabToken}
              onChange={(event) => setGitlabToken(event.target.value)}
              autoComplete="off"
            />
          </SettingsControlRow>
        </PanelShell>
      ) : (
        <PanelShell
          title={screen === "github" ? "GitHub connector" : "Git connector"}
          description={
            screen === "github"
              ? "Connect the GitHub repository this workflow needs."
              : "Connect one repository or an explicit repository allowlist."
          }
        >
          {screen === "github" ? (
            <SettingsControlRow
              title="Authentication"
              description={
                githubOAuthAvailable
                  ? "OAuth is recommended; a personal access token remains available."
                  : "OAuth is not configured on this Gateway; use a personal access token."
              }
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={githubAuthMode === "oauth" ? "default" : "outline"}
                  disabled={!githubOAuthAvailable}
                  onClick={() => setGithubAuthMode("oauth")}
                >
                  {githubOAuthAvailable ? "OAuth" : "OAuth unavailable"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={githubAuthMode === "token" ? "default" : "outline"}
                  onClick={() => setGithubAuthMode("token")}
                >
                  Token
                </Button>
              </div>
            </SettingsControlRow>
          ) : null}
          <SettingsControlRow
            title="Connector name"
            description="A label for this source-control connection in Gateway."
          >
            <Input
              value={screen === "github" ? githubName : gitName}
              onChange={(event) => {
                if (screen === "github") setGithubName(event.target.value);
                else setGitName(event.target.value);
              }}
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title={screen === "github" ? "GitHub URL" : "Git host URL"}
            description={
              screen === "github"
                ? "Use github.com or the base URL of your GitHub Enterprise instance."
                : "The base URL of the Git host that serves this repository."
            }
          >
            <Input
              value={screen === "github" ? githubUrl : gitUrl}
              onChange={(event) => {
                if (screen === "github") setGithubUrl(event.target.value);
                else setGitUrl(event.target.value);
              }}
              placeholder={screen === "github" ? "https://github.com" : "https://git.example.com"}
            />
          </SettingsControlRow>
          {screen === "git" ? (
            <SettingsControlRow
              title="Repository scope"
              description="Choose whether this connector is limited to one repository or an explicit allowlist."
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={gitRepositoryMode === "single_repository" ? "default" : "outline"}
                  onClick={() => setGitRepositoryMode("single_repository")}
                >
                  One repository
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={gitRepositoryMode === "multi_repository" ? "default" : "outline"}
                  onClick={() => setGitRepositoryMode("multi_repository")}
                >
                  Repository allowlist
                </Button>
              </div>
            </SettingsControlRow>
          ) : null}
          <SettingsControlRow
            title={
              screen === "git" && gitRepositoryMode === "multi_repository"
                ? "Repository URLs"
                : "Repository URL"
            }
            description={
              screen === "git" && gitRepositoryMode === "multi_repository"
                ? "Separate allowed repository URLs with commas or new lines."
                : "The repository this connector should make available to Gateway."
            }
          >
            <Input
              value={screen === "github" ? githubRepositoryUrls : gitRepositoryUrls}
              onChange={(event) => {
                if (screen === "github") setGithubRepositoryUrls(event.target.value);
                else setGitRepositoryUrls(event.target.value);
              }}
              placeholder={
                screen === "git" && gitRepositoryMode === "multi_repository"
                  ? "https://git.example.com/team/api, https://git.example.com/team/web"
                  : "https://github.com/organization/repository"
              }
            />
          </SettingsControlRow>
          {screen === "git" || githubAuthMode === "token" ? (
            <>
              <SettingsControlRow
                title="Username"
                description={screen === "github" ? "Optional for GitHub tokens." : undefined}
              >
                <Input
                  value={screen === "github" ? githubUsername : gitUsername}
                  onChange={(event) => {
                    if (screen === "github") setGithubUsername(event.target.value);
                    else setGitUsername(event.target.value);
                  }}
                  autoComplete="username"
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Access token"
                description="Gateway encrypts this token and never displays it again."
              >
                <Input
                  type="password"
                  value={screen === "github" ? githubToken : gitToken}
                  onChange={(event) => {
                    if (screen === "github") setGithubToken(event.target.value);
                    else setGitToken(event.target.value);
                  }}
                  autoComplete="off"
                />
              </SettingsControlRow>
            </>
          ) : null}
        </PanelShell>
      )}
    </FinalizeSetupWizardDialog>
  );
}
