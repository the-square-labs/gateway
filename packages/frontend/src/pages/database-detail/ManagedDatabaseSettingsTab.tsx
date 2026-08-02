import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";

const FORM_ANIMATION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.16 },
};

function minimumMemoryMb(type: DatabaseConnection["type"]) {
  return type === "clickhouse" ? 512 : 128;
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export function ManagedDatabaseSettingsTab({
  database,
  onSaved,
}: {
  database: DatabaseConnection;
  onSaved: () => void;
}) {
  const managed = database.managed!;
  const [name, setName] = useState(database.name);
  const [tags, setTags] = useState(database.tags.join(", "));
  const [cpuCores, setCpuCores] = useState(String(managed.runtimeConfig.cpuCores || 1));
  const [memoryMb, setMemoryMb] = useState(
    String(Math.max(minimumMemoryMb(database.type), managed.runtimeConfig.memoryMb))
  );
  const [swapMb, setSwapMb] = useState(String(Math.max(0, managed.runtimeConfig.swapMb)));
  const [publishTcp, setPublishTcp] = useState(managed.publishedPort !== null);
  const [publishedPort, setPublishedPort] = useState(
    managed.publishedPort == null ? "" : String(managed.publishedPort)
  );
  const [publishedNativePort, setPublishedNativePort] = useState(
    managed.publishedNativePort == null ? "" : String(managed.publishedNativePort)
  );
  const [publishNativeTcp, setPublishNativeTcp] = useState(managed.publishedNativePort !== null);
  const [tlsEnabled, setTlsEnabled] = useState(managed.tlsEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [confirmingRecreate, setConfirmingRecreate] = useState(false);

  useEffect(() => {
    setName(database.name);
    setTags(database.tags.join(", "));
    setCpuCores(String(managed.runtimeConfig.cpuCores || 1));
    setMemoryMb(String(Math.max(minimumMemoryMb(database.type), managed.runtimeConfig.memoryMb)));
    setSwapMb(String(Math.max(0, managed.runtimeConfig.swapMb)));
    setPublishTcp(managed.publishedPort !== null);
    setPublishedPort(managed.publishedPort == null ? "" : String(managed.publishedPort));
    setPublishedNativePort(
      managed.publishedNativePort == null ? "" : String(managed.publishedNativePort)
    );
    setPublishNativeTcp(managed.publishedNativePort !== null);
    setTlsEnabled(managed.tlsEnabled ?? true);
  }, [database.name, database.tags, database.type, managed]);

  const requestedPort = useMemo(() => {
    const value = publishedPort.trim();
    return value ? Number(value) : null;
  }, [publishedPort]);
  const requestedNativePort = useMemo(() => {
    const value = publishedNativePort.trim();
    return value ? Number(value) : null;
  }, [publishedNativePort]);
  const portIsValid =
    !publishTcp ||
    !publishedPort.trim() ||
    (Number.isInteger(requestedPort) &&
      requestedPort != null &&
      requestedPort >= 1 &&
      requestedPort <= 65535);
  const nativePortIsValid =
    database.type !== "clickhouse" ||
    !publishTcp ||
    !publishNativeTcp ||
    !publishedNativePort.trim() ||
    (Number.isInteger(requestedNativePort) &&
      requestedNativePort != null &&
      requestedNativePort >= 1 &&
      requestedNativePort <= 65535);
  const publicationChanged =
    publishTcp !== (managed.publishedPort !== null) ||
    (publishTcp ? requestedPort : null) !== managed.publishedPort ||
    (database.type === "clickhouse" &&
      publishTcp &&
      publishNativeTcp !== (managed.publishedNativePort !== null)) ||
    (publishTcp && database.type === "clickhouse" && publishNativeTcp
      ? requestedNativePort
      : null) !== (managed.publishedNativePort ?? null) ||
    tlsEnabled !== (managed.tlsEnabled ?? true);

  const save = async () => {
    const cpu = Number(cpuCores);
    const memory = Number(memoryMb);
    const swap = Number(swapMb);
    if (
      !name.trim() ||
      cpu <= 0 ||
      !Number.isInteger(memory) ||
      memory < minimumMemoryMb(database.type) ||
      !Number.isInteger(swap) ||
      swap < 0 ||
      !portIsValid ||
      !nativePortIsValid
    ) {
      toast.error("Enter valid managed database settings");
      return;
    }
    if (publicationChanged) {
      setConfirmingRecreate(true);
      const confirmed = await confirm({
        title: "Save & Recreate",
        description:
          "Recreating this database will temporarily take it offline. It usually takes about 15 seconds while the database starts and passes its readiness check. Continue?",
        confirmLabel: "Recreate",
        variant: "default",
      });
      setConfirmingRecreate(false);
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, {
        name: name.trim(),
        tags: parseTags(tags),
        cpuCores: cpu,
        memoryMb: memory,
        swapMb: swap,
        publishTcp,
        publishedPort: publishTcp ? requestedPort : null,
        ...(database.type === "clickhouse"
          ? {
              publishNativeTcp: publishTcp && publishNativeTcp,
              publishedNativePort: publishTcp && publishNativeTcp ? requestedNativePort : null,
            }
          : {}),
        tlsEnabled,
      });
      toast.success(
        publicationChanged
          ? "Database publication updated — container recreated"
          : "Database settings updated"
      );
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update managed database");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatedHeight>
      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="managed-database-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="managed-database-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="managed-database-tags" className="text-sm font-medium">
            Tags
          </label>
          <Input
            id="managed-database-tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="team, red:production, green:analytics"
          />
          <p className="text-xs text-muted-foreground">
            Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple,
            pink, orange, gray.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor="managed-database-cpu" className="text-sm font-medium">
              CPU cores
            </label>
            <Input
              id="managed-database-cpu"
              type="number"
              min={0.1}
              step={0.1}
              value={cpuCores}
              onChange={(event) => setCpuCores(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="managed-database-memory" className="text-sm font-medium">
              Memory, MB
            </label>
            <Input
              id="managed-database-memory"
              type="number"
              min={minimumMemoryMb(database.type)}
              value={memoryMb}
              onChange={(event) => setMemoryMb(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="managed-database-swap" className="text-sm font-medium">
              Swap, MB
            </label>
            <Input
              id="managed-database-swap"
              type="number"
              min={0}
              value={swapMb}
              onChange={(event) => setSwapMb(event.target.value)}
            />
          </div>
        </div>

        <PanelShell
          title="Publish TCP port"
          description="Enables direct network connections in addition to secure managed links."
          headerBorder={publishTcp}
          actions={
            <Switch
              checked={publishTcp}
              onChange={(checked) => {
                setPublishTcp(checked);
                if (!checked) setPublishNativeTcp(false);
              }}
              disabled={saving || confirmingRecreate || managed.status === "paused"}
              ariaLabel="Publish TCP port"
            />
          }
        >
          <AnimatePresence initial={false} mode="popLayout">
            {publishTcp && (
              <motion.div key="published-tcp-port" {...FORM_ANIMATION}>
                <SettingsControlRow
                  title="Published TCP port"
                  description="Leave empty to let Docker allocate a free port. Changing publication recreates only the database container; its storage is retained."
                >
                  <Input
                    id="managed-database-published-port"
                    aria-label="Published TCP port"
                    type="number"
                    min={1}
                    max={65535}
                    value={publishedPort}
                    onChange={(event) => setPublishedPort(event.target.value)}
                    placeholder="Automatic"
                    disabled={saving || confirmingRecreate || managed.status === "paused"}
                  />
                </SettingsControlRow>
                {database.type === "clickhouse" && (
                  <>
                    <SettingsControlRow
                      title="Publish native TCP port"
                      description="Expose the ClickHouse native protocol for native clients."
                      controlsClassName="sm:min-w-0"
                    >
                      <Switch
                        checked={publishNativeTcp}
                        onChange={(checked) => {
                          setPublishNativeTcp(checked);
                          if (!checked) setPublishedNativePort("");
                        }}
                        disabled={saving || confirmingRecreate || managed.status === "paused"}
                        ariaLabel="Publish native TCP port"
                      />
                    </SettingsControlRow>
                    {publishNativeTcp && (
                      <SettingsControlRow
                        title="Native TCP port"
                        description="Leave empty to let Docker allocate a free port."
                      >
                        <Input
                          aria-label="Native TCP port"
                          type="number"
                          min={1}
                          max={65535}
                          value={publishedNativePort}
                          onChange={(event) => setPublishedNativePort(event.target.value)}
                          placeholder="Automatic"
                          disabled={saving || confirmingRecreate || managed.status === "paused"}
                        />
                      </SettingsControlRow>
                    )}
                  </>
                )}
                <SettingsControlRow
                  title="TLS"
                  description="Encrypt direct database traffic. Secure managed links always remain encrypted."
                  controlsClassName="sm:min-w-0"
                >
                  <Switch
                    checked={tlsEnabled}
                    onChange={setTlsEnabled}
                    disabled={saving || confirmingRecreate || managed.status === "paused"}
                    ariaLabel="Enable TLS"
                  />
                </SettingsControlRow>
              </motion.div>
            )}
          </AnimatePresence>
        </PanelShell>

        <DialogFooter>
          <Button
            onClick={() => void save()}
            disabled={
              saving ||
              confirmingRecreate ||
              managed.status === "paused" ||
              !portIsValid ||
              !nativePortIsValid
            }
          >
            {saving && <Loader2 className="animate-spin" />}
            {saving
              ? publicationChanged
                ? "Recreating database..."
                : "Saving..."
              : publicationChanged
                ? "Save & Recreate"
                : "Save Changes"}
          </Button>
        </DialogFooter>
      </div>
    </AnimatedHeight>
  );
}
