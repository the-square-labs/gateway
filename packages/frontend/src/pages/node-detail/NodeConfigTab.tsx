import { RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

interface NodeConfigTabProps {
  nodeId: string;
  nodeStatus: string;
  actionLocked?: boolean;
}

/** Parse line numbers from nginx error output */
function parseErrorLines(error: string): number[] {
  const lines: number[] = [];
  for (const match of error.matchAll(/on line (\d+)/gi)) {
    lines.push(Number(match[1]));
  }
  return lines;
}

/** Split nginx error into individual messages */
function splitErrors(error: string): string[] {
  return error
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function NodeConfigTab({ nodeId, nodeStatus, actionLocked = false }: NodeConfigTabProps) {
  const { hasScope } = useAuthStore();
  const canManage = hasScope("nodes:config:edit") || hasScope(`nodes:config:edit:${nodeId}`);

  const [configContent, setConfigContent] = useState("");
  const [originalConfig, setOriginalConfig] = useState("");
  const [loading, setLoading] = useState(true);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorLines, setErrorLines] = useState<number[]>([]);

  useEffect(() => {
    if (nodeStatus !== "online") return;
    const load = async () => {
      setLoading(true);
      try {
        const content = await api.getNodeNginxConfig(nodeId);
        setConfigContent(content);
        setOriginalConfig(content);
      } catch {
        toast.error("Failed to load nginx config");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [nodeId, nodeStatus]);

  const handleTest = useCallback(async (): Promise<boolean> => {
    setIsTesting(true);
    try {
      const result = await api.testNodeNginxConfig(nodeId, configContent);
      if (result.valid) {
        setErrorLines([]);
        toast.success("Configuration test passed");
        return true;
      }
      const err = result.error || "Configuration test failed";
      const msgs = splitErrors(err);
      for (const msg of msgs) toast.error(msg);
      setErrorLines(parseErrorLines(err));
      return false;
    } catch {
      toast.error("Failed to test config");
      return false;
    } finally {
      setIsTesting(false);
    }
  }, [nodeId, configContent]);

  const handleSave = useCallback(async () => {
    // Validate first via test
    const valid = await handleTest();
    if (!valid) return;

    setIsSaving(true);
    try {
      const result = await api.updateNodeNginxConfig(nodeId, configContent);
      if (result.valid) {
        toast.success("Config saved and nginx reloaded");
        setOriginalConfig(configContent);
        setErrorLines([]);
      } else {
        const err = result.error || "Config test failed, changes rolled back";
        const msgs = splitErrors(err);
        for (const msg of msgs) toast.error(msg);
        setErrorLines(parseErrorLines(err));
      }
    } catch {
      toast.error("Failed to save config");
    } finally {
      setIsSaving(false);
    }
  }, [nodeId, configContent, handleTest]);

  if (nodeStatus !== "online") {
    return (
      <div className="flex flex-col items-center gap-2 py-16 border border-border bg-card mt-4">
        <p className="text-muted-foreground">Node is offline — configuration unavailable</p>
      </div>
    );
  }

  const hasChanges = configContent !== originalConfig;

  return (
    <PanelShell
      title="Nginx Config"
      description="Edit and validate the node nginx configuration"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={handleTest}
            disabled={loading || isTesting || actionLocked}
          >
            <RefreshCw className={cn("h-4 w-4", isTesting && "animate-spin")} />
            Validate
          </Button>
          {canManage && (
            <Button
              onClick={handleSave}
              disabled={loading || isSaving || !hasChanges || actionLocked}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          )}
        </div>
      }
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1"
      wrapHeader
    >
      {loading ? (
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 p-4"
          aria-label="Loading nginx configuration"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <CodeEditor
          value={configContent}
          onChange={
            canManage && !actionLocked
              ? (val) => {
                  setConfigContent(val);
                  setErrorLines([]);
                }
              : () => {}
          }
          readOnly={!canManage || actionLocked}
          errorLines={errorLines}
          minHeight="0px"
          bordered={false}
        />
      )}
    </PanelShell>
  );
}
