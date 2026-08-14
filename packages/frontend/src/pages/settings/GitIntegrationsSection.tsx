import { GitBranch, Github, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
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
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { GitConnector, GitConnectorProvider, GitConnectorRequest } from "@/types/integrations";
import { GitHubDeviceFlow } from "./GitHubDeviceFlow";

const initialForm = (provider: GitConnectorProvider): GitConnectorRequest => ({
  name: provider === "github" ? "GitHub" : "Git",
  baseUrl: provider === "github" ? "https://github.com" : "",
  enabled: true,
  username: "",
  token: "",
  repositoryMode: "single_repository",
  repositoryUrl: "",
});

export function GitIntegrationsSection() {
  return (
    <div className="space-y-6">
      <GitConnectorPanel
        provider="github"
        title="GitHub Integrations"
        description="GitHub OAuth or token connectors for repositories, Actions, variables, webhooks, and packages."
        icon={Github}
      />
      <GitConnectorPanel
        provider="git"
        title="Git Integrations"
        description="Token-based connectors for a single repository or an explicit multi-repository allowlist."
        icon={GitBranch}
      />
    </div>
  );
}

function GitConnectorPanel({
  provider,
  title,
  description,
  icon: Icon,
}: {
  provider: GitConnectorProvider;
  title: string;
  description: string;
  icon: typeof Github;
}) {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canManage = hasScope(`integrations:${provider}:manage`);
  const [connectors, setConnectors] = useState<GitConnector[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => initialForm(provider));
  const [repositoryUrls, setRepositoryUrls] = useState("");
  const [githubOAuthAvailable, setGithubOAuthAvailable] = useState(false);
  const [authMode, setAuthMode] = useState<"oauth" | "token">("token");
  const refresh = useCallback(async () => {
    try {
      setConnectors(await api.listGitConnectors(provider));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to load ${title}`);
    }
  }, [provider, title]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (provider !== "github") return;
    void api
      .getGitHubOAuthAvailability()
      .then(({ available }) => {
        setGithubOAuthAvailable(available);
        setAuthMode(available ? "oauth" : "token");
      })
      .catch(() => setGithubOAuthAvailable(false));
  }, [provider]);
  const create = async () => {
    const urls = repositoryUrls
      .split(/[,\n]/)
      .map((url) => url.trim())
      .filter(Boolean);
    if (
      !form.name.trim() ||
      !form.baseUrl.trim() ||
      !form.token.trim() ||
      !urls.length ||
      (provider === "git" && !form.username?.trim())
    )
      return;
    setSaving(true);
    try {
      await api.createGitConnector(provider, {
        ...form,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        username: form.username?.trim() || undefined,
        token: form.token.trim(),
        repositoryUrl: form.repositoryMode === "single_repository" ? urls[0] : undefined,
        allowlistEntries:
          form.repositoryMode === "multi_repository"
            ? urls.map((url) => ({
                entryType: "project",
                remoteId: url,
                fullPath: url,
                name: url,
                webUrl: url,
              }))
            : undefined,
      });
      setOpen(false);
      setForm(initialForm(provider));
      setAuthMode(provider === "github" && githubOAuthAvailable ? "oauth" : "token");
      setRepositoryUrls("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to create ${title} connector`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <PanelShell
        title={title}
        description={description}
        actions={
          canManage ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Connector
            </Button>
          ) : null
        }
      >
        {connectors.length ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <div key={connector.id} className="flex items-center gap-3 px-4 py-3">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{connector.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{connector.baseUrl}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {connector.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            message={`No ${provider === "github" ? "GitHub" : "Git"} connectors configured.`}
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? () => setOpen(true) : undefined}
            embedded
          />
        )}
      </PanelShell>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add {provider === "github" ? "GitHub" : "Git"} Connector</DialogTitle>
            <DialogDescription>
              {provider === "github" && authMode === "oauth"
                ? "Authorize Gateway with GitHub Device Flow. The code is shown before GitHub opens."
                : "Gateway encrypts the credential and never displays it again."}
            </DialogDescription>
          </DialogHeader>
          <div className="border border-border">
            {provider === "github" ? (
              <SettingsControlRow
                title="Authentication"
                description={
                  githubOAuthAvailable
                    ? "OAuth is recommended; a personal access token remains available."
                    : "OAuth is not configured on this Gateway; use a personal access token."
                }
              >
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant={authMode === "oauth" ? "default" : "outline"}
                    disabled={!githubOAuthAvailable}
                    onClick={() => setAuthMode("oauth")}
                  >
                    {githubOAuthAvailable ? "OAuth" : "OAuth unavailable"}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant={authMode === "token" ? "default" : "outline"}
                    onClick={() => setAuthMode("token")}
                  >
                    Token
                  </Button>
                </div>
              </SettingsControlRow>
            ) : null}
            <SettingsControlRow title="Connector name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Connector name"
              />
            </SettingsControlRow>
            <SettingsControlRow title={provider === "github" ? "GitHub URL" : "Git host URL"}>
              <Input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder={provider === "github" ? "https://github.com" : "https://git.example.com"}
              />
            </SettingsControlRow>
            <SettingsControlRow title="Repository access">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="button"
                  variant={form.repositoryMode === "single_repository" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, repositoryMode: "single_repository" })}
                >
                  One repository
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant={form.repositoryMode === "multi_repository" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, repositoryMode: "multi_repository" })}
                >
                  Repository allowlist
                </Button>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title={form.repositoryMode === "multi_repository" ? "Repositories" : "Repository"}
            >
              <Input
                value={repositoryUrls}
                onChange={(event) => setRepositoryUrls(event.target.value)}
                placeholder={
                  form.repositoryMode === "multi_repository"
                    ? "Repository URLs, separated by commas"
                    : "Repository URL"
                }
              />
            </SettingsControlRow>
            {authMode === "token" ? (
              <>
                <SettingsControlRow
                  title="Username"
                  description={provider === "github" ? "Optional for GitHub tokens" : undefined}
                >
                  <Input
                    value={form.username ?? ""}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    placeholder="Git username"
                  />
                </SettingsControlRow>
                <SettingsControlRow title="Access token">
                  <Input
                    type="password"
                    value={form.token}
                    onChange={(event) => setForm({ ...form, token: event.target.value })}
                    placeholder="Access token"
                  />
                </SettingsControlRow>
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {provider === "github" && authMode === "oauth" ? (
              <GitHubDeviceFlow
                request={{
                  name: form.name.trim(),
                  baseUrl: form.baseUrl.trim(),
                  enabled: form.enabled,
                  repositoryMode: form.repositoryMode,
                  repositoryUrl:
                    form.repositoryMode === "single_repository"
                      ? repositoryUrls.trim()
                      : undefined,
                  allowlistEntries:
                    form.repositoryMode === "multi_repository"
                      ? repositoryUrls
                          .split(/[,\n]/)
                          .map((url) => url.trim())
                          .filter(Boolean)
                          .map((url) => ({
                            entryType: "project" as const,
                            remoteId: url,
                            fullPath: url,
                            name: url,
                            webUrl: url,
                          }))
                      : undefined,
                }}
                disabled={!form.name.trim() || !form.baseUrl.trim() || !repositoryUrls.trim()}
                onCompleted={async () => {
                  setOpen(false);
                  setForm(initialForm(provider));
                  setRepositoryUrls("");
                  await refresh();
                }}
              />
            ) : (
              <Button
                disabled={
                  saving ||
                  !form.name.trim() ||
                  !form.baseUrl.trim() ||
                  !repositoryUrls.trim() ||
                  !form.token.trim() ||
                  (provider === "git" && !form.username?.trim())
                }
                onClick={() => void create()}
              >
                {saving ? "Saving…" : "Save connector"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
