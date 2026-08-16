import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type { CertificateType, KeyAlgorithm, Template } from "@/types";

interface CertificateIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caId?: string;
  onSuccess?: () => void;
}

export function CertificateIssueDialog({
  open,
  onOpenChange,
  caId,
  onSuccess,
}: CertificateIssueDialogProps) {
  const { cas } = useCAStore();
  const hasScope = useAuthStore((state) => state.hasScope);
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isIssuing, setIsIssuing] = useState(false);

  // Form state
  const [selectedCAId, setSelectedCAId] = useState(caId || "");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [type, setType] = useState<CertificateType>("tls-server");
  const [commonName, setCommonName] = useState("");
  const [validityDays, setValidityDays] = useState(365);
  const [keyAlgorithm, setKeyAlgorithm] = useState<KeyAlgorithm>("ecdsa-p256");
  const [sans, setSans] = useState<string[]>([]);
  const [sanInput, setSanInput] = useState("");
  const [dnO, setDnO] = useState("");
  const [dnOu, setDnOu] = useState("");
  const [dnC, setDnC] = useState("");

  useEffect(() => {
    if (open) {
      api
        .listTemplates()
        .then((data) => setTemplates(data || []))
        .catch(() => {});
      setStep(1);
      setSelectedCAId(caId || "");
      setSelectedTemplateId("");
      setCommonName("");
      setSans([]);
      setSanInput("");
    }
  }, [open, caId]);

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      setType(template.certType);
      setKeyAlgorithm(template.keyAlgorithm);
      setValidityDays(template.validityDays);
    }
  };

  const addSAN = () => {
    if (sanInput.trim() && !sans.includes(sanInput.trim())) {
      setSans([...sans, sanInput.trim()]);
      setSanInput("");
    }
  };

  const removeSAN = (san: string) => {
    setSans(sans.filter((s) => s !== san));
  };

  const handleIssue = async () => {
    if (!selectedCAId) {
      toast.error("Please select a CA");
      return;
    }
    if (!commonName.trim()) {
      toast.error("Common Name is required");
      return;
    }

    setIsIssuing(true);
    try {
      const subjectDnFields = {
        ...(dnO ? { o: dnO } : {}),
        ...(dnOu ? { ou: dnOu } : {}),
        ...(dnC ? { c: dnC } : {}),
      };
      await api.issueCertificate({
        caId: selectedCAId,
        templateId: selectedTemplateId || undefined,
        type,
        commonName,
        sans: sans.length > 0 ? sans : [],
        validityDays,
        keyAlgorithm,
        ...(Object.keys(subjectDnFields).length > 0 ? { subjectDnFields } : {}),
      });
      toast.success(`Certificate issued for ${commonName}`);
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue certificate");
    } finally {
      setIsIssuing(false);
    }
  };

  const activeCAs = (cas || []).filter(
    (ca) =>
      ca.status === "active" &&
      !ca.isSystem &&
      (hasScope("pki:cert:issue") || hasScope(`pki:cert:issue:${ca.id}`))
  );
  const sansRequired = type === "tls-server" || type === "email";
  const step2Valid =
    commonName.trim() !== "" &&
    validityDays >= 1 &&
    validityDays <= 3650 &&
    (!sansRequired || sans.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Issue Certificate</DialogTitle>
          <DialogDescription>
            Step {step} of 3 &mdash;{" "}
            {step === 1
              ? "Select CA & Template"
              : step === 2
                ? "Subject Details"
                : "Review & Issue"}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: CA & Template Selection */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Issuing CA</label>
              <Select value={selectedCAId || undefined} onValueChange={(v) => setSelectedCAId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a CA..." />
                </SelectTrigger>
                <SelectContent>
                  {activeCAs.map((ca) => (
                    <SelectItem key={ca.id} value={ca.id}>
                      {ca.commonName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {templates.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Template</label>
                <Select
                  value={selectedTemplateId || "none"}
                  onValueChange={(v) => handleTemplateSelect(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No template</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Certificate Type</label>
                <Select
                  value={type}
                  onValueChange={(v) => {
                    setType(v as CertificateType);
                    setSelectedTemplateId("");
                  }}
                  disabled={!!selectedTemplateId}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tls-server">TLS Server</SelectItem>
                    <SelectItem value="tls-client">TLS Client</SelectItem>
                    <SelectItem value="code-signing">Code Signing</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Key Algorithm</label>
                <Select
                  value={keyAlgorithm}
                  onValueChange={(v) => {
                    setKeyAlgorithm(v as KeyAlgorithm);
                    setSelectedTemplateId("");
                  }}
                  disabled={!!selectedTemplateId}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rsa-2048">RSA-2048</SelectItem>
                    <SelectItem value="rsa-4096">RSA-4096</SelectItem>
                    <SelectItem value="ecdsa-p256">ECDSA-P256</SelectItem>
                    <SelectItem value="ecdsa-p384">ECDSA-P384</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Subject Details */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Common Name (CN)</label>
              <Input
                value={commonName}
                onChange={(e) => setCommonName(e.target.value)}
                placeholder="e.g., api.example.com"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Validity (days)</label>
              <NumericInput
                value={validityDays}
                onChange={(v) => setValidityDays(v)}
                min={1}
                max={3650}
              />
            </div>

            {/* SANs */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Subject Alternative Names
                {sansRequired && <span className="text-destructive ml-1">*</span>}
              </label>
              {sansRequired && sans.length === 0 && (
                <p className="text-xs text-destructive">
                  At least one SAN is required for {type} certificates
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={sanInput}
                  onChange={(e) => setSanInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSAN())}
                  placeholder="e.g., *.example.com or 192.168.1.1"
                />
                <Button variant="outline" size="icon" onClick={addSAN}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {sans.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {sans.map((san) => (
                    <Badge key={san} variant="secondary" className="gap-1">
                      {san}
                      <button onClick={() => removeSAN(san)}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Subject DN (optional) */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Subject DN (optional)</label>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  value={dnO}
                  onChange={(e) => setDnO(e.target.value)}
                  placeholder="Organization (O)"
                />
                <Input
                  value={dnOu}
                  onChange={(e) => setDnOu(e.target.value)}
                  placeholder="Org Unit (OU)"
                />
                <Input
                  value={dnC}
                  onChange={(e) => setDnC(e.target.value)}
                  placeholder="Country (C)"
                  maxLength={2}
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <div className="space-y-3 text-sm">
            <div className="border border-border p-4 space-y-2">
              <h3 className="font-semibold">Review</h3>
              <div className="space-y-1.5">
                <p>
                  <span className="text-muted-foreground">CA:</span>{" "}
                  {activeCAs.find((c) => c.id === selectedCAId)?.commonName}
                </p>
                <p>
                  <span className="text-muted-foreground">Type:</span>{" "}
                  <span className="capitalize">{type}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Common Name:</span> {commonName}
                </p>
                <p>
                  <span className="text-muted-foreground">Key Algorithm:</span> {keyAlgorithm}
                </p>
                <p>
                  <span className="text-muted-foreground">Validity:</span> {validityDays} days
                </p>
                {sans.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">SANs:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {sans.map((san) => (
                        <Badge key={san} variant="secondary">
                          {san}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step > 1 && (
            <Button variant="outline" onClick={() => setStep(step - 1)}>
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          )}
          <div className="flex-1" />
          {step < 3 ? (
            <Button
              disabled={(step === 1 && !selectedCAId) || (step === 2 && !step2Valid)}
              onClick={() => setStep(step + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleIssue} disabled={isIssuing}>
              {isIssuing ? "Issuing..." : "Issue Certificate"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
