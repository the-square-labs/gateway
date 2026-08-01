import { AnimatePresence, motion } from "framer-motion";
import { Code2, Minus, Plus, RotateCcw, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  type ManagedDatabaseLinkDraft,
  ManagedDatabaseLinksSection,
  type ManagedDatabaseLinksSectionHandle,
} from "./ManagedDatabaseLinksSection";
import { type SecretRow, SecretsSection } from "./SecretsSection";

const EMPTY_DATABASE_LINK_DRAFT: ManagedDatabaseLinkDraft = {
  hasChanges: false,
  managedVariableNames: [],
  pendingAdditionVariableNames: [],
  replacementVariableNames: [],
};

export function EnvironmentTab({
  nodeId,
  containerId,
  containerName,
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
  containerName?: string;
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
  const [hasOnlineDatabaseNode, setHasOnlineDatabaseNode] = useState(false);
  const databaseLinksRef = useRef<ManagedDatabaseLinksSectionHandle>(null);
  const [databaseLinkDraft, setDatabaseLinkDraft] =
    useState<ManagedDatabaseLinkDraft>(EMPTY_DATABASE_LINK_DRAFT);

  const scopeSuffix = `${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`;
  const canEdit = hasScope(`docker:containers:environment:${scopeSuffix}`);
  const canManageSecrets = hasScope(`docker:containers:secrets:${scopeSuffix}`);
  const recreatesRunningContainer = containerState === "running";
  const isServiceEnv = !!onSaveServiceEnv;
  const serviceEnvSignature = useMemo(() => JSON.stringify(serviceEnv ?? {}), [serviceEnv]);
  const managedDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.managedVariableNames),
    [databaseLinkDraft.managedVariableNames]
  );
  const pendingDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.pendingAdditionVariableNames),
    [databaseLinkDraft.pendingAdditionVariableNames]
  );
  const replacementDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.replacementVariableNames),
    [databaseLinkDraft.replacementVariableNames]
  );
  const activeManagedDatabaseVariableNames = useMemo(
    () =>
      new Set(
        databaseLinkDraft.managedVariableNames.filter(
          (name) => !pendingDatabaseVariableNames.has(name)
        )
      ),
    [databaseLinkDraft.managedVariableNames, pendingDatabaseVariableNames]
  );

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

  useEffect(() => {
    if (!canEdit || !canManageSecrets || isServiceEnv || !containerName) {
      setHasOnlineDatabaseNode(false);
      return;
    }

    let cancelled = false;
    void api
      .listNodes({ type: "databases", status: "online", limit: 1 })
      .then((result) => {
        if (!cancelled) setHasOnlineDatabaseNode(result.data.some((node) => node.isConnected));
      })
      .catch(() => {
        if (!cancelled) setHasOnlineDatabaseNode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, canManageSecrets, containerName, isServiceEnv]);

  useEffect(() => {
    if (activeManagedDatabaseVariableNames.size === 0) return;
    setSecretRows((current) =>
      current.filter((row) => !activeManagedDatabaseVariableNames.has(row.key.trim()))
    );
  }, [activeManagedDatabaseVariableNames]);

  const existingVariableNames = useMemo(() => {
    const environmentKeys = rawMode
      ? rawText
          .split("\n")
          .map((line) => line.trim().replace(/^export\s+/, ""))
          .map((line) => line.slice(0, line.indexOf("=")).trim())
          .filter(Boolean)
      : envVars.map((entry) => entry.key.trim()).filter(Boolean);
    return [...environmentKeys, ...secretRows.map((row) => row.key.trim()).filter(Boolean)];
  }, [envVars, rawMode, rawText, secretRows]);

  const handleDatabaseLinkDraftChange = useCallback((draft: ManagedDatabaseLinkDraft) => {
    setDatabaseLinkDraft(draft);
  }, []);

  // ── Env handlers ─────────────────────────────────────────────────

  const validateRaw = useCallback(
    (text: string): number[] => {
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
          if (managedDatabaseVariableNames.has(key) && !replacementDatabaseVariableNames.has(key)) {
            errors.add(i + 1);
          }
          const existing = keyLines.get(key) ?? [];
          existing.push(i + 1);
          keyLines.set(key, existing);
        }
      }
      for (const lineNums of keyLines.values()) {
        if (lineNums.length > 1) for (const ln of lineNums) errors.add(ln);
      }
      return Array.from(errors).sort((a, b) => a - b);
    },
    [managedDatabaseVariableNames, replacementDatabaseVariableNames]
  );

  useEffect(() => {
    if (rawMode) setErrorLines(validateRaw(rawText));
  }, [rawMode, rawText, validateRaw]);

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
      : visibleEnvRows.map(({ entry }) => entry);

    const savingDatabaseLinks = databaseLinkDraft.hasChanges;
    const ok = await confirm({
      title: onSaveServiceEnv
        ? "Save Environment"
        : savingDatabaseLinks || recreatesRunningContainer
          ? "Save & Recreate"
          : canEdit
            ? "Save"
            : "Save Secrets",
      description: onSaveServiceEnv
        ? "Environment changes will be saved to the deployment and apply on the next deploy."
        : savingDatabaseLinks
          ? "Managed database links and environment changes will be applied together. The container will be recreated and experience brief downtime. Continue?"
          : canEdit
            ? recreatesRunningContainer
              ? "Updating environment variables will recreate the container. The container will experience brief downtime. Continue?"
              : "Updating environment variables will save the new container configuration. The container will remain stopped. Continue?"
            : "Secret changes will be stored, but without environment permission they will only apply after the container is recreated. Continue?",
      confirmLabel: onSaveServiceEnv
        ? "Save"
        : savingDatabaseLinks || recreatesRunningContainer
          ? "Recreate"
          : "Save",
    });
    if (!ok) return;

    setIsSaving(true);
    onMutationStart?.(savingDatabaseLinks ? "recreating" : "updating");
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
          if (
            !row.key.trim() ||
            !row.dirty ||
            replacementDatabaseVariableNames.has(row.key.trim())
          ) {
            continue;
          }
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

      const newEnv: Record<string, string> = {};
      for (const entry of vars) {
        const key = entry.key.trim();
        if (key && !managedDatabaseVariableNames.has(key)) newEnv[key] = entry.value;
      }

      if (onSaveServiceEnv) {
        await onSaveServiceEnv(newEnv);
        const entries = Object.entries(newEnv).map(([key, value]) => `${key}=${value}`);
        setOriginalEnv(entries);
        setRawText(entries.join("\n"));
        toast.success("Environment updated");
        onMutationEnd?.();
        return;
      }

      if (savingDatabaseLinks) {
        const replaceExistingEnvironment = databaseLinkDraft.replacementVariableNames.length > 0;
        await databaseLinksRef.current?.applyChanges({
          replaceExistingEnvironment,
          targetEnvironment: newEnv,
        });
      } else if (canEdit && hasEnvChanges) {
        const newKeys = new Set(Object.keys(newEnv));
        const removeEnv = originalEnv
          .map((entry) => entry.split("=")[0])
          .filter((key) => !newKeys.has(key));
        await api.updateContainerEnv(
          nodeId,
          containerId,
          newEnv,
          removeEnv.length > 0 ? removeEnv : undefined
        );
      }

      if (canEdit || savingDatabaseLinks) {
        toast.success(
          savingDatabaseLinks || recreatesRunningContainer
            ? "Environment and database links updated — recreating container"
            : "Environment updated"
        );
        invalidate("containers", "tasks");
        // updateContainerEnv recreates the workload asynchronously. Fetching
        // with this component's old container ID races Docker's removal and
        // surfaces a spurious "container inspect" daemon error. The detail
        // page switches to the replacement ID from its recreate event, which
        // re-runs fetchEnv through the containerId dependency.
        void Promise.resolve(onRecreating?.()).catch(() => undefined);
      } else {
        toast.success("Secrets updated — changes will apply on next container recreate");
        onMutationEnd?.();
      }
    } catch (err) {
      onMutationEnd?.();
      toast.error(err instanceof Error ? err.message : "Failed to update environment");
    } finally {
      setIsSaving(false);
    }
  };

  // ── Derived state ────────────────────────────────────────────────

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground">Loading environment...</div>;
  }

  const invalidKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const visibleEnvRows = envVars
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !replacementDatabaseVariableNames.has(entry.key.trim()));
  const rawManagedOnlyErrorLines = new Set<number>();
  const rawActiveManagedErrorLines = new Set<number>();
  if (rawMode) {
    const keyLines = new Map<string, number[]>();
    rawText.split("\n").forEach((line, index) => {
      const stripped = line.trim().replace(/^export\s+/, "");
      const separator = stripped.indexOf("=");
      const key = separator > 0 ? stripped.slice(0, separator).trim() : "";
      if (key && invalidKeyPattern.test(key)) {
        keyLines.set(key, [...(keyLines.get(key) ?? []), index + 1]);
      }
    });
    for (const [key, lines] of keyLines) {
      if (
        managedDatabaseVariableNames.has(key) &&
        !replacementDatabaseVariableNames.has(key) &&
        lines.length === 1
      ) {
        rawManagedOnlyErrorLines.add(lines[0]!);
        if (activeManagedDatabaseVariableNames.has(key)) rawActiveManagedErrorLines.add(lines[0]!);
      }
    }
  }

  // Build a unified key map across both user-editable sections. Managed names
  // are styled as conflicts too, but pending link additions remain saveable so
  // the confirmed save can replace the collided value.
  const allKeyLocations = new Map<string, { envIndices: number[]; secretIndices: number[] }>();
  if (!rawMode) {
    envVars.forEach((entry, index) => {
      const key = entry.key.trim();
      if (!key || replacementDatabaseVariableNames.has(key)) return;
      const location = allKeyLocations.get(key) ?? { envIndices: [], secretIndices: [] };
      location.envIndices.push(index);
      allKeyLocations.set(key, location);
    });
    secretRows.forEach((row, index) => {
      const key = row.key.trim();
      if (!key || replacementDatabaseVariableNames.has(key)) return;
      const location = allKeyLocations.get(key) ?? { envIndices: [], secretIndices: [] };
      location.secretIndices.push(index);
      allKeyLocations.set(key, location);
    });
  }

  const duplicateKeyIndices = new Set<number>();
  const duplicateSecretIndices = new Set<number>();
  const managedEnvCollisionIndices = new Set<number>();
  const managedSecretCollisionIndices = new Set<number>();
  const activeManagedEnvCollisionIndices = new Set<number>();
  const activeManagedSecretCollisionIndices = new Set<number>();

  for (const [, location] of allKeyLocations) {
    if (location.envIndices.length + location.secretIndices.length > 1) {
      for (const index of location.envIndices) duplicateKeyIndices.add(index);
      for (const index of location.secretIndices) duplicateSecretIndices.add(index);
    }
  }
  envVars.forEach((entry, index) => {
    const key = entry.key.trim();
    if (!managedDatabaseVariableNames.has(key) || replacementDatabaseVariableNames.has(key)) return;
    managedEnvCollisionIndices.add(index);
    if (activeManagedDatabaseVariableNames.has(key)) activeManagedEnvCollisionIndices.add(index);
  });
  secretRows.forEach((row, index) => {
    const key = row.key.trim();
    if (!managedDatabaseVariableNames.has(key) || replacementDatabaseVariableNames.has(key)) return;
    managedSecretCollisionIndices.add(index);
    if (activeManagedDatabaseVariableNames.has(key)) activeManagedSecretCollisionIndices.add(index);
    if (key && !invalidKeyPattern.test(key)) duplicateSecretIndices.add(index);
  });

  const hasEnvTableErrors =
    !rawMode &&
    (visibleEnvRows.some(
      ({ entry }) => !entry.key.trim() || !invalidKeyPattern.test(entry.key.trim())
    ) ||
      duplicateKeyIndices.size > 0);
  const hasSecretErrors =
    !rawMode &&
    (secretRows
      .filter((row) => !replacementDatabaseVariableNames.has(row.key.trim()))
      .some((row) => !row.key.trim() || !invalidKeyPattern.test(row.key.trim())) ||
      duplicateSecretIndices.size > 0);
  const hasActiveManagedConflicts = rawMode
    ? rawActiveManagedErrorLines.size > 0
    : activeManagedEnvCollisionIndices.size > 0 || activeManagedSecretCollisionIndices.size > 0;
  const hasRawStructuralErrors = errorLines.some((line) => !rawManagedOnlyErrorLines.has(line));
  const hasErrors = rawMode
    ? hasRawStructuralErrors || hasActiveManagedConflicts
    : hasEnvTableErrors || hasSecretErrors || hasActiveManagedConflicts;

  // Env changes
  const currentEnvStr = rawMode
    ? rawText
    : visibleEnvRows.map(({ entry }) => `${entry.key}=${entry.value}`).join("\n");
  const originalEnvStr = originalEnv
    .filter((entry) => !replacementDatabaseVariableNames.has(entry.split("=")[0]!))
    .join("\n");
  const hasEnvChanges = currentEnvStr !== originalEnvStr;

  // Secret changes
  const hasSecretsChanges =
    deletedSecretIds.size > 0 ||
    secretRows.some((row) => !replacementDatabaseVariableNames.has(row.key.trim()) && row.dirty);
  const hasChanges = hasEnvChanges || hasSecretsChanges;
  const hasCombinedChanges = hasChanges || databaseLinkDraft.hasChanges;

  if (!canEdit && !canManageSecrets) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to access environment variables or secrets.
      </div>
    );
  }

  return (
    <div className={rawMode ? "flex flex-col flex-1 min-h-0" : "pb-6 space-y-4"}>
      {canEdit && canManageSecrets && !isServiceEnv && containerName && hasOnlineDatabaseNode && (
        <ManagedDatabaseLinksSection
          ref={databaseLinksRef}
          nodeId={nodeId}
          targetType="container"
          targetResourceId={containerName}
          containerName={containerName}
          disabled={disabled || isSaving || hasErrors}
          existingVariableNames={existingVariableNames}
          externalHasChanges={hasChanges}
          onDraftChange={handleDatabaseLinkDraftChange}
          onSaveRequested={() => void handleSave()}
        />
      )}

      <div
        className={`${rawMode ? "flex min-h-0 flex-1 flex-col" : "space-y-4"} ${disabled || isSaving ? "pointer-events-none opacity-60" : ""}`}
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
                    className="bg-warning text-black hover:bg-warning/90 disabled:opacity-50"
                    onClick={handleSave}
                    disabled={isSaving || !hasCombinedChanges || hasErrors}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {onSaveServiceEnv
                      ? "Save"
                      : databaseLinkDraft.hasChanges || recreatesRunningContainer
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
                  {visibleEnvRows.length > 0 && (
                    <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-muted text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <div className="px-3 py-2">Key</div>
                      <div className="px-3 py-2 border-l border-border">Value</div>
                    </div>
                  )}
                  <div>
                    {visibleEnvRows.map(({ entry: env, index: idx }) => (
                      <div
                        key={idx}
                        className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
                      >
                        <Input
                          value={env.key}
                          onChange={(e) => updateVar(idx, "key", e.target.value)}
                          className={`h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                            duplicateKeyIndices.has(idx) ||
                            managedEnvCollisionIndices.has(idx) ||
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
                  {visibleEnvRows.length === 0 && (
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
            saveDisabled={isSaving || !hasCombinedChanges || hasErrors}
            isSaving={isSaving}
            secretRows={secretRows}
            setSecretRows={setSecretRows}
            setDeletedSecretIds={setDeletedSecretIds}
            duplicateSecretIndices={
              new Set([...duplicateSecretIndices, ...managedSecretCollisionIndices])
            }
            invalidKeyPattern={invalidKeyPattern}
            hiddenKeys={replacementDatabaseVariableNames}
          />
        )}
      </div>
    </div>
  );
}
