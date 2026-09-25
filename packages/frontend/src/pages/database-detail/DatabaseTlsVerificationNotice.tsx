import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";

/** An external TLS connection saved before verification existed, or explicitly opted out. */
export function hasUnverifiedTls(database: DatabaseConnection) {
  return !database.managed && database.tlsEnabled && database.tlsVerifyCertificate === false;
}

export function DatabaseTlsVerificationNotice({
  database,
  canEdit,
  onVerified,
  onOpenSettings,
}: {
  database: DatabaseConnection;
  canEdit: boolean;
  onVerified: (database: DatabaseConnection) => void;
  onOpenSettings: () => void;
}) {
  const [verifying, setVerifying] = useState(false);

  if (!hasUnverifiedTls(database)) return null;

  // The backend tests the connection with verification before saving it, so a
  // certificate that cannot be verified leaves the connection unchanged.
  const enableVerification = async () => {
    setVerifying(true);
    try {
      const updated = await api.updateDatabase(database.id, {
        config: { tlsVerifyCertificate: true },
      });
      toast.success("Certificate verified. Verification is now enabled.");
      onVerified(updated);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The server certificate could not be verified"
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-warning-foreground">
            TLS certificate is not verified
          </p>
          <p className="text-xs text-muted-foreground">
            The connection is encrypted, but Gateway does not check the server identity, so the
            database could be impersonated on the network path.
          </p>
        </div>
      </div>
      {canEdit && (
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={onOpenSettings} disabled={verifying}>
            Add CA certificate
          </Button>
          <Button size="sm" onClick={() => void enableVerification()} disabled={verifying}>
            {verifying ? "Testing..." : "Test and enable verification"}
          </Button>
        </div>
      )}
    </div>
  );
}
