import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { InferenceSettings } from "@/types/inference";

const INFERENCE_SETTINGS_CACHE_KEY = "req:/api/inference/settings";
const CLI_COMMAND = "npx -y @wiolett/gateway-inference@latest";

export function InferenceEndpointSettingsPanel({ canManage }: { canManage: boolean }) {
  const cached = api.getCached<InferenceSettings>(
    INFERENCE_SETTINGS_CACHE_KEY,
    Number.POSITIVE_INFINITY
  );
  const [settings, setSettings] = useState<InferenceSettings | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [saving, setSaving] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getInferenceSettings();
      setSettings(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load inference settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleHarnessEndpoints = async (enabled: boolean) => {
    if (!settings || !canManage || saving) return;
    if (
      enabled &&
      !(await confirm({
        title: "Enable unstable harness endpoints?",
        description:
          "Harness APIs are unstable and change frequently. This feature has barely been tested and may stop working at any time. Enable it only if you accept the risk.",
        confirmLabel: "Enable anyway",
        cancelLabel: "Keep disabled",
        variant: "destructive",
      }))
    ) {
      return;
    }

    const previous = settings;
    setSettings({ ...settings, harnessSpecificEndpointsEnabled: enabled });
    setSaving(true);
    try {
      const next = await api.updateInferenceSettings({
        harnessSpecificEndpointsEnabled: enabled,
      });
      setSettings(next);
      toast.success("Inference endpoint settings updated");
    } catch (error) {
      setSettings(previous);
      toast.error(error instanceof Error ? error.message : "Failed to update inference settings");
    } finally {
      setSaving(false);
    }
  };

  const gatewayUrl = window.location.origin;
  const codexSetupCommands = `${CLI_COMMAND} login ${gatewayUrl}\n${CLI_COMMAND} setup codex`;
  const claudeCodeSetupCommands = `${CLI_COMMAND} login ${gatewayUrl}\n${CLI_COMMAND} setup claude-code`;

  return (
    <>
      <PanelShell
        title="Inference settings"
        description="Control which client-facing inference adapters Gateway exposes"
      >
        <SettingsControlRow
          title="Harness-specific endpoints"
          description={
            <>
              Expose <code>/codex/v1</code>, <code>/anthropic/v1</code>, and future harness-specific
              adapters. The base OpenAI-compatible <code>/v1</code> endpoint remains available while
              this is off.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setInstructionsOpen(true)}
              >
                Set up a harness
              </button>
            </>
          }
        >
          <Switch
            checked={settings?.harnessSpecificEndpointsEnabled ?? false}
            disabled={loading || saving || !canManage || !settings}
            ariaLabel="Enable harness-specific endpoints"
            onChange={toggleHarnessEndpoints}
          />
        </SettingsControlRow>
      </PanelShell>

      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Set up an inference harness</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Enable harness-specific endpoints first, then run the companion CLI on the device where
            the harness is installed.
          </DialogDescription>

          <div className="space-y-4">
            <CopyCodeBlock label="Interactive setup" value={CLI_COMMAND} codeClassName="min-h-0" />

            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Codex</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Configures Codex CLI and Desktop through a managed local proxy and Gateway model
                  catalog.
                </p>
              </div>
              <CopyCodeBlock
                label="Direct Codex setup"
                value={codexSetupCommands}
                codeClassName="min-h-0"
              />
              <div className="border border-border p-3">
                <p className="text-sm font-medium">Codex Desktop requires extra setup</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign in to an OpenAI account through Codex’s normal login flow first. Codex
                  Desktop does not show custom model catalogs without that account session. After
                  Gateway setup or login changes, fully quit and reopen Codex so it reloads the
                  catalog.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Claude Code</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Requires Claude Code 2.1.129 or newer and configures its native Anthropic gateway
                  connection.
                </p>
              </div>
              <CopyCodeBlock
                label="Direct Claude Code setup"
                value={claudeCodeSetupCommands}
                codeClassName="min-h-0"
              />
              <div className="border border-border p-3">
                <p className="text-sm font-medium">Claude Code CLI only</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Claude Desktop and the Claude Code VS Code extension use separate configuration
                  surfaces and are not modified automatically.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInstructionsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
