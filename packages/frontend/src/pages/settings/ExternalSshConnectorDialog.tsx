import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/services/api";
import type { ExternalSshConnector, ExternalSshConnectorRequest } from "@/types/integrations";

function initialForm(host = ""): ExternalSshConnectorRequest {
  return {
    name: host ? `SSH ${host}` : "",
    host,
    port: 22,
    username: "root",
    authMethod: "private_key",
    secret: "",
    hostFingerprint: "",
    enabled: true,
  };
}

export function ExternalSshConnectorDialog({
  open,
  initialHost = "",
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  initialHost?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (connector: ExternalSshConnector) => void;
}) {
  const [connectors, setConnectors] = useState<ExternalSshConnector[]>([]);
  const [form, setForm] = useState<ExternalSshConnectorRequest>(() => initialForm(initialHost));
  const [saving, setSaving] = useState(false);
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null);
  const [createdConnector, setCreatedConnector] = useState<ExternalSshConnector | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialForm(initialHost));
    setGeneratedPublicKey(null);
    setCreatedConnector(null);
    void api
      .listExternalSshConnectors()
      .then(setConnectors)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load SSH connectors")
      );
  }, [initialHost, open]);

  const create = async () => {
    if (
      !form.name.trim() ||
      !form.host.trim() ||
      !form.username.trim() ||
      !form.hostFingerprint.trim() ||
      (!form.secret?.trim() && !form.generatePrivateKey)
    ) {
      return;
    }
    setSaving(true);
    try {
      const result = await api.createExternalSshConnector({
        ...form,
        name: form.name.trim(),
        host: form.host.trim(),
        username: form.username.trim(),
        secret: form.secret?.trim() || undefined,
        passphrase: form.passphrase?.trim() || undefined,
        hostFingerprint: form.hostFingerprint.trim(),
      });
      if (result.generatedPublicKey) {
        setCreatedConnector(result.connector);
        setGeneratedPublicKey(result.generatedPublicKey);
        return;
      }
      onCreated(result.connector);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create SSH connector");
    } finally {
      setSaving(false);
    }
  };

  const finishGeneratedKey = () => {
    if (!createdConnector) return;
    onCreated(createdConnector);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        if (!nextOpen && createdConnector) {
          onCreated(createdConnector);
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {generatedPublicKey ? "Install the generated SSH key" : "Add external SSH connector"}
          </DialogTitle>
          <DialogDescription>
            {generatedPublicKey
              ? "Add this public key to the remote account’s authorized_keys file. Gateway retains the matching private key encrypted."
              : "External servers only. Confirm the host fingerprint before saving; Gateway encrypts passwords and private keys."}
          </DialogDescription>
        </DialogHeader>

        {generatedPublicKey ? (
          <code className="block break-all border bg-muted p-3 text-xs">{generatedPublicKey}</code>
        ) : (
          <div className="divide-y border">
            <SettingsControlRow title="Connector name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                autoFocus
              />
            </SettingsControlRow>
            <SettingsControlRow title="External host and port">
              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                <Input
                  value={form.host}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                  placeholder="server.example.com"
                />
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port ?? 22}
                  onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                  aria-label="SSH port"
                />
              </div>
            </SettingsControlRow>
            <SettingsControlRow title="SSH username">
              <Input
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                autoComplete="username"
              />
            </SettingsControlRow>
            <SettingsControlRow title="Authentication">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.authMethod === "password" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, authMethod: "password", generatePrivateKey: false })}
                >
                  Password
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.authMethod === "private_key" && !form.generatePrivateKey ? "default" : "outline"}
                  onClick={() => setForm({ ...form, authMethod: "private_key", generatePrivateKey: false })}
                >
                  Import key
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.generatePrivateKey ? "default" : "outline"}
                  onClick={() =>
                    setForm({ ...form, authMethod: "private_key", generatePrivateKey: true, secret: "" })
                  }
                >
                  Generate key
                </Button>
              </div>
            </SettingsControlRow>
            {!form.generatePrivateKey ? (
              <SettingsControlRow
                title={form.authMethod === "password" ? "Password" : "Private key"}
                description="Stored encrypted and never displayed again."
              >
                {form.authMethod === "private_key" ? (
                  <Textarea
                    value={form.secret}
                    onChange={(event) => setForm({ ...form, secret: event.target.value })}
                    rows={5}
                    autoComplete="off"
                  />
                ) : (
                  <Input
                    type="password"
                    value={form.secret}
                    onChange={(event) => setForm({ ...form, secret: event.target.value })}
                    autoComplete="new-password"
                  />
                )}
              </SettingsControlRow>
            ) : null}
            {form.authMethod === "private_key" && !form.generatePrivateKey ? (
              <SettingsControlRow title="Key passphrase" description="Optional.">
                <Input
                  type="password"
                  value={form.passphrase ?? ""}
                  onChange={(event) => setForm({ ...form, passphrase: event.target.value })}
                  autoComplete="off"
                />
              </SettingsControlRow>
            ) : null}
            <SettingsControlRow
              title="Host fingerprint"
              description="Verify this SHA256 fingerprint out of band before saving."
            >
              <Input
                value={form.hostFingerprint}
                onChange={(event) => setForm({ ...form, hostFingerprint: event.target.value })}
                placeholder="SHA256:…"
              />
            </SettingsControlRow>
            <SettingsControlRow title="Jump server" description="Optional existing SSH connector.">
              <select
                value={form.jumpConnectorId ?? ""}
                onChange={(event) => setForm({ ...form, jumpConnectorId: event.target.value || null })}
                className="h-9 w-full border border-input bg-background px-3 text-sm"
              >
                <option value="">Direct connection</option>
                {connectors.map((connector) => (
                  <option key={connector.id} value={connector.id}>
                    {connector.name}
                  </option>
                ))}
              </select>
            </SettingsControlRow>
          </div>
        )}

        <DialogFooter>
          {generatedPublicKey ? (
            <Button onClick={finishGeneratedKey}>Continue</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void create()} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
                Save connector
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
