import { Copy, Download, MoreVertical, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { CommandPalettePageActions } from "@/components/common/CommandPalettePageActions";
import { DetailRow } from "@/components/common/DetailRow";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { daysUntil, formatDate, formatSerialNumber, hoursUntil } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { Certificate } from "@/types";

export function CertificateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const [cert, setCert] = useState<Certificate | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await api.getCertificate(id);
        setCert(data);
      } catch (_err) {
        toast.error("Failed to load certificate");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [id]);

  useRealtime(id ? "cert.changed" : null, (payload) => {
    const ev = payload as { id?: string };
    if (!id || ev?.id !== id) return;
    api
      .getCertificate(id)
      .then(setCert)
      .catch(() => {
        toast.error("Failed to load certificate");
      });
  });

  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("unspecified");
  const [isRevoking, setIsRevoking] = useState(false);
  const [pkcs12DialogOpen, setPkcs12DialogOpen] = useState(false);
  const [pkcs12Passphrase, setPkcs12Passphrase] = useState("");
  const [downloadingFormat, setDownloadingFormat] = useState<"pem" | "der" | "pkcs12" | null>(null);

  const handleRevoke = async () => {
    if (!cert) return;
    setIsRevoking(true);
    try {
      await api.revokeCertificate(cert.id, revokeReason);
      const updated = await api.getCertificate(cert.id);
      setCert(updated);
      toast.success("Certificate revoked");
      setRevokeDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setIsRevoking(false);
    }
  };

  const handleDownload = async (format: "pem" | "der" | "pkcs12", passphrase?: string) => {
    if (!cert) return;
    if (format === "pkcs12" && !passphrase?.trim()) {
      setPkcs12DialogOpen(true);
      return;
    }
    setDownloadingFormat(format);
    try {
      const blob = await api.exportCertificate(cert.id, format, passphrase);
      const ext = format === "pem" ? "pem" : format === "der" ? "der" : "p12";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cert.commonName}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      if (format === "pkcs12") {
        setPkcs12DialogOpen(false);
        setPkcs12Passphrase("");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download certificate");
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handlePkcs12Download = () => {
    if (downloadingFormat === "pkcs12") return;
    if (!pkcs12Passphrase.trim()) {
      toast.error("Passphrase required for PKCS#12 export");
      return;
    }
    void handleDownload("pkcs12", pkcs12Passphrase);
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!cert) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Certificate not found</p>
      </div>
    );
  }

  const expiryDays = daysUntil(cert.notAfter);
  const canExportCertificate =
    hasScope(`pki:cert:export:${cert.id}`) || hasScope("pki:cert:export");
  const canRevokeCertificate =
    hasScope(`pki:cert:revoke:${cert.id}`) || hasScope("pki:cert:revoke");
  const copySerial = () => {
    void navigator.clipboard.writeText(cert.serialNumber);
    toast.success("Serial number copied");
  };
  const copyPem = () => {
    void navigator.clipboard.writeText(cert.certificatePem || "");
    toast.success("PEM copied to clipboard");
  };

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-6">
        <CommandPalettePageActions
          actions={[
            ...(canExportCertificate
              ? [
                  {
                    id: "certificate:download-pem",
                    label: "Download certificate as PEM",
                    icon: <Download className="h-4 w-4" />,
                    action: () => void handleDownload("pem"),
                  },
                  {
                    id: "certificate:download-der",
                    label: "Download certificate as DER",
                    icon: <Download className="h-4 w-4" />,
                    action: () => void handleDownload("der"),
                  },
                  {
                    id: "certificate:download-pkcs12",
                    label: "Download certificate as PKCS#12",
                    icon: <Download className="h-4 w-4" />,
                    action: () => setPkcs12DialogOpen(true),
                  },
                ]
              : []),
            {
              id: "certificate:copy-serial",
              label: "Copy certificate serial",
              icon: <Copy className="h-4 w-4" />,
              action: copySerial,
            },
            ...(canExportCertificate && cert.certificatePem
              ? [
                  {
                    id: "certificate:copy-pem",
                    label: "Copy certificate PEM",
                    icon: <Copy className="h-4 w-4" />,
                    action: copyPem,
                  },
                ]
              : []),
            ...(canRevokeCertificate && cert.status === "active" && !cert.isSystem
              ? [
                  {
                    id: "certificate:revoke",
                    label: "Revoke certificate",
                    icon: <ShieldOff className="h-4 w-4" />,
                    action: () => setRevokeDialogOpen(true),
                  },
                ]
              : []),
          ]}
        />
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <PageBackButton onClick={() => navigate("/certificates")} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">{cert.commonName}</h1>
                <StatusBadge status={cert.status} size="inline" />
                {cert.isSystem && (
                  <Badge variant="outline" size="inline">
                    System
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {cert.type} certificate &middot; Issuer: {cert.issuerDn || cert.caId}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canExportCertificate && (
                  <>
                    <DropdownMenuItem onClick={() => handleDownload("pem")}>
                      <Download className="h-4 w-4" />
                      Download PEM
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownload("der")}>
                      <Download className="h-4 w-4" />
                      Download DER
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPkcs12DialogOpen(true)}>
                      <Download className="h-4 w-4" />
                      Download PKCS#12
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={copySerial}>
                  <Copy className="h-4 w-4" />
                  Copy Serial Number
                </DropdownMenuItem>
                {canExportCertificate && cert.certificatePem && (
                  <DropdownMenuItem onClick={copyPem}>
                    <Copy className="h-4 w-4" />
                    Copy PEM
                  </DropdownMenuItem>
                )}
                {canRevokeCertificate && cert.status === "active" && !cert.isSystem && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setRevokeDialogOpen(true)}
                      className="text-destructive"
                    >
                      <ShieldOff className="h-4 w-4" />
                      Revoke Certificate
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <PanelShell title="Certificate Details" bodyClassName="divide-y divide-border">
            <DetailRow label="Common Name" value={cert.commonName} />
            {cert.subjectDn && <DetailRow label="Subject DN" value={cert.subjectDn} />}
            {cert.issuerDn && <DetailRow label="Issuer DN" value={cert.issuerDn} />}
            <DetailRow label="Serial Number" value={formatSerialNumber(cert.serialNumber)} />
            <DetailRow label="Key Algorithm" value={cert.keyAlgorithm} />
            {cert.templateId && <DetailRow label="Template ID" value={cert.templateId} />}
            <DetailRow label="Issued By" value={cert.issuedById || "—"} />
          </PanelShell>

          <PanelShell title="Validity & Usage" bodyClassName="divide-y divide-border">
            <DetailRow label="Valid From" value={formatDate(cert.notBefore)} />
            <DetailRow label="Valid Until" value={formatDate(cert.notAfter)} />
            <DetailRow
              label="Validity"
              value={
                <span>
                  {expiryDays > 0
                    ? `Expires in ${expiryDays} days`
                    : hoursUntil(cert.notAfter) > 0
                      ? `Expires in ${hoursUntil(cert.notAfter)} hours`
                      : "Expired"}
                </span>
              }
            />
            {cert.revokedAt && (
              <>
                <DetailRow label="Revoked At" value={formatDate(cert.revokedAt)} />
                <DetailRow
                  label="Revocation Reason"
                  value={cert.revocationReason || "unspecified"}
                />
              </>
            )}
            {(cert.sans?.length ?? 0) > 0 && (
              <DetailRow
                label="SANs"
                value={
                  <span className="flex max-w-full flex-col items-end gap-1">
                    {cert.sans.map((san, i) => (
                      <span key={i} className="max-w-full break-all">
                        {san}
                      </span>
                    ))}
                  </span>
                }
              />
            )}
            {(cert.keyUsage?.length ?? 0) > 0 && (
              <DetailRow
                label="Key Usage"
                value={
                  <span className="flex max-w-full flex-wrap justify-end gap-1">
                    {cert.keyUsage.map((ku) => (
                      <Badge key={ku} variant="secondary">
                        {ku}
                      </Badge>
                    ))}
                  </span>
                }
              />
            )}
            {(cert.extKeyUsage?.length ?? 0) > 0 && (
              <DetailRow
                label="Extended Key Usage"
                value={
                  <span className="flex max-w-full flex-wrap justify-end gap-1">
                    {cert.extKeyUsage.map((eku) => (
                      <Badge key={eku} variant="secondary">
                        {eku}
                      </Badge>
                    ))}
                  </span>
                }
              />
            )}
          </PanelShell>
        </div>
        {/* Revoke Dialog */}
        <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Revoke Certificate</DialogTitle>
              <DialogDescription>
                Select a reason for revocation. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Select value={revokeReason} onValueChange={setRevokeReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unspecified">Unspecified</SelectItem>
                  <SelectItem value="keyCompromise">Key Compromise</SelectItem>
                  <SelectItem value="caCompromise">CA Compromise</SelectItem>
                  <SelectItem value="affiliationChanged">Affiliation Changed</SelectItem>
                  <SelectItem value="superseded">Superseded</SelectItem>
                  <SelectItem value="cessationOfOperation">Cessation of Operation</SelectItem>
                  <SelectItem value="certificateHold">Certificate Hold</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleRevoke} disabled={isRevoking}>
                {isRevoking ? "Revoking..." : "Revoke"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={pkcs12DialogOpen}
          onOpenChange={(open) => {
            if (downloadingFormat === "pkcs12") return;
            setPkcs12DialogOpen(open);
            if (!open) setPkcs12Passphrase("");
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Export PKCS#12</DialogTitle>
              <DialogDescription>
                Enter a passphrase to protect the exported certificate archive.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Passphrase</label>
              <Input
                type="password"
                value={pkcs12Passphrase}
                onChange={(event) => setPkcs12Passphrase(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handlePkcs12Download();
                }}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setPkcs12DialogOpen(false);
                  setPkcs12Passphrase("");
                }}
                disabled={downloadingFormat === "pkcs12"}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePkcs12Download}
                disabled={downloadingFormat === "pkcs12" || !pkcs12Passphrase.trim()}
              >
                {downloadingFormat === "pkcs12" ? "Exporting..." : "Export"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}
