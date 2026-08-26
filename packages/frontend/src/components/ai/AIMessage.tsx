import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  Box,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FileText,
  Image as ImageIcon,
  Rocket,
  RotateCcw,
  Server,
  ShieldCheck,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AIChangedResources,
  resourceAwareMarkdown,
  resourceMarkdownLinkComponent,
} from "@/lib/ai-resource-links";
import type {
  AIMessageAttachment,
  AIMessage as AIMessageType,
  AIResourceReference,
  AIToolCall,
} from "@/types/ai";
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
  resourceReferences?: AIResourceReference[];
  suppressActivityIndicator?: boolean;
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

const COMMENT_WORD_REVEAL_DELAY_MS = 55;

function useAnimatedCommentContent(
  messageId: string,
  content: string,
  enabled: boolean
): { content: string; chunk: string } {
  const tokens = useMemo(() => content.match(/\S+\s*/gu) ?? (content ? [content] : []), [content]);
  const [reveal, setReveal] = useState(() => ({
    messageId,
    revealed: enabled ? 0 : tokens.length,
    batchStart: 0,
  }));

  useEffect(() => {
    if (reveal.messageId !== messageId) {
      setReveal({
        messageId,
        revealed: enabled ? 0 : tokens.length,
        batchStart: 0,
      });
      return;
    }
    if (!enabled) {
      if (reveal.revealed !== tokens.length || reveal.batchStart !== tokens.length) {
        setReveal({ messageId, revealed: tokens.length, batchStart: tokens.length });
      }
      return;
    }
    if (reveal.revealed >= tokens.length) return;

    const timer = window.setTimeout(() => {
      setReveal((current) => {
        if (current.messageId !== messageId) return current;
        const batchSize = 1 + Math.floor(Math.random() * 3);
        return {
          messageId,
          batchStart: current.revealed,
          revealed: Math.min(tokens.length, current.revealed + batchSize),
        };
      });
    }, COMMENT_WORD_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, messageId, reveal, tokens.length]);

  const revealed = Math.min(reveal.revealed, tokens.length);
  const batchStart = Math.min(reveal.batchStart, revealed);
  return {
    content: tokens.slice(0, revealed).join(""),
    chunk: enabled ? tokens.slice(batchStart, revealed).join("") : "",
  };
}

function stabilizeStreamingHeadings(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^( {0,3})(#{1,6})[\t ]*$/u, "$1\\$2 "))
    .join("\n");
}

function AITimelineDivider({
  icon: Icon,
  children,
  action,
  role,
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert";
}) {
  return (
    <div
      data-ai-timeline-divider
      role={role}
      className="flex w-full items-center gap-3 py-3 text-xs text-muted-foreground"
    >
      <div className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 shrink items-center justify-center gap-1.5 text-center">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{children}</span>
        {action}
      </span>
      <div className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

function isGroupableToolCall(toolCall: AIToolCall): boolean {
  if (toolCall.name === "compact_context" || toolCall.name === "ask_question") return false;
  return (
    toolCall.status === "completed" || toolCall.status === "failed" || toolCall.status === "running"
  );
}

function buildToolCallRenderItems(toolCalls: AIToolCall[]): ToolCallRenderItem[] {
  const items: ToolCallRenderItem[] = [];
  let toolRun: AIToolCall[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 1) {
      items.push({ type: "single", toolCall: toolRun[0] });
    } else if (toolRun.length > 1) {
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
  onEditUserMessage,
  onRetry,
  retryDisabled = false,
  editUserMessageDisabled = false,
  resourceReferences = [],
  suppressActivityIndicator = false,
}: AIMessageProps) {
  const prefersReducedMotion = useReducedMotion();
  const content = typeof message.content === "string" ? message.content : "";
  const animatedCommentEnabled = Boolean(
    message.id?.includes(":comment:") && message.streamingChunk && !prefersReducedMotion
  );
  const animatedComment = useAnimatedCommentContent(
    message.id ?? "",
    content,
    animatedCommentEnabled
  );
  const visibleToolCalls = message.toolCalls?.filter(
    (toolCall) => toolCall.name !== "send_comment"
  );
  const toolCallItems = visibleToolCalls ? buildToolCallRenderItems(visibleToolCalls) : [];
  const hasCompactContextTool =
    visibleToolCalls?.some((tc) => tc.name === "compact_context") ?? false;
  const visibleContent =
    message.compactMarker && hasCompactContextTool ? "" : animatedComment.content;
  const markdownContent = message.isStreaming
    ? stabilizeStreamingHeadings(visibleContent)
    : visibleContent;
  const streamingChunk =
    animatedComment.chunk ||
    (message.isStreaming &&
    message.streamingChunk &&
    visibleContent.endsWith(message.streamingChunk)
      ? message.streamingChunk
      : "");
  const streamingRehypePlugins = useMemo(
    () =>
      streamingChunk
        ? [createStreamingChunkRehypePlugin(markdownContent.length - streamingChunk.length)]
        : [],
    [markdownContent.length, streamingChunk]
  );
  const errorMessage = extractErrorMessage(visibleContent);
  const compactSummary = message.compactMarker ? content : undefined;
  const artifacts = extractArtifactAttachments(visibleToolCalls);
  const showArtifacts = artifacts.length > 0 && !message.isStreaming;
  const availableResourceReferences = useMemo(
    () => mergeResourceReferences(resourceReferences, message.resourceReferences),
    [resourceReferences, message.resourceReferences]
  );
  const assistantMarkdownComponents = useMemo(
    () => ({
      ...markdownComponents,
      a: resourceMarkdownLinkComponent(availableResourceReferences),
      span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
        className?.includes("ai-streaming-chunk") ? (
          <motion.span
            key={`${message.id}:${visibleContent.length}`}
            className={className}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.12, ease: "easeOut" }}
          >
            {children}
          </motion.span>
        ) : (
          <span className={className} {...props}>
            {children}
          </span>
        ),
    }),
    [availableResourceReferences, message.id, prefersReducedMotion, visibleContent.length]
  );

  if (message.conversationStatus) return null;

  if (message.modelChange) {
    const from = message.modelChange.fromDisplayName?.trim() || message.modelChange.fromModel;
    const to = message.modelChange.toDisplayName?.trim() || message.modelChange.toModel;
    return (
      <AITimelineDivider icon={Box}>
        Model changed from {from} to {to}
      </AITimelineDivider>
    );
  }

  if (message.role === "user") {
    // Strip hidden system instructions (e.g. from command palette "Ask AI")
    const displayContent = content
      .replace(/<system-instruction>[\s\S]*?<\/system-instruction>\s*/g, "")
      .trim();
    const ScenarioIcon =
      message.scenario?.icon === "rocket"
        ? Rocket
        : message.scenario?.icon === "refresh"
          ? RotateCcw
          : message.scenario?.icon === "server"
            ? Server
            : message.scenario?.icon === "database"
              ? Database
              : message.scenario?.icon === "shield"
                ? ShieldCheck
                : Activity;
    return (
      <motion.div
        className="group relative flex justify-end"
        initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.15, ease: "easeOut" }}
      >
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
          {message.scenario ? (
            <div className="w-full border border-primary/35 bg-primary px-3 py-2.5 text-primary-foreground">
              <div className="flex items-start gap-2.5">
                <ScenarioIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{message.scenario.title}</p>
                  <p className="mt-0.5 text-xs text-primary-foreground/75">
                    {message.scenario.description}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            displayContent && (
              <div className="break-words bg-primary px-3 py-2 text-sm text-primary-foreground">
                {displayContent}
              </div>
            )
          )}
        </div>
        <div className="absolute right-0 top-full z-10 mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {message.steer && (
            <span>{message.steerPending ? "Steer · waiting for next step" : "Steer"}</span>
          )}
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
      </motion.div>
    );
  }

  if (message.localOnly && !visibleToolCalls?.length) {
    if (!content.trim()) return null;
    if (errorMessage) {
      return (
        <AITimelineDivider
          icon={CircleAlert}
          role="alert"
          action={
            onRetry ? (
              <button
                type="button"
                className="shrink-0 font-medium text-primary transition-colors hover:text-primary/80 hover:underline disabled:pointer-events-none disabled:opacity-40"
                onClick={onRetry}
                disabled={retryDisabled}
              >
                Retry
              </button>
            ) : undefined
          }
        >
          <span className="font-medium text-foreground">Error:</span> {errorMessage}
        </AITimelineDivider>
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
  const hasToolCalls = !!visibleToolCalls?.length;
  const allToolsDone =
    hasToolCalls &&
    visibleToolCalls!.every(
      (tc) => tc.status === "completed" || tc.status === "failed" || tc.status === "rejected"
    );
  const hasError = errorMessage !== null;

  const hasActiveQuestion =
    hasToolCalls &&
    visibleToolCalls!.some(
      (tc) =>
        tc.name === "ask_question" &&
        (tc.status === "awaiting_approval" || tc.status === "running") &&
        !hasQuestionAnswer(tc)
    );
  const hasPendingApproval =
    hasToolCalls &&
    visibleToolCalls!.some((tc) => tc.name !== "ask_question" && tc.status === "awaiting_approval");
  const hasRunningTool =
    hasToolCalls &&
    visibleToolCalls!.some((tc) => tc.name !== "ask_question" && tc.status === "running");
  const isLiveComment = message.id.includes(":comment:") && Boolean(message.isStreaming);

  // Show thinking when:
  // 1. Streaming with nothing yet (initial)
  // 2. Streaming after all tools completed, waiting for next response
  // 3. Streaming progress comments after the comment text has been emitted
  const isThinking =
    message.isStreaming &&
    !hasError &&
    !hasActiveQuestion &&
    !hasPendingApproval &&
    (isLiveComment ||
      hasRunningTool ||
      (!hasContent && !hasToolCalls) ||
      (allToolsDone && !hasContent));
  const isRetrying = message.isStreaming && hasError;
  const activityLabel = isRetrying
    ? "Retrying"
    : hasActiveQuestion
      ? "Waiting for response"
      : hasPendingApproval
        ? "Waiting for approval"
        : isThinking
          ? "Thinking"
          : null;

  return (
    <div className={assistantMaxWidthClass}>
      <div className="text-sm">
        {/* Tool calls rendered first */}
        {hasToolCalls && (
          <div className="space-y-0.5">
            {toolCallItems.map((item) => (
              <ToolCallEntrance key={item.type === "single" ? item.toolCall.id : item.key}>
                {item.type === "single" ? (
                  <AIToolCallBlock
                    toolCall={item.toolCall}
                    compactSummary={compactSummary}
                  />
                ) : (
                  <ToolCallsGroup toolCalls={item.toolCalls} />
                )}
              </ToolCallEntrance>
            ))}
          </div>
        )}

        {/* Text content */}
        {hasContent && (
          <div className="prose dark:prose-invert !max-w-none break-words text-sm prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 prose-table:my-0 prose-code:text-xs prose-pre:text-xs prose-pre:rounded-none prose-code:rounded-none prose-code:before:content-none prose-code:after:content-none [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={streamingRehypePlugins}
              components={assistantMarkdownComponents}
            >
              {resourceAwareMarkdown(markdownContent, availableResourceReferences)}
            </Markdown>
          </div>
        )}

        <AIChangedResources references={message.changedResourceReferences ?? []} />

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
        {!suppressActivityIndicator && activityLabel && (
          <AIActivityIndicator label={activityLabel} />
        )}
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
  const [expanded, setExpanded] = useState(() => toolGroupExpansionPreference(toolCalls) === true);
  const [renderContent, setRenderContent] = useState(expanded);
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

  useEffect(() => {
    const preference = toolGroupExpansionPreference(toolCalls);
    if (preference === null) return;
    setExpanded(preference);
    if (preference) setRenderContent(true);
    setToolGroupExpansionPreference(toolCalls, preference);
  }, [toolCalls]);

  useEffect(() => {
    if (expanded || !renderContent) return;
    const timeout = window.setTimeout(() => setRenderContent(false), 160);
    return () => window.clearTimeout(timeout);
  }, [expanded, renderContent]);

  return (
    <div className="my-0.5 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => {
            const next = !value;
            if (next) setRenderContent(true);
            setToolGroupExpansionPreference(toolCalls, next);
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
          {renderContent ? (
            <div className="py-1">
              {toolCalls.map((toolCall) => (
                <ToolCallEntrance key={toolCall.id}>
                  <AIToolCallBlock toolCall={toolCall} />
                </ToolCallEntrance>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ToolCallEntrance({ children }: { children: ReactNode }) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      data-ai-tool-entry
      initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.15, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

const toolGroupExpansionPreferences = new Map<string, boolean>();

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function toolGroupExpansionPreference(toolCalls: AIToolCall[]): boolean | null {
  const preferences = toolCalls.flatMap((toolCall) => {
    const preference = toolGroupExpansionPreferences.get(toolCall.id);
    return preference === undefined ? [] : [preference];
  });
  if (preferences.includes(false)) return false;
  if (preferences.includes(true)) return true;
  return null;
}

function setToolGroupExpansionPreference(toolCalls: AIToolCall[], expanded: boolean): void {
  for (const toolCall of toolCalls) {
    toolGroupExpansionPreferences.set(toolCall.id, expanded);
  }
}

export function AIActivityIndicator({ label }: { label: string }) {
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

interface StreamingHastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: StreamingHastNode[];
}

function createStreamingChunkRehypePlugin(chunkStartOffset: number) {
  return () => (tree: StreamingHastNode) => {
    wrapStreamingTextNodes(tree, chunkStartOffset);
  };
}

function wrapStreamingTextNodes(parent: StreamingHastNode, chunkStartOffset: number): void {
  if (!parent.children) return;
  const nextChildren: StreamingHastNode[] = [];

  for (const child of parent.children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      wrapStreamingTextNodes(child, chunkStartOffset);
      nextChildren.push(child);
      continue;
    }

    const startOffset = child.position?.start?.offset;
    const endOffset = child.position?.end?.offset;
    if (startOffset === undefined || endOffset === undefined || endOffset <= chunkStartOffset) {
      nextChildren.push(child);
      continue;
    }

    const splitAt = Math.max(0, Math.min(child.value.length, chunkStartOffset - startOffset));
    if (splitAt > 0) {
      nextChildren.push({ ...child, value: child.value.slice(0, splitAt) });
    }
    nextChildren.push({
      type: "element",
      tagName: "span",
      properties: { className: ["ai-streaming-chunk"] },
      children: [{ ...child, value: child.value.slice(splitAt) }],
    });
  }

  parent.children = nextChildren;
}

function mergeResourceReferences(
  conversationReferences: AIResourceReference[],
  messageReferences: AIResourceReference[] | undefined
): AIResourceReference[] {
  const merged = new Map(
    (messageReferences ?? []).map((reference) => [reference.refId, reference])
  );
  for (const current of conversationReferences) {
    const historical = merged.get(current.refId);
    if (!historical) {
      merged.set(current.refId, current);
      continue;
    }
    const label = isFallbackReferenceLabel(historical) ? current.label : historical.label;
    merged.set(current.refId, {
      ...current,
      ...historical,
      label,
      nodeId: historical.nodeId || current.nodeId,
      nodeSlug: historical.nodeSlug || current.nodeSlug,
      slug: historical.slug || current.slug,
      appearanceColor: current.appearanceColor ?? historical.appearanceColor,
    });
  }
  return [...merged.values()];
}

function isFallbackReferenceLabel(reference: AIResourceReference): boolean {
  const label = reference.label.trim();
  return (
    !label ||
    label === reference.resourceId ||
    (reference.type === "docker_container" && /^[a-f0-9]{12,64}$/i.test(label))
  );
}
