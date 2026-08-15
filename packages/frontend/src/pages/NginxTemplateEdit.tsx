import { Eye, FlaskConical, HelpCircle, Minus, Plus, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { ProxyHostType, TemplateVariableDef } from "@/types";

const CHEATSHEET_VARIABLES = [
  { name: "{{id}}", description: "Host UUID" },
  { name: "{{serverNames}}", description: "Space-separated domains" },
  { name: "{{upstream}}", description: "scheme://host:port" },
  { name: "{{forwardScheme}}", description: "http or https" },
  { name: "{{forwardHost}}", description: "Upstream hostname" },
  { name: "{{forwardPort}}", description: "Upstream port" },
  { name: "{{sslEnabled}}", description: "Boolean" },
  { name: "{{sslForced}}", description: "Boolean" },
  { name: "{{http2Support}}", description: "Boolean" },
  { name: "{{websocketSupport}}", description: "Boolean" },
  { name: "{{sslCertPath}}", description: "SSL cert file path" },
  { name: "{{sslKeyPath}}", description: "SSL key file path" },
  { name: "{{sslChainPath}}", description: "SSL chain file path" },
  { name: "{{redirectUrl}}", description: "Redirect target URL" },
  { name: "{{redirectStatusCode}}", description: "301/302/307/308" },
  { name: "{{cacheEnabled}}", description: "Boolean" },
  { name: "{{cacheMaxAge}}", description: "Seconds" },
  { name: "{{rateLimitEnabled}}", description: "Boolean" },
  { name: "{{rateLimitRPS}}", description: "Requests/sec" },
  { name: "{{rateLimitBurst}}", description: "Burst size" },
  { name: "{{connectionsPerIp}}", description: "Concurrent connections per client IP" },
  { name: "{{logPath}}", description: "Log file base path" },
  { name: "{{advancedConfig}}", description: "Raw advanced config" },
  { name: "{{#each customHeaders}}", description: "Iterate custom headers" },
  { name: "{{#each customRewrites}}", description: "Iterate rewrite rules" },
  { name: "{{#each accessList.ipRules}}", description: "Iterate access-list IP rules" },
];

const CHEATSHEET_HELPERS = [
  { usage: "{{#if sslEnabled}} ... {{/if}}", description: "Conditional rendering" },
  { usage: "{{#unless sslForced}} ... {{/unless}}", description: "Inverse conditional rendering" },
  { usage: "{{sanitize value}}", description: "Strip dangerous characters from values" },
  { usage: "{{#if (eq a b)}} ... {{/if}}", description: "Equality comparison" },
];

const BUILTIN_TEMPLATE_VARIABLES = new Set([
  "id",
  "serverNames",
  "upstream",
  "forwardScheme",
  "forwardHost",
  "forwardPort",
  "sslEnabled",
  "sslForced",
  "http2Support",
  "websocketSupport",
  "sslCertPath",
  "sslKeyPath",
  "sslChainPath",
  "redirectUrl",
  "redirectStatusCode",
  "cacheEnabled",
  "cacheMaxAge",
  "cacheStale",
  "rateLimitEnabled",
  "rateLimitRPS",
  "rateLimitBurst",
  "connectionsPerIp",
  "customHeaders",
  "customRewrites",
  "accessList",
  "advancedConfig",
  "logPath",
]);

const BUILTIN_TEMPLATE_HELPERS = new Set([
  "if",
  "unless",
  "each",
  "else",
  "sanitize",
  "eq",
  "indent",
]);
const BLOCK_HELPERS = new Set(["if", "unless", "each"]);

function buildLineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function getLineNumber(lineStarts: number[], index: number) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function analyzeTemplateContent(content: string, customVariables: string[]) {
  const lineStarts = buildLineStarts(content);
  const errorLines = new Set<number>();
  const errorRanges: Array<{ from: number; to: number }> = [];
  const blockStack: Array<{ helper: string; line: number }> = [];
  const allowedVariables = new Set([...BUILTIN_TEMPLATE_VARIABLES, ...customVariables]);

  const addErrorLine = (index: number) => {
    errorLines.add(getLineNumber(lineStarts, index));
  };

  const addErrorRange = (from: number, to: number) => {
    if (from < to) errorRanges.push({ from, to });
  };

  const isLiteralToken = (token: string) =>
    /^-?\d+(\.\d+)?$/.test(token) ||
    token === "true" ||
    token === "false" ||
    token === "null" ||
    token === "undefined" ||
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"));

  const validateIdentifier = (token: string, offset: number) => {
    if (!token || isLiteralToken(token)) return;
    if (
      token.startsWith("@") ||
      token === "this" ||
      token.startsWith("this.") ||
      token.startsWith("../")
    ) {
      return;
    }
    const root = token.split(".")[0];
    if (!allowedVariables.has(root)) {
      addErrorRange(offset, offset + token.length);
    }
  };

  const validateExpression = (expr: string, globalStart: number) => {
    const trimmed = expr.trim();
    if (!trimmed) return;

    if (trimmed === "else") {
      if (blockStack.length === 0) addErrorLine(globalStart);
      return;
    }

    if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
      const isClose = trimmed.startsWith("/");
      const helper = trimmed.slice(1).trim().split(/\s+/)[0] || "";
      const helperStart = globalStart + trimmed.indexOf(helper);

      if (!BLOCK_HELPERS.has(helper)) {
        addErrorRange(helperStart, helperStart + helper.length);
        addErrorLine(globalStart);
        return;
      }

      if (isClose) {
        const open = blockStack.at(-1);
        if (!open || open.helper !== helper) {
          addErrorLine(globalStart);
        } else {
          blockStack.pop();
        }
        return;
      }

      blockStack.push({ helper, line: getLineNumber(lineStarts, globalStart) });
      const args = trimmed.slice(trimmed.indexOf(helper) + helper.length).trim();
      validateTokens(args, globalStart + trimmed.indexOf(args));
      return;
    }

    validateTokens(trimmed, globalStart + expr.indexOf(trimmed));
  };

  const validateTokens = (expr: string, globalStart: number) => {
    const matches = Array.from(expr.matchAll(/"[^"]*"|'[^']*'|\([^()]*\)|[^\s]+/g));
    if (matches.length === 0) return;

    const [firstMatch, ...rest] = matches;
    const firstToken = firstMatch[0];
    const firstOffset = globalStart + (firstMatch.index ?? 0);

    if (firstToken.startsWith("(") && firstToken.endsWith(")")) {
      validateTokens(firstToken.slice(1, -1), firstOffset + 1);
    } else if (rest.length === 0) {
      validateIdentifier(firstToken, firstOffset);
    } else if (BUILTIN_TEMPLATE_HELPERS.has(firstToken)) {
      for (const match of rest) {
        const token = match[0];
        const offset = globalStart + (match.index ?? 0);
        if (token.startsWith("(") && token.endsWith(")")) {
          validateTokens(token.slice(1, -1), offset + 1);
        } else {
          validateIdentifier(token, offset);
        }
      }
    } else {
      addErrorRange(firstOffset, firstOffset + firstToken.length);
      for (const match of rest) {
        const token = match[0];
        const offset = globalStart + (match.index ?? 0);
        if (token.startsWith("(") && token.endsWith(")")) {
          validateTokens(token.slice(1, -1), offset + 1);
        } else {
          validateIdentifier(token, offset);
        }
      }
    }
  };

  for (let index = 0; index < content.length; ) {
    const openIndex = content.indexOf("{{", index);
    if (openIndex === -1) break;

    const triple = content.startsWith("{{{", openIndex);
    const closeToken = triple ? "}}}" : "}}";
    const closeIndex = content.indexOf(closeToken, openIndex + (triple ? 3 : 2));
    if (closeIndex === -1) {
      addErrorLine(openIndex);
      break;
    }

    const exprStart = openIndex + (triple ? 3 : 2);
    const expr = content.slice(exprStart, closeIndex);
    validateExpression(expr, exprStart);
    index = closeIndex + closeToken.length;
  }

  for (const dangling of blockStack) {
    errorLines.add(dangling.line);
  }

  return {
    errorLines: Array.from(errorLines).sort((a, b) => a - b),
    errorRanges,
  };
}

export function NginxTemplateEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id;
  const backHref = "/templates/nginx";

  const [isLoading, setIsLoading] = useState(!isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [isBuiltin, setIsBuiltin] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ProxyHostType>("proxy");
  const [content, setContent] = useState("");
  const [variables, setVariables] = useState<TemplateVariableDef[]>([]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [isTesting, setIsTesting] = useState(false);

  const templateDiagnostics = useMemo(
    () =>
      analyzeTemplateContent(
        content,
        variables.map((variable) => variable.name.trim()).filter(Boolean)
      ),
    [content, variables]
  );

  const loadTemplate = useCallback(async () => {
    if (isNew || !id) return;
    setIsLoading(true);
    try {
      const t = await api.getNginxTemplate(id);
      setName(t.name);
      setDescription(t.description || "");
      setType(t.type);
      setContent(t.content);
      setVariables(t.variables || []);
      setIsBuiltin(t.isBuiltin);
    } catch {
      toast.error("Failed to load template");
      navigate(backHref);
    } finally {
      setIsLoading(false);
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  useRealtime(!isNew ? "nginx.template.changed" : null, (payload) => {
    const event = payload as { id?: string; action?: string } | undefined;
    if (!id || (event?.id && event.id !== id)) return;
    if (event?.action === "deleted") {
      toast.error("Template was deleted");
      navigate(backHref);
      return;
    }
    loadTemplate();
  });

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!content.trim()) {
      toast.error("Template content is required");
      return;
    }

    setIsSaving(true);
    try {
      const validVars = variables.filter((v) => v.name.trim());
      if (isNew) {
        const t = await api.createNginxTemplate({
          name,
          description: description || undefined,
          type,
          content,
          variables: validVars,
        });
        toast.success("Template created");
        navigate(`/nginx-templates/${t.id}`, { replace: true });
      } else {
        await api.updateNginxTemplate(id!, {
          name,
          description: description || null,
          content,
          variables: validVars,
        });
        toast.success("Template saved");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewOpen(true);
    setIsPreviewLoading(true);
    try {
      const result = await api.previewNginxTemplate(content);
      setPreviewResult(result.rendered);
    } catch (err) {
      setPreviewResult(`Error: ${err instanceof Error ? err.message : "Preview failed"}`);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await api.testNginxTemplate(content);
      if (result.valid) {
        toast.success("Config test passed");
      } else {
        toast.error(result.errors.join(", ") || "Config test failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setIsTesting(false);
    }
  };

  const updateVariable = (
    index: number,
    patch: Partial<Pick<TemplateVariableDef, "name" | "type" | "default" | "description">>
  ) => {
    setVariables((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const addVariable = () => {
    setVariables((prev) => [...prev, { name: "", type: "string", description: "" }]);
  };

  const removeVariable = (index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  };

  const headerActions = [
    ...(!isBuiltin
      ? [
          {
            id: "template:settings",
            label: "Template settings",
            icon: <Settings2 className="h-4 w-4" />,
            onClick: () => setSettingsOpen(true),
          },
        ]
      : []),
    {
      id: "template:test",
      label: isTesting ? "Testing template" : "Test template",
      icon: <FlaskConical className="h-4 w-4" />,
      disabled: !content.trim() || isTesting,
      onClick: handleTest,
    },
    ...(!isBuiltin
      ? [
          {
            id: "template:save",
            label: isSaving ? "Saving template" : "Save template",
            icon: <Save className="h-4 w-4" />,
            disabled: isSaving || !name.trim() || !content.trim(),
            onClick: handleSave,
          },
        ]
      : []),
    {
      id: "template:preview",
      label: "Preview template",
      icon: <Eye className="h-4 w-4" />,
      disabled: !content.trim(),
      onClick: handlePreview,
      separatorBefore: true,
    },
    {
      id: "template:cheatsheet",
      label: "Variables cheatsheet",
      icon: <HelpCircle className="h-4 w-4" />,
      onClick: () => setCheatsheetOpen(true),
    },
  ];

  if (isLoading) return <NginxTemplateEditorSkeleton />;

  return (
    <PageTransition>
      <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
        <div className="flex min-w-0 shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate(backHref)} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold">
                  {isNew ? "Create Config Template" : name}
                </h1>
                <Badge variant="secondary" size="inline" className="uppercase">
                  {type}
                </Badge>
                {isBuiltin && (
                  <Badge variant="outline" size="inline">
                    Built-in
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {isNew
                  ? "Define a Handlebars nginx server block template"
                  : isBuiltin
                    ? "Built-in template (read-only)"
                    : "Edit nginx config template"}
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions actions={headerActions}>
            {!isBuiltin && (
              <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="h-4 w-4" />
                Settings
              </Button>
            )}
            <Button variant="outline" onClick={handleTest} disabled={!content.trim() || isTesting}>
              <FlaskConical className="h-4 w-4" />
              {isTesting ? "Testing..." : "Test"}
            </Button>
            {!isBuiltin && (
              <Button
                variant="outline"
                onClick={handleSave}
                disabled={isSaving || !name.trim() || !content.trim()}
              >
                <Save className="h-4 w-4" />
                {isSaving ? "Saving..." : "Save"}
              </Button>
            )}
            <Button variant="outline" onClick={handlePreview} disabled={!content.trim()}>
              <Eye className="h-4 w-4" />
              Preview
            </Button>
            <Button variant="outline" onClick={() => setCheatsheetOpen(true)}>
              <HelpCircle className="h-4 w-4" />
              Variables Cheatsheet
            </Button>
          </ResponsiveHeaderActions>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem] shrink-0">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBuiltin}
              placeholder="Template name"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isBuiltin}
              placeholder="Optional description"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Host Type</label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as ProxyHostType)}
              disabled={!isNew}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="proxy">Proxy</SelectItem>
                <SelectItem value="redirect">Redirect</SelectItem>
                <SelectItem value="404">404</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col relative">
          <CodeEditor
            value={content}
            onChange={setContent}
            readOnly={isBuiltin}
            errorLines={templateDiagnostics.errorLines}
            errorRanges={templateDiagnostics.errorRanges}
            showGutterBorder={false}
          />
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex h-[88vh] w-[92vw] flex-col sm:max-w-[58rem]">
          <DialogHeader>
            <DialogTitle>Rendered Preview</DialogTitle>
            <DialogDescription>Preview the template rendered with sample data.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 flex">
            {isPreviewLoading ? (
              <div className="flex-1 min-h-0 border border-border bg-card p-4 text-sm text-muted-foreground">
                Rendering...
              </div>
            ) : (
              <CodeEditor
                value={previewResult}
                onChange={() => {}}
                readOnly
                className="h-full border-border"
                minHeight="0"
                showGutterBorder={false}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cheatsheetOpen} onOpenChange={setCheatsheetOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Template Cheatsheet</DialogTitle>
            <DialogDescription>
              Variables and Handlebars helpers available in nginx templates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Variables</h4>
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="text-left px-3 py-1.5 font-medium">Variable</th>
                      <th className="text-left px-3 py-1.5 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHEATSHEET_VARIABLES.map((item) => (
                      <tr key={item.name} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-1.5 font-mono text-purple-400">{item.name}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{item.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Helpers</h4>
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="text-left px-3 py-1.5 font-medium">Usage</th>
                      <th className="text-left px-3 py-1.5 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHEATSHEET_HELPERS.map((item) => (
                      <tr key={item.usage} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-1.5 font-mono text-purple-400">{item.usage}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{item.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {!isBuiltin && (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="w-[90vw] sm:max-w-[42rem]">
            <DialogHeader>
              <DialogTitle>Template Settings</DialogTitle>
              <DialogDescription>
                Configure custom variables that proxy hosts can fill when using this template.
              </DialogDescription>
            </DialogHeader>
            <div className="border border-border bg-card">
              <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                <div>
                  <h3 className="text-sm font-semibold">Custom Variables</h3>
                  <p className="text-xs text-muted-foreground">
                    Use them inside the template as{" "}
                    <code className="bg-muted px-1">{"{{variableName}}"}</code>.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addVariable}>
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
              <div className="overflow-x-hidden">
                <div className="w-full min-w-0">
                  {variables.length > 0 && (
                    <div className="grid grid-cols-[9rem_7rem_8rem_minmax(0,1fr)_2.25rem] border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider sticky top-0 z-10 bg-card">
                      <div className="px-3 py-2">Variable</div>
                      <div className="px-3 py-2 border-l border-border">Type</div>
                      <div className="px-3 py-2 border-l border-border">Default</div>
                      <div className="px-3 py-2 border-l border-border">Description</div>
                      <div />
                    </div>
                  )}
                  <div>
                    {variables.length > 0 ? (
                      variables.map((variable, index) => (
                        <div
                          key={`variable-${index}`}
                          className="grid grid-cols-[9rem_7rem_8rem_minmax(0,1fr)_2.25rem] border-b border-border last:border-b-0"
                        >
                          <Input
                            value={variable.name}
                            onChange={(e) => updateVariable(index, { name: e.target.value })}
                            placeholder="Variable name"
                            className="h-9 w-36 font-mono text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          />
                          <div className="border-l border-border">
                            <Select
                              value={variable.type}
                              onValueChange={(value) =>
                                updateVariable(index, {
                                  type: value as "string" | "number" | "boolean",
                                })
                              }
                            >
                              <SelectTrigger className="h-9 w-full border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="string">String</SelectItem>
                                <SelectItem value="number">Number</SelectItem>
                                <SelectItem value="boolean">Boolean</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="border-l border-border">
                            {variable.type === "boolean" ? (
                              <Select
                                value={
                                  variable.default === undefined
                                    ? "__none__"
                                    : variable.default
                                      ? "true"
                                      : "false"
                                }
                                onValueChange={(value) =>
                                  updateVariable(index, {
                                    default: value === "__none__" ? undefined : value === "true",
                                  })
                                }
                              >
                                <SelectTrigger className="h-9 w-full border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">None</SelectItem>
                                  <SelectItem value="true">True</SelectItem>
                                  <SelectItem value="false">False</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input
                                value={String(variable.default ?? "")}
                                onChange={(e) =>
                                  updateVariable(index, {
                                    default:
                                      variable.type === "number"
                                        ? e.target.value
                                          ? Number(e.target.value)
                                          : undefined
                                        : e.target.value || undefined,
                                  })
                                }
                                placeholder="Default"
                                className="h-9 w-full text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                              />
                            )}
                          </div>
                          <div className="border-l border-border">
                            <Input
                              value={variable.description || ""}
                              onChange={(e) =>
                                updateVariable(index, { description: e.target.value || undefined })
                              }
                              placeholder="Description"
                              className="h-9 w-full min-w-0 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            />
                          </div>
                          <div className="flex items-center justify-center border-l border-border">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-full rounded-none"
                              onClick={() => removeVariable(index)}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="px-4 py-8 text-sm text-muted-foreground">
                        No custom variables configured.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}

function NginxTemplateEditorSkeleton() {
  return <DetailPageSkeleton label="Loading config template" />;
}
