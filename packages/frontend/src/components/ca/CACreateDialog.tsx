import { useState } from "react";
import { toast } from "sonner";
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
import type { KeyAlgorithm } from "@/types";

interface CACreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = root CA, "pick" = show parent selector, uuid = specific parent */
  parentId?: string;
}

export function CACreateDialog({ open, onOpenChange, parentId }: CACreateDialogProps) {
  const { cas, fetchCAs } = useCAStore();
  const hasScope = useAuthStore((s) => s.hasScope);

  const [selectedParentId, setSelectedParentId] = useState<string>("");
  const [commonName, setCommonName] = useState("");
  const [keyAlgorithm, setKeyAlgorithm] = useState<KeyAlgorithm>("ecdsa-p256");
  const [validityYears, setValidityYears] = useState(10);
  const [pathLengthConstraint, setPathLengthConstraint] = useState<number | undefined>(undefined);
  const [maxValidityDays, setMaxValidityDays] = useState(365);
  const [isSaving, setIsSaving] = useState(false);

  const needsParentPicker = parentId === "pick";
  const resolvedParentId = needsParentPicker ? selectedParentId : parentId;
  const isIntermediate = !!resolvedParentId;
  const activeCAs = (cas || []).filter(
    (ca) =>
      ca.status === "active" && !ca.isSystem && hasScope(`pki:ca:create:intermediate:${ca.id}`)
  );

  const handleCreate = async () => {
    if (!commonName.trim()) {
      toast.error("Common Name is required");
      return;
    }
    if (isIntermediate && !resolvedParentId) {
      toast.error("Select a parent CA");
      return;
    }

    setIsSaving(true);
    try {
      const data = {
        commonName,
        keyAlgorithm,
        validityYears,
        pathLengthConstraint,
        maxValidityDays,
      };

      if (isIntermediate) {
        await api.createIntermediateCA(resolvedParentId!, data);
      } else {
        await api.createRootCA(data);
      }

      toast.success(`${isIntermediate ? "Intermediate" : "Root"} CA created`);
      onOpenChange(false);
      fetchCAs();
      setTimeout(() => {
        setCommonName("");
        setSelectedParentId("");
        setValidityYears(10);
        setPathLengthConstraint(undefined);
        setMaxValidityDays(365);
      }, 200);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create CA");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create {isIntermediate ? "Intermediate" : "Root"} CA</DialogTitle>
          <DialogDescription>
            {isIntermediate
              ? "Create a new intermediate CA signed by the parent."
              : "Create a new self-signed Root Certificate Authority."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {needsParentPicker && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Parent CA</label>
              <Select
                value={selectedParentId || "none"}
                onValueChange={(v) => setSelectedParentId(v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent CA..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>
                    Select parent CA...
                  </SelectItem>
                  {activeCAs.map((ca) => (
                    <SelectItem key={ca.id} value={ca.id}>
                      {ca.commonName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Common Name (CN)</label>
            <Input
              value={commonName}
              onChange={(e) => setCommonName(e.target.value)}
              placeholder={
                isIntermediate ? "e.g., My Org Intermediate CA" : "e.g., My Organization Root CA"
              }
              autoFocus={!needsParentPicker}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Key Algorithm</label>
              <Select
                value={keyAlgorithm}
                onValueChange={(v) => setKeyAlgorithm(v as KeyAlgorithm)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ecdsa-p256">ECDSA P-256</SelectItem>
                  <SelectItem value="ecdsa-p384">ECDSA P-384</SelectItem>
                  <SelectItem value="rsa-2048">RSA 2048</SelectItem>
                  <SelectItem value="rsa-4096">RSA 4096</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Validity (years)</label>
              <Input
                type="number"
                value={validityYears}
                onChange={(e) => setValidityYears(parseInt(e.target.value, 10) || 10)}
                min={1}
                max={30}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Path Length Constraint</label>
              <Input
                type="number"
                value={pathLengthConstraint ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setPathLengthConstraint(val === "" ? undefined : parseInt(val, 10));
                }}
                placeholder="Optional"
                min={0}
                max={10}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Cert Validity (days)</label>
              <Input
                type="number"
                value={maxValidityDays}
                onChange={(e) => setMaxValidityDays(parseInt(e.target.value, 10) || 365)}
                min={1}
                max={3650}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isSaving || !commonName.trim() || (needsParentPicker && !selectedParentId)}
          >
            {isSaving ? "Creating..." : "Create CA"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
