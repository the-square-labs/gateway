import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { SiemAuthType, SiemDestination } from "@/types";

const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function SiemDestinationDialog({
  open,
  onOpenChange,
  destination,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destination: SiemDestination | null;
  onSaved: () => void;
}) {
  const isEdit = !!destination;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<SiemAuthType>("bearer");
  const [customHeaderName, setCustomHeaderName] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(destination?.name ?? "");
    setUrl(destination?.url ?? "");
    setAuthType(destination?.authType ?? "bearer");
    setCustomHeaderName(destination?.customHeaderName ?? "");
    setSecret("");
    setEnabled(destination?.enabled ?? true);
  }, [destination, open]);

  const validateUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    const trimmedCustomHeaderName = customHeaderName.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    if (!validateUrl(trimmedUrl)) {
      toast.error("Use an HTTPS URL without credentials, query parameters, or fragments");
      return;
    }
    if (authType === "custom_header" && !trimmedCustomHeaderName) {
      toast.error("Custom header name is required");
      return;
    }
    if (!isEdit && !secret) {
      toast.error("Authentication secret is required");
      return;
    }
    if (isEdit && authType !== destination.authType && !secret) {
      toast.error("Provide a new secret when changing authentication type");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await api.updateSiemDestination(destination.id, {
          name: trimmedName,
          url: trimmedUrl,
          authType,
          ...(authType === "custom_header" ? { customHeaderName: trimmedCustomHeaderName } : {}),
          enabled,
          ...(secret ? { secret } : {}),
        });
        toast.success("SIEM destination updated");
      } else {
        await api.createSiemDestination({
          name: trimmedName,
          url: trimmedUrl,
          authType,
          ...(authType === "custom_header" ? { customHeaderName: trimmedCustomHeaderName } : {}),
          secret,
          enabled,
        });
        toast.success("SIEM destination created");
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      if (!handleLicenseApiError(error, "SIEM destinations")) {
        toast.error(error instanceof Error ? error.message : "Failed to save SIEM destination");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit SIEM Destination" : "New SIEM Destination"}</DialogTitle>
          <DialogDescription>
            Gateway sends privacy-reduced audit events to this HTTPS collector.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="siem-name">
              Name
            </label>
            <Input
              id="siem-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Security operations"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="siem-url">
              HTTPS endpoint
            </label>
            <Input
              id="siem-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://siem.example.com/gateway/audit"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              No credentials, query parameters, or URL fragments.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Authentication</label>
            <Select value={authType} onValueChange={(value) => setAuthType(value as SiemAuthType)}>
              <SelectTrigger aria-label="Authentication method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="hmac_sha256">HMAC-SHA256</SelectItem>
                <SelectItem value="custom_header">Custom header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AnimatedHeight>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={authType} {...FORM_ANIMATION} className="space-y-4">
                {authType === "custom_header" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="siem-custom-header-name">
                        Custom header
                      </label>
                      <Input
                        id="siem-custom-header-name"
                        value={customHeaderName}
                        onChange={(event) => setCustomHeaderName(event.target.value)}
                        placeholder="X-API-Key"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="siem-secret">
                        Header value
                      </label>
                      <Input
                        id="siem-secret"
                        type="password"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder={isEdit ? "Leave blank to keep current" : "Required"}
                        autoComplete="new-password"
                      />
                      <p className="text-xs text-muted-foreground">
                        Gateway sends this header with every request. Gateway transport headers
                        cannot be overridden.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="siem-secret">
                      {authType === "bearer" ? "Bearer token" : "HMAC secret"}
                    </label>
                    <Input
                      id="siem-secret"
                      type="password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={isEdit ? "Leave blank to keep current" : "Required"}
                      autoComplete="new-password"
                    />
                    {authType === "hmac_sha256" && (
                      <p className="text-xs text-muted-foreground">
                        Gateway sends <code>X-Gateway-Timestamp</code> and signs it with the raw
                        JSON body in <code>X-Gateway-Signature-256</code>.
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </AnimatedHeight>
          <div className="pt-4">
            <div className="flex items-center justify-between gap-4 border border-border bg-muted/30 p-3">
              <div>
                <p className="text-sm font-medium">Delivery enabled</p>
                <p className="text-xs text-muted-foreground">
                  Disabled destinations keep their queued events paused until re-enabled.
                </p>
              </div>
              <Switch checked={enabled} onChange={setEnabled} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Secrets are encrypted at rest and cannot be viewed again. Full audit details and
            collector response bodies are not exported.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
