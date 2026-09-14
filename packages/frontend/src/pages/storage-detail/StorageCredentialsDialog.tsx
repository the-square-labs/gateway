import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/CopyButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";

interface RevealedStorageCredentials {
  accessKey: string;
  secretKey: string;
}

function CredentialField({
  label,
  value,
  sensitive = false,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const showValue = !sensitive || revealed;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex border border-input bg-background">
        <Input
          aria-label={label}
          readOnly
          value={value}
          type={showValue ? "text" : "password"}
          className="border-0 bg-transparent font-mono focus-visible:ring-0"
        />
        {sensitive && (
          <Button
            variant="ghost"
            size="icon"
            className="relative shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
            title={revealed ? `Hide ${label}` : `Show ${label}`}
          >
            <Eye
              className={`absolute h-4 w-4 transition-all duration-200 ${revealed ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
            />
            <EyeOff
              className={`absolute h-4 w-4 transition-all duration-200 ${revealed ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
            />
          </Button>
        )}
        <CopyButton value={value} label={label} className="border-l border-input" />
      </div>
    </div>
  );
}

function aliasNameFor(connectionName: string): string {
  const slug = connectionName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "managed-storage";
}

export function StorageCredentialsDialog({
  managedId,
  endpoint,
  publishedPort,
  connectionName,
  open,
  onOpenChange,
}: {
  managedId: string;
  endpoint: string | null;
  publishedPort: number;
  connectionName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [credentials, setCredentials] = useState<RevealedStorageCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Clear secrets from state as soon as the dialog closes so a stale
      // reopen can never flash a previous cluster's credentials, and a
      // fresh fetch always runs the next time the dialog is opened.
      setCredentials(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .revealManagedObjectStorageCredentials(managedId)
      .then((revealed) => {
        if (cancelled) return;
        setCredentials(revealed);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to reveal credentials";
        setError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, managedId]);

  const resolvedEndpoint = endpoint || `http://<node-host>:${publishedPort}`;
  const aliasName = aliasNameFor(connectionName);
  const mcAliasCommand = credentials
    ? `mc alias set ${aliasName} ${resolvedEndpoint} ${credentials.accessKey} ${credentials.secretKey}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Managed Storage Credentials</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {loading ? (
            <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
              Revealing credentials...
            </div>
          ) : error ? (
            <div className="border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
              {error}
            </div>
          ) : credentials ? (
            <>
              <CredentialField label="S3 Endpoint" value={resolvedEndpoint} />
              <CredentialField label="Access Key" value={credentials.accessKey} />
              <CredentialField label="Secret Key" value={credentials.secretKey} sensitive />
              {mcAliasCommand && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Quick Start (mc CLI)</label>
                  <div className="flex items-start justify-between gap-2 border border-input bg-background p-3">
                    <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                      {mcAliasCommand}
                    </code>
                    <CopyButton
                      value={mcAliasCommand}
                      label="mc alias command"
                      className="shrink-0"
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
              Credentials are hidden.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
