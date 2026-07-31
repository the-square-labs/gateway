import { AnimatePresence, motion } from "framer-motion";
import { Code2, Minus, Plus, RotateCcw, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { DockerSecret } from "@/types";
import { type SecretRow, SecretsSection } from "./SecretsSection";

export function EnvironmentTab({
  nodeId,
  containerId,
  scopeResourceId,
  containerState,
  disabled,
  onMutationStart,
  onMutationEnd,
  onRecreating,
  serviceEnv,
  onSaveServiceEnv,
}: {
  nodeId: string;
  containerId: string;
  scopeResourceId?: string;
  containerState?: string;
  disabled?: boolean;
  onMutationStart?: (transition: "updating" | "recreating") => void;
  onMutationEnd?: () => void;
  onRecreating?: () => void | Promise<void>;
  serviceEnv?: Record<string, string>;
  onSaveServiceEnv?: (env: Record<string, string>) => Promise<void>;
}) {
  const { hasScope } = useAuthStore();
  const invalidate = useDockerStore((s) => s.invalidate);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [originalEnv, setOriginalEnv] = useState<string[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [errorLines, setErrorLines] = useState<number[]>([]);

  // Secrets state — edited locally, flushed to DB on recreate
  const [secretRows, setSecretRows] = useState<SecretRow[]>([]);
  const [deletedSecretIds, setDeletedSecretIds] = useState<Set<string>>(new Set());

  const scopeSuffix = `${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`;
  const canEdit = hasScope(`docker:containers:environment:${scopeSuffix}`);
  const canManageSecrets = hasScope(`docker:containers:secrets:${scopeSuffix}`);
  const recreatesRunningContainer = containerState === "running";
  const isServiceEnv = !!onSaveServiceEnv;
  const serviceEnvSignature = useMemo(() => JSON.stringify(serviceEnv ?? {}), [serviceEnv]);

  const fetchEnv = useCallback(async () => {
    setIsLoading((current) => (isServiceEnv ? current : true));
    try {
      if (isServiceEnv) {
        const secretsData = canManageSecrets
          ? await api.listDockerDeploymentSecrets(nodeId, containerId)
          : [];
        const serviceEnvRecord = JSON.parse(serviceEnvSignature) as Record<string, string>;
        const entries = Object.entries(serviceEnvRecord).map(([key, value]) => `${key}=${value}`);
        const parsed = entries.map((entry) => {
          const idx = entry.indexOf("=");
          return { key: entry.slice(0, idx), value: entry.slice(idx + 1) };
        });
        setEnvVars(parsed);
        setOriginalEnv(entries);
        setRawText(entries.join("\n"));
        setSecretRows(
          (secretsData ?? []).map((s: DockerSecret) => ({
            id: s.id,
            key: s.key,
            value: s.value,
            dirty: false,
          }))
        );
        setDeletedSecretIds(new Set());
        return;
      }

      const [data, secretsData] = await Promise.all([
        canEdit ? api.getContainerEnv(nodeId, containerId) : Promise.resolve([]),
        canManageSecrets ? api.listDockerSecrets(nodeId, containerId) : Promise.resolve([]),
      ]);

      if (canEdit) {
        const parsed = (data ?? []).map((entry: string) => {
          const idx = entry.indexOf("=");
          return idx >= 0
            ? { key: entry.slice(0, idx), value: entry.slice(idx + 1) }
            : { key: entry, value: "" };
        });
        setEnvVars(parsed);
        setOriginalEnv(data ?? []);
        setRawText((data ?? []).join("\n"));
      } else {
        setEnvVars([]);
        setOriginalEnv([]);
        setRawText("");
      }

      if (canManageSecrets) {
        const rows: SecretRow[] = (secretsData ?? []).map((s: DockerSecret) => ({
          id: s.id,
          key: s.key,
          value: s.value,
          dirty: false,
        }));
        setSecretRows(rows);
        setDeletedSecretIds(new Set());
      } else {
        setSecretRows([]);
        setDeletedSecretIds(new Set());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch environment");
    } finally {
      setIsLoading(false);
    }
  }, [canEdit, canManageSecrets, nodeId, containerId, isServiceEnv, serviceEnvSignature]);

  useEffect(() => {
    fetchEnv();
  }, [fetchEnv]);

  // ── Env handlers ─────────────────────────────────────────────────

  const validateRaw = (text: string): number[] => {
    const errors = new Set<number>();
    const lines = text.split("\n");
    const keyLines = new Map<string, number[]>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eqIdx = stripped.indexOf("=");
      if (eqIdx < 1) {
        errors.add(i + 1);
        continue;
      }
      const key = stripped.slice(0, eqIdx);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        errors.add(i + 1);
      } else {
        const existing = keyLines.get(key) ?? [];
        existing.push(i + 1);
        keyLines.set(key, existing);
      }
    }
    for (const lineNums of keyLines.values()) {
      if (lineNums.length > 1) for (const ln of lineNums) errors.add(ln);
    }
    return Array.from(errors).sort((a, b) => a - b);
  };

  const switchToRaw = () => {
    const text = envVars.map((e) => `${e.key}=${e.value}`).join("\n");
    setRawText(text);
    setErrorLines(validateRaw(text));
    setRawMode(true);
  };

  const switchToTable = () => {
    const parsed = rawText
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const idx = line.indexOf("=");
        return idx >= 0
          ? { key: line.slice(0, idx), value: line.slice(idx + 1) }
          : { key: line, value: "" };
      });
    setEnvVars(parsed);
    setRawMode(false);
  };

  const updateVar = (idx: number, field: "key" | "value", val: string) => {
    setEnvVars((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: val };
      return updated;
    });
  };

  const addVar = () => setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  const removeVar = (idx: number) => setEnvVars((prev) => prev.filter((_, i) => i !== idx));

  // ── Save handler ─────────────────────────────────────────────────

  const handleSave = async () => {
    const vars = rawMode
      ? rawText
          .split("\n")
          .filter((l) => l.trim())
          .map((line) => {
            const idx = line.indexOf("=");
            return idx >= 0
              ? { key: line.slice(0, idx), value: line.slice(idx + 1) }
              : { key: line, value: "" };
          })
      : envVars;

    const ok = await confirm({
      title: onSaveServiceEnv
        ? "Save Environment"
        : canEdit
          ? recreatesRunningContainer
            ? "Save & Recreate"
            : "Save"
          : "Save Secrets",
      description: onSaveServiceEnv
        ? "Environment changes will be saved to the deployment and apply on the next deploy."
        : canEdit
          ? recreatesRunningContainer
            ? "Updating environment variables will recreate the container. The container will experience brief downtime. Continue?"
            : "Updating environment variables will save the new container configuration. The container will remain stopped. Continue?"
          : "Secret changes will be stored, but without environment permission they will only apply after the container is recreated. Continue?",
      confirmLabel: onSaveServiceEnv
        ? "Save"
        : canEdit
          ? recreatesRunningContainer
            ? "Recreate"
            : "Save"
          : "Save",
    });
    if (!ok) return;

    setIsSaving(true);
    onMutationStart?.("updating");
    try {
      // 1. Flush secret changes to DB
      if (hasSecretsChanges) {
        // Delete removed secrets
        for (const id of deletedSecretIds) {
          if (onSaveServiceEnv) {
            await api.deleteDockerDeploymentSecret(nodeId, containerId, id);
          } else {
            await api.deleteDockerSecret(nodeId, containerId, id);
          }
        }
        // Create/update secrets
        for (const row of secretRows) {
          if (!row.key.trim() || !row.dirty) continue;
          if (row.id) {
            // Existing secret with new value
            if (onSaveServiceEnv) {
              await api.updateDockerDeploymentSecret(nodeId, containerId, row.id, row.value);
            } else {
              await api.updateDockerSecret(nodeId, containerId, row.id, row.value);
            }
          } else {
            // New secret
            if (onSaveServiceEnv) {
              await api.createDockerDeploymentSecret(
                nodeId,
                containerId,
                row.key.trim(),
                row.value
              );
            } else {
              await api.createDockerSecret(nodeId, containerId, row.key.trim(), row.value);
            }
          }
        }
        const refreshedSecrets = onSaveServiceEnv
          ? await api.listDockerDeploymentSecrets(nodeId, containerId)
          : canManageSecrets
            ? await api.listDockerSecrets(nodeId, containerId)
            : [];
        setSecretRows(
          refreshedSecrets.map((s: DockerSecret) => ({
            id: s.id,
            key: s.key,
            value: s.value,
            dirty: false,
          }))
        );
        setDeletedSecretIds(new Set());
      }

      if (canEdit) {
        // 2. Save env vars (triggers recreate — backend merges secrets into env)
        const newEnv: Record<string, string> = {};
        for (const e of vars) {
          if (e.key.trim()) newEnv[e.key.trim()] = e.value;
        }
        if (onSaveServiceEnv) {
          await onSaveServiceEnv(newEnv);
          const entries = Object.entries(newEnv).map(([key, value]) => `${key}=${value}`);
          setOriginalEnv(entries);
          setRawText(entries.join("\n"));
          toast.success("Environment updated");
          onMutationEnd?.();
          setIsSaving(false);
          return;
        }
        const newKeys = new Set(Object.keys(newEnv));
        const removeEnv = originalEnv
          .map((entry) => entry.split("=")[0])
          .filter((k) => !newKeys.has(k));

        await api.updateContainerEnv(
          nodeId,
          containerId,
          newEnv,
          removeEnv.length > 0 ? removeEnv : undefined
        );
        toast.success(
          recreatesRunningContainer
            ? "Environment updated — recreating container"
            : "Environment updated"
        );
        invalidate("containers", "tasks");
        await Promise.resolve(onRecreating?.());
      } else {
        toast.success("Secrets updated — changes will apply on next container recreate");
        onMutationEnd?.();
      }
      setIsSaving(false);
    } catch (err) {
      onMutationEnd?.();
      toast.error(err instanceof Error ? err.message : "Failed to update environment");
      setIsSaving(false);
    }
  };

  // ── Derived state ────────────────────────────────────────────────

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground">Loading environment...</div>;
  }

  // Build a unified key map across both sections for cross-section duplicate detection
  const invalidKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const allKeyLocations = new Map<string, { envIndices: number[]; secretIndices: number[] }>();
  if (!rawMode) {
    envVars.forEach((e, i) => {
      const k = e.key.trim();
      if (!k) return;
      const entry = allKeyLocations.get(k) ?? { envIndices: [], secretIndices: [] };
      entry.envIndices.push(i);
      allKeyLocations.set(k, entry);
    });
    secretRows.forEach((r, i) => {
      const k = r.key.trim();
      if (!k) return;
      const entry = allKeyLocations.get(k) ?? { envIndices: [], secretIndices: [] };
      entry.secretIndices.push(i);
      allKeyLocations.set(k, entry);
    });
  }

  // Env error indices: duplicate within envs OR cross-duplicate with secrets
  const duplicateKeyIndices = new Set<number>();
  // Secret error indices: duplicate within secrets, cross-duplicate with envs, or invalid key name
  const duplicateSecretIndices = new Set<number>();

  for (const [, loc] of allKeyLocations) {
    const totalOccurrences = loc.envIndices.length + loc.secretIndices.length;
    if (totalOccurrences > 1) {
      for (const i of loc.envIndices) duplicateKeyIndices.add(i);
      for (const i of loc.secretIndices) duplicateSecretIndices.add(i);
    }
  }

  // Secret-specific: invalid key names
  secretRows.forEach((r, i) => {
    const k = r.key.trim();
    if (k && !invalidKeyPattern.test(k)) duplicateSecretIndices.add(i);
  });

  const hasEnvTableErrors =
    !rawMode &&
    (envVars.some((e) => !e.key.trim() || !invalidKeyPattern.test(e.key.trim())) ||
      duplicateKeyIndices.size > 0);
  const hasSecretErrors =
    !rawMode &&
    (secretRows.some((r) => !r.key.trim() || !invalidKeyPattern.test(r.key.trim())) ||
      duplicateSecretIndices.size > 0);
  const hasErrors = rawMode ? errorLines.length > 0 : hasEnvTableErrors || hasSecretErrors;

  // Env changes
  const currentEnvStr = rawMode ? rawText : envVars.map((e) => `${e.key}=${e.value}`).join("\n");
  const originalEnvStr = originalEnv.join("\n");
  const hasEnvChanges = currentEnvStr !== originalEnvStr;

  // Secret changes
  const hasSecretsChanges = deletedSecretIds.size > 0 || secretRows.some((r) => r.dirty);
  const hasChanges = hasEnvChanges || hasSecretsChanges;

  if (!canEdit && !canManageSecrets) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to access environment variables or secrets.
      </div>
    );
  }

  return (
    <div
      className={`${rawMode ? "flex flex-col flex-1 min-h-0" : "pb-6 space-y-4"} ${disabled || isSaving ? "pointer-events-none opacity-60" : ""}`}
    >
      {canEdit && (
        <PanelShell
          title="Environment Variables"
          description={
            onSaveServiceEnv
              ? "Saved to deployment configuration"
              : "Changes will recreate the container"
          }
          className={rawMode ? "flex flex-1 flex-col min-h-0" : undefined}
          bodyClassName={rawMode ? "flex min-h-0 flex-1 flex-col" : undefined}
          actions={
            <>
              {canEdit && !rawMode && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={addVar}
                  title="Add variable"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={rawMode ? switchToTable : switchToRaw}
                title={rawMode ? "Table view" : "Raw view"}
                disabled={hasErrors}
              >
                {rawMode ? <Table2 className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              </Button>
              {canEdit && (
                <Button
                  style={{ backgroundColor: "rgb(234 179 8)", color: "#111" }}
                  className="hover:opacity-90 disabled:opacity-50"
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges || hasErrors}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {onSaveServiceEnv
                    ? "Save"
                    : recreatesRunningContainer
                      ? "Save & Recreate"
                      : "Save"}
                </Button>
              )}
            </>
          }
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {rawMode ? (
              <motion.div
                key="raw"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className="flex-1 min-h-0 flex flex-col"
              >
                <CodeEditor
                  value={rawText}
                  onChange={(val) => {
                    setRawText(val);
                    setErrorLines(validateRaw(val));
                  }}
                  readOnly={!canEdit}
                  language="env"
                  errorLines={errorLines}
                  className="-m-px"
                />
              </motion.div>
            ) : (
              <motion.div
                key="table"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              >
                {envVars.length > 0 && (
                  <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-muted text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <div className="px-3 py-2">Key</div>
                    <div className="px-3 py-2 border-l border-border">Value</div>
                  </div>
                )}
                <div>
                  {envVars.map((env, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
                    >
                      <Input
                        value={env.key}
                        onChange={(e) => updateVar(idx, "key", e.target.value)}
                        className={`h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                          duplicateKeyIndices.has(idx) ||
                          (env.key.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.key.trim()))
                            ? "bg-red-500/15 text-red-400"
                            : ""
                        }`}
                        placeholder="KEY"
                      />
                      <div className="flex items-center border-l border-border">
                        <Input
                          value={env.value}
                          onChange={(e) => updateVar(idx, "value", e.target.value)}
                          className="h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring flex-1 min-w-0"
                          placeholder="value"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 rounded-none border-l border-border"
                          onClick={() => removeVar(idx)}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                {envVars.length === 0 && (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-sm text-muted-foreground">
                      No environment variables.{" "}
                      <button onClick={addVar} className="text-foreground hover:underline">
                        Add one
                      </button>
                    </p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </PanelShell>
      )}

      {/* Secrets section — only in table mode */}
      {!rawMode && canManageSecrets && (
        <SecretsSection
          canManageSecrets={canManageSecrets}
          onSave={!canEdit ? handleSave : undefined}
          saveButtonLabel="Save"
          saveDisabled={isSaving || !hasSecretsChanges || hasErrors}
          isSaving={isSaving}
          secretRows={secretRows}
          setSecretRows={setSecretRows}
          setDeletedSecretIds={setDeletedSecretIds}
          duplicateSecretIndices={duplicateSecretIndices}
          invalidKeyPattern={invalidKeyPattern}
        />
      )}
    </div>
  );
}
