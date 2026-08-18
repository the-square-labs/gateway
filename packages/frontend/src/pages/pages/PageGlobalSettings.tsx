import { ExternalLink, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageProfile, PageProfileOptions } from "@/types";

function certificateCovers(
  certificate: Pick<PageProfileOptions["certificates"][number], "domainNames">,
  domain: string
): boolean {
  const expected = `*.${domain.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase()}`;
  return certificate.domainNames.some((name) => name.toLowerCase().replace(/\.$/, "") === expected);
}

function templateLabel(template: string, hash = "da32ccagd23fe", project = "docs") {
  return template.replaceAll("{hash}", hash).replaceAll("{project}", project);
}

export function PagesSettingsSection() {
  const canEdit = useAuthStore((state) => state.hasScope("pages:settings:edit"));
  const [profile, setProfile] = useState<PageProfile | null>(null);
  const [options, setOptions] = useState<PageProfileOptions>({
    domains: [],
    nodes: [],
    certificates: [],
  });
  const [loading, setLoading] = useState(true);
  const [domainId, setDomainId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [labelTemplate, setLabelTemplate] = useState("{hash}");
  const [enabled, setEnabled] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProfile, nextOptions] = await Promise.all([
        api.getPageProfile(),
        api.getPageProfileOptions(),
      ]);
      setProfile(nextProfile);
      setOptions(nextOptions);
      setDomainId(nextProfile.domainId ?? "");
      setCertificateId(nextProfile.certificateId ?? "");
      setLabelTemplate(nextProfile.labelTemplate || "{hash}");
      setEnabled(nextProfile.enabled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Pages settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("pages.profile.changed", () => void load());
  useScrollToNavigationTarget("pages", !loading);

  const selectedDomain = options.domains.find((domain) => domain.id === domainId) ?? null;
  const selectedCertificate =
    options.certificates.find((certificate) => certificate.id === certificateId) ?? null;
  const selectedDomainSharesGateway = Boolean(selectedDomain?.isolation.same);
  const existingOverrideApplies =
    profile?.domainId === selectedDomain?.id && profile?.isolation?.overrideCurrent === true;
  const sameRegistrableDomain = selectedDomainSharesGateway && !existingOverrideApplies;
  const templateError = useMemo(() => {
    const dots = labelTemplate.includes(".");
    const hashes = (labelTemplate.match(/\{hash\}/g) ?? []).length;
    const unknown = /\{(?!hash\}|project\})/.test(labelTemplate);
    const rendered = templateLabel(labelTemplate);
    if (!labelTemplate.trim()) return "Template is required";
    if (dots) return "Template must be one DNS label; dots are not allowed";
    if (hashes !== 1) return "Template must contain {hash} exactly once";
    if (unknown || (labelTemplate.match(/\{project\}/g) ?? []).length > 1)
      return "Only {hash} and {project} are supported";
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rendered) || rendered.length > 63)
      return "Rendered template must be a lowercase DNS label up to 63 characters";
    return null;
  }, [labelTemplate]);

  const validSelection = Boolean(
    selectedDomain &&
      selectedDomain.dnsStatus === "valid" &&
      selectedCertificate &&
      certificateCovers(selectedCertificate, selectedDomain.domain) &&
      !templateError
  );
  const dirty = Boolean(
    profile &&
      (enabled !== profile.enabled ||
        domainId !== (profile.domainId ?? "") ||
        certificateId !== (profile.certificateId ?? "") ||
        labelTemplate !== (profile.labelTemplate || "{hash}"))
  );
  const canSave = dirty && canEdit && !saving && (!enabled || validSelection);

  const save = async (override = false) => {
    if (!canSave) return;
    if (!enabled) {
      setSaving(true);
      try {
        const updated = await api.updatePageProfile({ enabled: false });
        setProfile(updated);
        setEnabled(updated.enabled);
        toast.success("Immutable preview delivery disabled");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to disable Pages previews");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (selectedDomainSharesGateway && !existingOverrideApplies && !override) {
      setWarningOpen(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updatePageProfile({
        enabled: true,
        domainId: selectedDomain!.id,
        certificateId: selectedCertificate!.id,
        labelTemplate: labelTemplate.trim(),
        acknowledgeSameRegistrableDomain: override || existingOverrideApplies,
      });
      setProfile(updated);
      setEnabled(updated.enabled);
      setDomainId(updated.domainId ?? "");
      setCertificateId(updated.certificateId ?? "");
      setLabelTemplate(updated.labelTemplate || "{hash}");
      toast.success("Pages wildcard profile saved");
      setWarningOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Pages profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="pages" className="space-y-4 scroll-mt-6">
      {loading && !profile ? (
        <PanelShell title="Pages" description="Loading wildcard deployment preview settings…" />
      ) : (
        <>
          <PanelShell
            title="Pages"
            description="Each immutable Deployment gets one hostname label under this wildcard Domain."
            actions={
              <Button onClick={() => void save()} disabled={!canSave}>
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save profile"}
              </Button>
            }
            dirty={dirty}
          >
            <SettingsControlRow
              title="Preview delivery"
              description={
                enabled
                  ? "Immutable preview URLs are enabled."
                  : "Immutable preview URLs are disabled."
              }
            >
              <Switch
                checked={enabled}
                onChange={setEnabled}
                disabled={!canEdit || saving}
                ariaLabel="Enable immutable previews"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Base wildcard Domain"
              description={
                <span>
                  Choose a registered wildcard Domain.{" "}
                  <Link className="text-primary underline" to="/domains">
                    Create or manage Domains <ExternalLink className="inline h-3 w-3" />
                  </Link>
                </span>
              }
            >
              <Select
                value={domainId || undefined}
                onValueChange={setDomainId}
                disabled={!canEdit || !enabled || saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select wildcard Domain" />
                </SelectTrigger>
                <SelectContent>
                  {options.domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {domain.domain} · DNS {domain.dnsStatus}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Wildcard certificate"
              description="The certificate must cover the exact *.base.domain name."
            >
              <Select
                value={certificateId || undefined}
                onValueChange={setCertificateId}
                disabled={!canEdit || !enabled || saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select certificate" />
                </SelectTrigger>
                <SelectContent>
                  {options.certificates.map((certificate) => (
                    <SelectItem
                      key={certificate.id}
                      value={certificate.id}
                      disabled={
                        selectedDomain
                          ? !certificateCovers(certificate, selectedDomain.domain)
                          : false
                      }
                    >
                      {certificate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Hostname label template"
              description="Exactly one DNS label is editable; dots are forbidden and {hash} is required."
            >
              <div className="flex w-full flex-col gap-2">
                <Input
                  value={labelTemplate}
                  onChange={(event) => setLabelTemplate(event.target.value.toLowerCase())}
                  disabled={!canEdit || !enabled || saving}
                  aria-invalid={!!templateError}
                  className={
                    templateError
                      ? "border-destructive focus-visible:border-destructive focus-visible:ring-0"
                      : undefined
                  }
                />
              </div>
            </SettingsControlRow>
            {profile?.isolation?.overrideCurrent && (
              <SettingsControlRow
                title="Isolation override acknowledged"
                description={`Acknowledged ${profile.overrideAcknowledgedAt ? new Date(profile.overrideAcknowledgedAt).toLocaleString() : "previously"}. Re-evaluate it after changing the Domain.`}
              >
                <Badge variant="warning">Cookie isolation warning accepted</Badge>
              </SettingsControlRow>
            )}
          </PanelShell>

          {sameRegistrableDomain && (
            <PanelShell
              title="Separate registrable domain recommended"
              description="Deployed JavaScript can affect parent-domain cookies when Gateway and Pages share a registrable domain. Saving requires explicit acknowledgement."
              actions={<Badge variant="warning">Review required</Badge>}
            />
          )}

          <Dialog open={warningOpen} onOpenChange={setWarningOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Confirm same-domain Pages previews</DialogTitle>
                <DialogDescription>
                  This override requires explicit acknowledgement.
                </DialogDescription>
              </DialogHeader>
              <PanelShell
                title="Why confirmation is required"
                description="Pages should use a separate registrable domain. Deployed JavaScript may affect Gateway cookies on the shared parent domain."
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setWarningOpen(false)}>
                  Choose another Domain
                </Button>
                <Button onClick={() => void save(true)}>Acknowledge and save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
