import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import type { AIMessageAttachment, AIMessage as AIMessageType, AIToolCall } from "@/types/ai";
import { AIToolCallBlock } from "./AIToolCallBlock";

interface AIMessageProps {
  message: AIMessageType;
  assistantMaxWidthClass?: string;
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onAnswer?: (toolCallId: string, answer: string) => void;
  onEditUserMessage?: (
    messageId: string,
    content: string,
    attachments: AIMessageAttachment[]
  ) => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
  editUserMessageDisabled?: boolean;
}

type ToolCallRenderItem =
  | { type: "single"; toolCall: AIToolCall }
  | { type: "tool-group"; key: string; toolCalls: AIToolCall[] };

interface ArtifactAttachment {
  artifactId?: string;
  filename: string;
  mediaType?: string;
  sizeBytes: number;
  sourcePath?: string;
  downloadUrl: string;
}

type ArtifactPreviewKind = "image" | "text" | null;

function isGroupableToolCall(toolCall: AIToolCall): boolean {
  if (toolCall.name === "compact_context") return false;
  return (
    toolCall.status === "completed" || toolCall.status === "failed" || toolCall.status === "running"
  );
}

function buildToolCallRenderItems(toolCalls: AIToolCall[]): ToolCallRenderItem[] {
  const items: ToolCallRenderItem[] = [];
  let toolRun: AIToolCall[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 1 && toolRun[0].status !== "running") {
      items.push({ type: "single", toolCall: toolRun[0] });
    } else if (toolRun.length > 1) {
      items.push({ type: "tool-group", key: toolRun[0].id, toolCalls: toolRun });
    } else if (toolRun.length === 1) {
      items.push({ type: "tool-group", key: toolRun[0].id, toolCalls: toolRun });
    }
    toolRun = [];
  };

  for (const toolCall of toolCalls) {
    if (isGroupableToolCall(toolCall)) {
      toolRun.push(toolCall);
      continue;
    }

    flushToolRun();
    items.push({ type: "single", toolCall });
  }

  flushToolRun();
  return items;
}

