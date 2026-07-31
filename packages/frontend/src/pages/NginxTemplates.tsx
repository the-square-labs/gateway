import { Copy, FileCode, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageTransition } from "@/components/common/PageTransition";
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
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { NginxTemplate } from "@/types";

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

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold">Config Templates</h1>
              <p className="text-sm text-muted-foreground">
                Nginx server block templates for proxy hosts
              </p>
            </div>
            {hasScope("proxy:templates:create") && (
              <Button onClick={() => navigate("/nginx-templates/new")}>
                <Plus className="h-4 w-4" />
                Create Template
              </Button>
            )}
          </div>
        )}

        {templates.length > 0 ? (
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
        <DialogContent className="w-[92vw] sm:max-w-[64rem] h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{previewTemplate?.name ?? "Template Preview"}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <CodeEditor
              value={previewContent}
              onChange={() => {}}
              readOnly
              language="nginx"
              height="100%"
              minHeight="100%"
              showGutterBorder={false}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return content;
  return <PageTransition>{content}</PageTransition>;
}
