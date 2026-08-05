import { Check, Cloud, GitBranch, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { api } from "@/services/api";
import type { FinalizeSetupState, FinalizeSetupStepStatus } from "@/types";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

type IntegrationScreen =
  | "overview"
  | "cloudflare"
  | "gitlab"
  | "cloudflare_complete"
  | "gitlab_complete";

function statusLabel(status: FinalizeSetupStepStatus) {
  if (status === "configured") return "Configured";
  if (status === "skipped") return "Skipped";
  return "Not started";
}

export function IntegrationsSetupWizard({
  open,
  state,
  onBack,
  onStep,
}: {
  open: boolean;
  state: FinalizeSetupState;
  onBack: () => void;
  onStep: (step: "cloudflare" | "gitlab", status: "configured" | "skipped") => Promise<void>;
}) {
  const [screen, setScreen] = useState<IntegrationScreen>("overview");
  const [cloudflareName, setCloudflareName] = useState("Cloudflare");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [gitlabName, setGitlabName] = useState("GitLab");
  const [gitlabUrl, setGitlabUrl] = useState("https://gitlab.com");
  const [gitlabToken, setGitlabToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScreen("overview");
    setCloudflareToken("");
    setGitlabToken("");
    setSaving(false);
  }, [open]);

  const saveCloudflare = async () => {
    if (!cloudflareName.trim() || !cloudflareToken.trim()) return;
    setSaving(true);
    try {
      await api.createCloudflareConnector({
        name: cloudflareName.trim(),
        token: cloudflareToken.trim(),
        enabled: true,
      });
      await onStep("cloudflare", "configured");
      setScreen("cloudflare_complete");
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
      await onStep("gitlab", "configured");
      setScreen("gitlab_complete");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to create GitLab integration");
    } finally {
      setSaving(false);
    }
  };

  const skipCurrent = async () => {
    if (screen === "cloudflare" || screen === "gitlab") {
      setSaving(true);
      try {
        await onStep(screen, "skipped");
        setScreen("overview");
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
      } finally {
        setSaving(false);
      }
      return;
    }
    const pending = (["cloudflare", "gitlab"] as const).filter(
      (step) => state.steps[step] === "pending"
    );
    setSaving(true);
    try {
      for (const step of pending) await onStep(step, "skipped");
      onBack();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to skip integrations setup");
    } finally {
      setSaving(false);
    }
  };

  const activeIntegration = screen.startsWith("cloudflare")
    ? "cloudflare"
    : screen.startsWith("gitlab")
      ? "gitlab"
      : null;
  const completedIntegration = screen.endsWith("_complete");
  const currentStatus = activeIntegration ? state.steps[activeIntegration] : null;
  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Connect integrations"
      description={
        <>
          <p>
            Integrations let Gateway work with the systems that already surround your
            infrastructure, without requiring you to leave the control plane for routine setup and
            deployment tasks.
          </p>
          <p>
            Cloudflare lets Gateway read the zones you authorize and manage DNS records for proxy
            hosts. GitLab connects repositories, CI, and container registries so workloads can use
            the projects and images your organization already maintains.
          </p>
          <p>
            Each connection is independent and optional. Grant only the access you need, then refine
            zones, projects, registries, and permissions later in Settings. You can continue with
            one integration or neither.
          </p>
        </>
      }
      stepKey={screen}
      onBack={
        screen === "overview"
          ? onBack
          : completedIntegration
            ? undefined
            : () => setScreen("overview")
      }
      backDisabled={saving}
      onSkip={completedIntegration ? undefined : skipCurrent}
      skipDisabled={saving || currentStatus === "configured"}
      footer={
        completedIntegration ? (
          <Button onClick={() => setScreen("overview")}>
            <Check /> Back to integrations
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
        ) : null
      }
    >
      {screen === "cloudflare_complete" ? (
        <FinalizeSetupCompletion
          title="Cloudflare connected"
          continueIn="Continue from Settings → Integrations → Cloudflare to limit zones, rotate the token, and manage connector access."
        >
          Gateway can now use the authorized Cloudflare account when you configure eligible DNS
          zones and proxied hosts.
        </FinalizeSetupCompletion>
      ) : screen === "gitlab_complete" ? (
        <FinalizeSetupCompletion
          title="GitLab connected"
          continueIn="Continue from Settings → Integrations → GitLab to choose projects, registries, and synchronization settings."
        >
          Gateway can now discover the repositories, CI projects, and container registries visible
          to this token.
        </FinalizeSetupCompletion>
      ) : screen === "overview" ? (
        <div className="space-y-3">
          {(
            [
              ["cloudflare", "Cloudflare", "Manage DNS zones and proxied host records.", Cloud],
              [
                "gitlab",
                "GitLab",
                "Connect repositories, CI, and container registries.",
                GitBranch,
              ],
            ] as const
          ).map(([id, title, description, Icon]) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
              disabled={saving || state.steps[id] === "configured"}
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
                    state.steps[id] === "configured"
                      ? "success"
                      : state.steps[id] === "skipped"
                        ? "outline"
                        : "secondary"
                  }
                >
                  {state.steps[id] === "configured" && <Check className="mr-1 h-3 w-3" />}
                  {statusLabel(state.steps[id])}
                </Badge>
              </span>
            </Button>
          ))}
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
      ) : (
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
      )}
    </FinalizeSetupWizardDialog>
  );
}