export function AIMessage({
  message,
  assistantMaxWidthClass = "max-w-[95%]",
  onApprove,
  onReject,
  onAnswer,
  onEditUserMessage,
  onRetry,
  retryDisabled = false,
  editUserMessageDisabled = false,
}: AIMessageProps) {
  const content = typeof message.content === "string" ? message.content : "";
  const toolCallItems = message.toolCalls ? buildToolCallRenderItems(message.toolCalls) : [];
  const hasCompactContextTool =
    message.toolCalls?.some((tc) => tc.name === "compact_context") ?? false;
  const visibleContent = message.compactMarker && hasCompactContextTool ? "" : content;
  const errorMessage = extractErrorMessage(visibleContent);
  const compactSummary = message.compactMarker ? content : undefined;
  const artifacts = extractArtifactAttachments(message.toolCalls);
  const showArtifacts = artifacts.length > 0 && !message.isStreaming;

  if (message.conversationStatus) return null;

  if (message.role === "user") {
    // Strip hidden system instructions (e.g. from command palette "Ask AI")
    const displayContent = content
      .replace(/<system-instruction>[\s\S]*?<\/system-instruction>\s*/g, "")
      .trim();
    return (
      <div className="group relative flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1.5">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {message.attachments.map((attachment) => (
                <button
                  key={attachment.artifactId}
                  type="button"
                  className="h-16 w-16 overflow-hidden border border-border bg-muted transition-colors hover:border-foreground"
                  onClick={() => openArtifactPreview(attachment)}
                  aria-label={`Preview ${attachment.filename}`}
                >
                  <img
                    src={attachment.downloadUrl}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
          {displayContent && (
            <div className="break-words bg-primary px-3 py-2 text-sm text-primary-foreground">
              {displayContent}
            </div>
          )}
        </div>
        <div className="absolute right-0 top-full z-10 mt-1 flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <span className="whitespace-nowrap">{formatMessageRelativeTime(message)}</span>
          {onEditUserMessage && (
            <button
              type="button"
              onClick={() =>
                onEditUserMessage(message.id, displayContent, message.attachments ?? [])
              }
              disabled={editUserMessageDisabled}
              className="flex h-5 w-5 items-center justify-center transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-35"
              aria-label="Edit message"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (message.localOnly && !message.toolCalls?.length) {
    if (!content.trim()) return null;
    if (errorMessage) {
      return (
        <div className={assistantMaxWidthClass}>
          <div
            role="alert"
            className="flex w-fit max-w-full items-center gap-3 border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
          >
            <span className="min-w-0 break-words">
              <span className="font-medium text-foreground">Error:</span> {errorMessage}
            </span>
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5"
                onClick={onRetry}
                disabled={retryDisabled}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      </div>
    );
  }

  const hasContent = !!visibleContent;
  const hasToolCalls = !!message.toolCalls?.length;
  const allToolsDone =
    hasToolCalls &&
    message.toolCalls!.every(
      (tc) => tc.status === "completed" || tc.status === "failed" || tc.status === "rejected"
    );
  const hasError = errorMessage !== null;

  const hasActiveQuestion =
    hasToolCalls &&
    message.toolCalls!.some(
      (tc) =>
        tc.name === "ask_question" && tc.status === "awaiting_approval" && !hasQuestionAnswer(tc)
    );
  const isLiveComment = message.id.includes(":comment:") && Boolean(message.isStreaming);

  // Show thinking when:
  // 1. Streaming with nothing yet (initial)
  // 2. Streaming after all tools completed, waiting for next response
  // 3. Streaming progress comments after the comment text has been emitted
  const isThinking =
    message.isStreaming &&
    !hasError &&
    !hasActiveQuestion &&
    (isLiveComment || (!hasContent && !hasToolCalls) || (allToolsDone && !hasContent));
  const isRetrying = message.isStreaming && hasError;

  return (
    <div className={assistantMaxWidthClass}>
      <div className="text-sm">
        {/* Tool calls rendered first */}
        {hasToolCalls && (
          <div className="space-y-0.5">
            {toolCallItems.map((item) =>
              item.type === "single" ? (
                <AIToolCallBlock
                  key={item.toolCall.id}
                  toolCall={item.toolCall}
                  onApprove={onApprove}
                  onReject={onReject}
                  onAnswer={onAnswer}
                  compactSummary={compactSummary}
                />
              ) : (
                <ToolCallsGroup key={item.key} toolCalls={item.toolCalls} />
              )
            )}
          </div>
        )}

        {/* Text content */}
        {hasContent && (
          <div className="prose dark:prose-invert !max-w-none break-words text-sm prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 prose-table:my-0 prose-code:text-xs prose-pre:text-xs prose-pre:rounded-none prose-code:rounded-none prose-code:before:content-none prose-code:after:content-none [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {visibleContent}
            </Markdown>
          </div>
        )}

        {showArtifacts && (
          <div className="mt-3 flex flex-wrap gap-2">
            {artifacts.map((artifact) => (
              <ArtifactAttachmentCard
                key={artifact.artifactId ?? artifact.downloadUrl}
                artifact={artifact}
              />
            ))}
          </div>
        )}

        {/* Status indicators */}
        {isThinking && <ThinkingIndicator label="Thinking" />}
        {isRetrying && <ThinkingIndicator label="Retrying" />}
        {hasActiveQuestion && <ThinkingIndicator label="Waiting for response" />}
      </div>
    </div>
  );
}

function extractErrorMessage(content: string): string | null {
  const match = content.trim().match(/^\*\*Error:\*\*\s*([\s\S]+)$/i);
  return match?.[1]?.trim() || null;
}

function hasQuestionAnswer(toolCall: AIToolCall): boolean {
  if (!toolCall.result || typeof toolCall.result !== "object") return false;
  return typeof (toolCall.result as { answer?: unknown }).answer === "string";
}

function openArtifactPreview(attachment: AIMessageAttachment | ArtifactAttachment) {
  const artifactId =
    "artifactId" in attachment && typeof attachment.artifactId === "string"
      ? attachment.artifactId
      : undefined;
  if (!artifactId) {
    window.open(attachment.downloadUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const params = new URLSearchParams({ filename: attachment.filename });
  if (attachment.mediaType) params.set("mediaType", attachment.mediaType);
  const url = `/ai/artifact/${encodeURIComponent(artifactId)}?${params.toString()}`;
  window.open(url, `artifact-${artifactId}`, "width=900,height=600,menubar=no,toolbar=no");
}

function formatMessageRelativeTime(message: AIMessageType): string {
  const value = message.createdAt ?? timestampFromGeneratedId(message.id);
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return "now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timestampFromGeneratedId(id: string | undefined): string | null {
  if (!id) return null;
  const timestamp = Number(id.split("-")[0]);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
}

function extractArtifactAttachments(toolCalls: AIToolCall[] | undefined): ArtifactAttachment[] {
  if (!toolCalls?.length) return [];
  const artifacts: ArtifactAttachment[] = [];
  const seen = new Set<string>();

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "send_artifact" || toolCall.status !== "completed") continue;
    const artifact = parseArtifactAttachment(toolCall.result);
    if (!artifact || seen.has(artifact.downloadUrl)) continue;
    seen.add(artifact.downloadUrl);
    artifacts.push(artifact);
  }

  return artifacts;
}

function parseArtifactAttachment(value: unknown): ArtifactAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.downloadUrl !== "string" ||
    typeof record.filename !== "string" ||
    typeof record.sizeBytes !== "number"
  ) {
    return null;
  }
  return {
    artifactId: typeof record.artifactId === "string" ? record.artifactId : undefined,
    filename: record.filename,
    mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
    sizeBytes: record.sizeBytes,
    sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : undefined,
    downloadUrl: record.downloadUrl,
  };
}

function ArtifactAttachmentCard({ artifact }: { artifact: ArtifactAttachment }) {
  const previewKind = getArtifactPreviewKind(artifact);
  const canPreview = previewKind !== null;
  const Icon = previewKind === "image" ? ImageIcon : FileText;

  const openPreview = () => {
    if (canPreview) {
      openArtifactPreview(artifact);
      return;
    }
    window.open(artifact.downloadUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="group relative aspect-square w-28 overflow-hidden border border-border bg-muted transition-colors hover:border-foreground hover:bg-muted/80">
      <button
        type="button"
        onClick={openPreview}
        className="relative flex h-full w-full min-w-0 items-center justify-center text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={canPreview ? `Preview ${artifact.filename}` : `Open ${artifact.filename}`}
      >
        {previewKind === "image" ? (
          <img
            src={artifact.downloadUrl}
            alt={artifact.filename}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon className="h-6 w-6 text-muted-foreground" />
        )}
        <span className="absolute inset-x-0 bottom-0 grid min-w-0 grid-cols-[minmax(0,1fr)_0px] items-center gap-0 bg-gradient-to-t from-muted via-muted/90 to-transparent px-2 pb-1.5 pt-6 transition-[grid-template-columns,gap] duration-150 ease-out group-hover:grid-cols-[minmax(0,1fr)_24px] group-hover:gap-1">
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium leading-snug text-foreground">
              {artifact.filename}
            </span>
            <span className="block truncate text-[11px] leading-snug text-muted-foreground">
              {[formatBytes(artifact.sizeBytes), artifact.mediaType].filter(Boolean).join(" · ")}
            </span>
          </span>
          <a
            href={artifact.downloadUrl}
            download={artifact.filename}
            onClick={(event) => event.stopPropagation()}
            className="flex h-6 w-6 items-center justify-center overflow-hidden text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground group-hover:opacity-100"
            aria-label={`Download ${artifact.filename}`}
          >
            <Download className="h-4.5 w-4.5" />
          </a>
        </span>
      </button>
    </div>
  );
}

function getArtifactPreviewKind(artifact: ArtifactAttachment): ArtifactPreviewKind {
  const mediaType = artifact.mediaType?.toLowerCase() ?? "";
  const extension = artifact.filename.toLowerCase().split(".").pop() ?? "";

  if (mediaType.startsWith("image/") || IMAGE_PREVIEW_EXTENSIONS.has(extension)) return "image";
  if (
    mediaType.startsWith("text/") ||
    CODE_PREVIEW_MEDIA_TYPES.has(mediaType) ||
    TEXT_PREVIEW_EXTENSIONS.has(extension)
  ) {
    return "text";
  }

  return null;
}

const IMAGE_PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg", "gif"]);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "ini",
  "conf",
  "cfg",
  "cnf",
  "yaml",
  "yml",
  "json",
  "jsonl",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "xml",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "php",
  "sql",
  "log",
  "env",
  "pem",
  "crt",
  "csr",
  "key",
  "toml",
  "dockerfile",
]);
const CODE_PREVIEW_MEDIA_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ToolCallsGroup({ toolCalls }: { toolCalls: AIToolCall[] }) {
  const groupKey = toolCalls[0]?.id ?? "tool-group";
  const [expanded, setExpanded] = useState(() => wasToolGroupExpanded(groupKey));
  const [showWaiting, setShowWaiting] = useState(false);
  const failedCount = toolCalls.filter((toolCall) => toolCall.status === "failed").length;
  const waitingCount = toolCalls.filter((toolCall) => toolCall.status === "running").length;
  const hasWaiting = waitingCount > 0;
  const labelParts = [`Called ${toolCalls.length} ${pluralize("tool", toolCalls.length)}`];
  if (failedCount > 0) labelParts.push(`${failedCount} failed`);
  if (showWaiting && waitingCount > 0) labelParts.push(`${waitingCount} waiting`);
  const groupLabel = labelParts.join(", ");

  useEffect(() => {
    if (!hasWaiting) {
      setShowWaiting(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowWaiting(true), 50);
    return () => window.clearTimeout(timeout);
  }, [hasWaiting]);

  return (
    <div className="my-0.5 text-sm">
      <button
        type="button"
        onClick={() => {
          setExpanded((value) => {
            const next = !value;
            setToolGroupExpanded(groupKey, next);
            return next;
          });
        }}
        className="group flex cursor-pointer items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
      >
        <TerminalSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className={`truncate ${showWaiting ? "thinking-shimmer" : ""}`}>{groupLabel}</span>
        {expanded ? (
          <ChevronDown className="-ml-1 h-3 w-3 shrink-0 opacity-70 transition-opacity" />
        ) : (
          <ChevronRight className="-ml-1 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
        )}
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="py-1">
            {toolCalls.map((toolCall) => (
              <AIToolCallBlock key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const expandedToolGroupKeys = new Set<string>();

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function wasToolGroupExpanded(groupKey: string): boolean {
  if (expandedToolGroupKeys.has(groupKey)) return true;
  for (const expandedKey of expandedToolGroupKeys) {
    if (groupKey.startsWith(`${expandedKey}:`)) return true;
  }
  return false;
}

function setToolGroupExpanded(groupKey: string, expanded: boolean): void {
  if (expanded) {
    expandedToolGroupKeys.add(groupKey);
  } else {
    expandedToolGroupKeys.delete(groupKey);
    for (const expandedKey of Array.from(expandedToolGroupKeys)) {
      if (expandedKey.startsWith(`${groupKey}:`)) expandedToolGroupKeys.delete(expandedKey);
    }
  }
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground">
      <span className="thinking-shimmer">{label}</span>
    </div>
  );
}

const markdownComponents = {
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className="overflow-x-auto border border-border bg-muted p-2 text-foreground" {...props}>
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={`${className} text-foreground`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="break-words bg-muted px-1 py-0.5 text-xs text-foreground" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="my-3 overflow-x-auto border border-border bg-background">
      <table
        className="min-w-full text-sm [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-2 [&_td]:py-1.5 [&_td]:border-t [&_td]:border-border"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  a: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary underline" target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};
