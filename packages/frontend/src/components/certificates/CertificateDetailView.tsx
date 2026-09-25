import { Copy, FileKey } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CertificateDetailViewProps {
  pem: string;
}

export function CertificateDetailView({ pem }: CertificateDetailViewProps) {
  const [showRaw, setShowRaw] = useState(false);

  // Parse basic PEM info (the actual X.509 decoding would be done by a library in production)
  const lines = pem.trim().split("\n");
  const isValidPEM =
    lines[0]?.includes("BEGIN CERTIFICATE") && lines[lines.length - 1]?.includes("END CERTIFICATE");

  // Extract base64 content (between begin/end markers)
  const base64Content = lines.filter((l) => !l.startsWith("-----")).join("");

  // Estimate key size from base64 length
  const derLength = Math.ceil((base64Content.length * 3) / 4);

  return (
    <PanelShell
      icon={<FileKey className="h-4 w-4 text-muted-foreground" />}
      title="X.509 Certificate"
      actions={
        <>
          <Button
            variant={showRaw ? "default" : "outline"}
            size="sm"
            onClick={() => setShowRaw(!showRaw)}
          >
            {showRaw ? "Parsed" : "Raw PEM"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard.writeText(pem);
              toast.success("PEM copied to clipboard");
            }}
          >
            <Copy className="h-4 w-4" />
            Copy
          </Button>
        </>
      }
      bodyClassName="p-4"
    >
      {showRaw ? (
        <pre className="overflow-x-auto bg-muted p-4 text-xs font-mono whitespace-pre-wrap break-all">
          {pem}
        </pre>
      ) : (
        <div className="space-y-4">
          {/* Format indicator */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Format</h3>
            <div className="flex gap-2">
              <Badge variant="secondary">PEM</Badge>
              {isValidPEM && <Badge variant="success">Valid</Badge>}
              <Badge variant="secondary">{derLength} bytes (DER)</Badge>
            </div>
          </div>

          {/* PEM Preview */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">PEM Content</h3>
            <div className="bg-muted p-3 font-mono text-xs overflow-x-auto">
              <p className="text-muted-foreground">{lines[0]}</p>
              <p className="text-foreground">{base64Content.slice(0, 64)}...</p>
              <p className="text-muted-foreground">...({base64Content.length} base64 characters)</p>
              <p className="text-muted-foreground">{lines[lines.length - 1]}</p>
            </div>
          </div>

          {/* Certificate chain indicator */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Certificate Chain</h3>
            <p className="text-sm text-muted-foreground">
              {pem.split("BEGIN CERTIFICATE").length - 1} certificate(s) in chain
            </p>
          </div>
        </div>
      )}
    </PanelShell>
  );
}
