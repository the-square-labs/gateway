import { Copy, FileCode, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { NginxTemplate } from "@/types";

export function getTemplatePreviewEditorHeight(content: string): string {
  const lineCount = Math.max(1, content.split("\n").length);
  const height = Math.min(Math.max(lineCount * 18 + 16, 120), 640);
  return `min(64dvh, ${height}px)`;
}

export function NginxTemplates({
  embedded,
  onCreateRef,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
}) {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canViewTemplates = hasScopedAccess("proxy:templates:view");
  const cachedTemplates = canViewTemplates
    ? api.getCached<NginxTemplate[]>("nginx-templates:list")
    : undefined;
  const [templates, setTemplates] = useState<NginxTemplate[]>(cachedTemplates ?? []);
  const [isLoading, setIsLoading] = useState(canViewTemplates && !cachedTemplates);
  const {
    open: previewOpen,
    value: previewTemplate,
    setValue: setPreviewTemplate,
    onOpenChange: onPreviewOpenChange,
  } = useDeferredDialogState<NginxTemplate>();
  const [previewContent, setPreviewContent] = useState("");
  const previewEditorHeight = useMemo(
    () => getTemplatePreviewEditorHeight(previewContent),
    [previewContent]
  );

  const load = useCallback(async () => {
    if (!canViewTemplates) {
      setTemplates([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listNginxTemplates();
      setTemplates(data || []);
    } catch {
      toast.error("Failed to load templates");
    } finally {
      setIsLoading(false);
    }
  }, [canViewTemplates]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("nginx.template.changed", () => {
    load();
  });

  // Expose create action to parent
  const createRefSet = useRef(false);
  if (onCreateRef && !createRefSet.current) {
    onCreateRef(() => navigate("/nginx-templates/new"));
    createRefSet.current = true;
  }

  const handleClone = async (id: string) => {
    try {
      const clone = await api.cloneNginxTemplate(id);
      toast.success("Template cloned");
      navigate(`/nginx-templates/${clone.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clone");
    }
  };

  const handleDelete = async (t: NginxTemplate) => {
    const ok = await confirm({
      title: "Delete Template",
      description: `Delete "${t.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteNginxTemplate(t.id);
      toast.success("Template deleted");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handlePreview = async (template: NginxTemplate) => {
    try {
      const result = await api.previewNginxTemplate(template.content);
      setPreviewContent(result.rendered);
      setPreviewTemplate(template);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to render preview");
    }
  };

  if (!canViewTemplates) {
    return null;
  }

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold">Config Templates</h1>
              <p className="text-sm text-muted-foreground">
                Nginx server block templates for proxy hosts
              </p>
            </div>
            <ResponsiveHeaderActions
              actions={
                hasScope("proxy:templates:create")
                  ? [
                      {
                        label: "Create Template",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => navigate("/nginx-templates/new"),
                      },
                    ]
                  : []
              }
            >
              {hasScope("proxy:templates:create") && (
                <Button onClick={() => navigate("/nginx-templates/new")}>
                  <Plus className="h-4 w-4" />
                  Create Template
                </Button>
              )}
            </ResponsiveHeaderActions>
          </div>
        )}

        {isLoading ? (
          <TemplateCardsSkeleton />
        ) : templates.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => {
              const canEditTemplate =
                (hasScope("proxy:templates:edit") || hasScope(`proxy:templates:edit:${t.id}`)) &&
                !t.isBuiltin;
              const canCloneTemplate =
                hasScope("proxy:templates:create") &&
                (hasScope("proxy:templates:edit") || hasScope(`proxy:templates:edit:${t.id}`));
              const canDeleteTemplate =
                (hasScope("proxy:templates:delete") ||
                  hasScope(`proxy:templates:delete:${t.id}`)) &&
                !t.isBuiltin;
              const hasActions = canEditTemplate || canCloneTemplate || canDeleteTemplate;
              const canViewTemplate =
                hasScope("proxy:templates:view") || hasScope(`proxy:templates:view:${t.id}`);
              const canOpenTemplate = canEditTemplate || canViewTemplate;

              return (
                <div key={t.id} className="border border-border bg-card p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div
                      className={`flex items-center gap-2 ${
                        canOpenTemplate ? "cursor-pointer hover:opacity-80" : ""
                      }`}
                      onClick={() => {
                        if (canEditTemplate) {
                          navigate(`/nginx-templates/${t.id}`);
                        } else if (canViewTemplate) {
                          void handlePreview(t);
                        }
                      }}
                    >
                      <FileCode className="h-4 w-4 text-muted-foreground" />
                      <h3 className="font-semibold text-sm">{t.name}</h3>
                    </div>
                    {hasActions && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canEditTemplate && (
                            <DropdownMenuItem onClick={() => navigate(`/nginx-templates/${t.id}`)}>
                              <Pencil className="h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          {canCloneTemplate && (
                            <DropdownMenuItem onClick={() => handleClone(t.id)}>
                              <Copy className="h-4 w-4" />
                              Clone
                            </DropdownMenuItem>
                          )}
                          {canDeleteTemplate && (
                            <>
                              {(canEditTemplate || canCloneTemplate) && <DropdownMenuSeparator />}
                              <DropdownMenuItem
                                onClick={() => handleDelete(t)}
                                className="text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {t.description || "No description"}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="uppercase">
                      {t.type}
                    </Badge>
                    {t.isBuiltin && <Badge>Built-in</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            message="No config templates."
            actionLabel={hasScope("proxy:templates:create") ? "Create one" : undefined}
            actionHref={hasScope("proxy:templates:create") ? "/nginx-templates/new" : undefined}
          />
        )}
      </div>
      <Dialog open={previewOpen} onOpenChange={onPreviewOpenChange}>
        <DialogContent className="w-[92vw] sm:max-w-[64rem]">
          <DialogHeader>
            <DialogTitle>{previewTemplate?.name ?? "Template Preview"}</DialogTitle>
          </DialogHeader>
          <CodeEditor
            value={previewContent}
            onChange={() => {}}
            readOnly
            language="nginx"
            height={previewEditorHeight}
            lineWrapping={false}
            showGutterBorder={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return content;
  return <PageTransition>{content}</PageTransition>;
}

function TemplateCardsSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
      aria-label="Loading config templates"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="space-y-3 border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-8 w-8" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}
