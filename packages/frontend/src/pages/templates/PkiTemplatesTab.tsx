import { FileText, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  CertificatePolicy,
  CertificateType,
  CustomExtension,
  KeyAlgorithm,
  Template,
} from "@/types";
import {
  StepCustomExtensions,
  StepDistribution,
  StepExtKeyUsage,
  StepGeneral,
  StepKeyUsage,
  StepPolicies,
  StepSAN,
  StepSubjectDN,
  WIZARD_STEPS,
} from "./PkiTemplateWizardSteps";

export function PkiTemplatesTab({
  embedded,
  onCreateRef,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
}) {
  const { hasScope } = useAuthStore();
  const canListTemplates = hasScope("pki:templates:view");
  const canCreateTemplates = hasScope("pki:templates:create");
  const canEditTemplates = hasScope("pki:templates:edit");
  const canDeleteTemplates = hasScope("pki:templates:delete");
  const cachedTemplates = canListTemplates
    ? api.getCached<Template[]>("templates:list")
    : undefined;
  const [templates, setTemplates] = useState<Template[]>(cachedTemplates ?? []);
  const [isLoading, setIsLoading] = useState(canListTemplates && !cachedTemplates);
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [step, setStep] = useState(0);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [certType, setCertType] = useState<CertificateType>("tls-server");
  const [keyAlgorithm, setKeyAlgorithm] = useState<KeyAlgorithm>("ecdsa-p256");
  const [validityDays, setValidityDays] = useState(365);
  const [keyUsage, setKeyUsage] = useState<string[]>([]);
  const [extKeyUsage, setExtKeyUsage] = useState<string[]>([]);
  const [customEkuOid, setCustomEkuOid] = useState("");
  const [requireSans, setRequireSans] = useState(true);
  const [sanTypes, setSanTypes] = useState<string[]>(["dns", "ip"]);
  const [dnO, setDnO] = useState("");
  const [dnOu, setDnOu] = useState("");
  const [dnL, setDnL] = useState("");
  const [dnSt, setDnSt] = useState("");
  const [dnC, setDnC] = useState("");
  const [crlDistributionPoints, setCrlDistributionPoints] = useState<string[]>([]);
  const [caIssuersUrl, setCaIssuersUrl] = useState("");
  const [certificatePolicies, setCertificatePolicies] = useState<CertificatePolicy[]>([]);
  const [customExtensions, setCustomExtensions] = useState<CustomExtension[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const loadTemplates = useCallback(async () => {
    if (!canListTemplates) {
      setTemplates([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listTemplates();
      setTemplates(data || []);
    } catch {
      toast.error("Failed to load templates");
    } finally {
      setIsLoading(false);
    }
  }, [canListTemplates]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useRealtime("pki.template.changed", () => {
    loadTemplates();
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setCertType("tls-server");
    setKeyAlgorithm("ecdsa-p256");
    setValidityDays(365);
    setKeyUsage([]);
    setExtKeyUsage([]);
    setCustomEkuOid("");
    setRequireSans(true);
    setSanTypes(["dns", "ip"]);
    setDnO("");
    setDnOu("");
    setDnL("");
    setDnSt("");
    setDnC("");
    setCrlDistributionPoints([]);
    setCaIssuersUrl("");
    setCertificatePolicies([]);
    setCustomExtensions([]);
    setStep(0);
  };

  const openCreate = () => {
    setEditing(null);
    resetForm();
    setDialogOpen(true);
  };

  // Expose create action to parent
  const createRefSet = useRef(false);
  if (onCreateRef && !createRefSet.current) {
    onCreateRef(openCreate);
    createRefSet.current = true;
  }

  const openEdit = (t: Template) => {
    setEditing(t);
    setName(t.name);
    setDescription(t.description || "");
    setCertType(t.certType);
    setKeyAlgorithm(t.keyAlgorithm);
    setValidityDays(t.validityDays);
    setKeyUsage(t.keyUsage || []);
    setExtKeyUsage(t.extKeyUsage || []);
    setRequireSans(t.requireSans);
    setSanTypes(t.sanTypes || []);
    setDnO(t.subjectDnFields?.o || "");
    setDnOu(t.subjectDnFields?.ou || "");
    setDnL(t.subjectDnFields?.l || "");
    setDnSt(t.subjectDnFields?.st || "");
    setDnC(t.subjectDnFields?.c || "");
    setCrlDistributionPoints(t.crlDistributionPoints || []);
    setCaIssuersUrl(t.authorityInfoAccess?.caIssuersUrl || "");
    setCertificatePolicies(t.certificatePolicies || []);
    setCustomExtensions(t.customExtensions || []);
    setStep(0);
    setDialogOpen(true);
  };

  const buildPayload = () => ({
    name,
    description: description || undefined,
    certType,
    keyAlgorithm,
    validityDays,
    keyUsage,
    extKeyUsage,
    requireSans,
    sanTypes,
    subjectDnFields: {
      ...(dnO ? { o: dnO } : {}),
      ...(dnOu ? { ou: dnOu } : {}),
      ...(dnL ? { l: dnL } : {}),
      ...(dnSt ? { st: dnSt } : {}),
      ...(dnC ? { c: dnC } : {}),
    },
    crlDistributionPoints: crlDistributionPoints.filter((u) => u.trim()),
    authorityInfoAccess: {
      ...(caIssuersUrl ? { caIssuersUrl } : {}),
    },
    certificatePolicies: certificatePolicies.filter((p) => p.oid.trim()),
    customExtensions: customExtensions.filter((e) => e.oid.trim() && e.value.trim()),
  });

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setIsSaving(true);
    try {
      const payload = buildPayload();
      if (editing) {
        await api.updateTemplate(editing.id, payload);
        toast.success("Template updated");
      } else {
        await api.createTemplate(payload);
        toast.success("Template created");
      }
      setDialogOpen(false);
      loadTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (template: Template) => {
    const ok = await confirm({
      title: "Delete Template",
      description: `Delete "${template.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteTemplate(template.id);
      toast.success("Template deleted");
      loadTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete template");
    }
  };

  const isLastStep = step === WIZARD_STEPS.length - 1;
  const canProceed =
    step === 0 ? name.trim() !== "" && validityDays >= 1 && validityDays <= 3650 : true;
  const templateColumns: SimpleTableColumn<Template>[] = [
    {
      id: "name",
      header: "Name",
      render: (template) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{template.name}</span>
          {template.isBuiltin && <Badge size="inline">Built-in</Badge>}
        </div>
      ),
    },
    {
      id: "description",
      header: "Description",
      render: (template) => (
        <span className="line-clamp-1 text-sm text-muted-foreground">
          {template.description || "No description"}
        </span>
      ),
    },
    {
      id: "type",
      header: "Type",
      render: (template) => <Badge variant="secondary">{template.certType}</Badge>,
    },
    {
      id: "algorithm",
      header: "Algorithm",
      render: (template) => <Badge variant="secondary">{template.keyAlgorithm}</Badge>,
    },
    {
      id: "validity",
      header: "Validity",
      render: (template) => <Badge variant="secondary">{template.validityDays}d</Badge>,
    },
    {
      id: "usage",
      header: "Usage",
      render: (template) => (
        <div className="flex flex-wrap gap-1">
          {(template.keyUsage?.length ?? 0) > 0 && (
            <Badge variant="secondary">{template.keyUsage.length} KU</Badge>
          )}
          {(template.extKeyUsage?.length ?? 0) > 0 && (
            <Badge variant="secondary">{template.extKeyUsage.length} EKU</Badge>
          )}
          {(template.crlDistributionPoints?.length ?? 0) > 0 && (
            <Badge variant="secondary">CRL</Badge>
          )}
          {(template.customExtensions?.length ?? 0) > 0 && (
            <Badge variant="secondary">{template.customExtensions.length} ext</Badge>
          )}
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-12",
      cellClassName: "w-12",
      render: (template) =>
        (canEditTemplates || canDeleteTemplates) && !template.isBuiltin ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditTemplates && (
                  <DropdownMenuItem onClick={() => openEdit(template)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDeleteTemplates && (
                  <DropdownMenuItem
                    onClick={() => handleDelete(template)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  if (!canListTemplates) {
    return null;
  }

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold">Templates</h1>
              <p className="text-sm text-muted-foreground">Certificate issuance templates</p>
            </div>
            <ResponsiveHeaderActions
              actions={
                canCreateTemplates
                  ? [
                      {
                        label: "Create Template",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: openCreate,
                      },
                    ]
                  : []
              }
            >
              {canCreateTemplates && (
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" />
                  Create Template
                </Button>
              )}
            </ResponsiveHeaderActions>
          </div>
        )}

        {/* Template grid */}
        {initialLoading && templates.length === 0 ? (
          <Skeleton />
        ) : templates.length > 0 ? (
          <div className="border border-border bg-card">
            <SimpleTable
              columns={templateColumns}
              rows={templates}
              getRowKey={(template) => template.id}
              loading={isLoading}
              loadingMessage="Loading certificate templates"
              onRowClick={(template) => {
                if (canEditTemplates && !template.isBuiltin) openEdit(template);
              }}
              isRowClickable={(template) => canEditTemplates && !template.isBuiltin}
            />
          </div>
        ) : (
          <EmptyState
            message="No templates."
            {...(canCreateTemplates
              ? { actionLabel: "Create one", onAction: () => setDialogOpen(true) }
              : {})}
          />
        )}

        {/* Wizard Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Template" : "Create Template"}</DialogTitle>
            </DialogHeader>

            {/* Step indicator */}
            <div className="flex gap-1 px-1">
              {WIZARD_STEPS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className={`flex-1 h-1 transition-colors ${i <= step ? "bg-primary" : "bg-muted"}`}
                  onClick={() => setStep(i)}
                />
              ))}
            </div>
            <div className="mb-2">
              <p className="text-sm font-medium">{WIZARD_STEPS[step].title}</p>
              <p className="text-xs text-muted-foreground">{WIZARD_STEPS[step].subtitle}</p>
            </div>

            {/* Step content */}
            <div className="-mx-1 space-y-4 px-1 pb-1">
              {step === 0 && (
                <StepGeneral
                  name={name}
                  setName={setName}
                  description={description}
                  setDescription={setDescription}
                  certType={certType}
                  setCertType={setCertType}
                  keyAlgorithm={keyAlgorithm}
                  setKeyAlgorithm={setKeyAlgorithm}
                  validityDays={validityDays}
                  setValidityDays={setValidityDays}
                />
              )}
              {step === 1 && <StepKeyUsage keyUsage={keyUsage} setKeyUsage={setKeyUsage} />}
              {step === 2 && (
                <StepExtKeyUsage
                  extKeyUsage={extKeyUsage}
                  setExtKeyUsage={setExtKeyUsage}
                  customEkuOid={customEkuOid}
                  setCustomEkuOid={setCustomEkuOid}
                />
              )}
              {step === 3 && (
                <StepSAN
                  requireSans={requireSans}
                  setRequireSans={setRequireSans}
                  sanTypes={sanTypes}
                  setSanTypes={setSanTypes}
                />
              )}
              {step === 4 && (
                <StepSubjectDN
                  dnO={dnO}
                  setDnO={setDnO}
                  dnOu={dnOu}
                  setDnOu={setDnOu}
                  dnL={dnL}
                  setDnL={setDnL}
                  dnSt={dnSt}
                  setDnSt={setDnSt}
                  dnC={dnC}
                  setDnC={setDnC}
                />
              )}
              {step === 5 && (
                <StepDistribution
                  crlDistributionPoints={crlDistributionPoints}
                  setCrlDistributionPoints={setCrlDistributionPoints}
                  caIssuersUrl={caIssuersUrl}
                  setCaIssuersUrl={setCaIssuersUrl}
                />
              )}
              {step === 6 && (
                <StepPolicies
                  certificatePolicies={certificatePolicies}
                  setCertificatePolicies={setCertificatePolicies}
                />
              )}
              {step === 7 && (
                <StepCustomExtensions
                  customExtensions={customExtensions}
                  setCustomExtensions={setCustomExtensions}
                />
              )}
            </div>

            <DialogFooter className="flex items-center justify-between sm:justify-between">
              <div>
                {step > 0 && (
                  <Button variant="outline" onClick={() => setStep(step - 1)}>
                    Back
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                {isLastStep ? (
                  <Button onClick={handleSave} disabled={isSaving || !canProceed}>
                    {isSaving ? "Saving..." : editing ? "Update" : "Create"}
                  </Button>
                ) : (
                  <Button onClick={() => setStep(step + 1)} disabled={!canProceed}>
                    Next
                  </Button>
                )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );

  if (embedded) return content;
  return <PageTransition>{content}</PageTransition>;
}
