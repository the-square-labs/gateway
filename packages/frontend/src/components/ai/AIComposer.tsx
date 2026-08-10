import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Check, ChevronDown, Play, Plus, Square, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AI_APPROVAL_MODE_META,
  AI_APPROVAL_MODES,
  type AIApprovalMode,
} from "@/lib/ai-approval-mode";
import { cn } from "@/lib/utils";
import { type AIContextUsage, getAIContextUsage, useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import type {
  AIComposerAttachment,
  AIInferenceModelOption,
  AIMessage as AIMessageType,
  PageContext,
} from "@/types/ai";
import { AIContextUsageDialog } from "./AIContextUsageDialog";
import { AIProviderControls } from "./AIProviderControls";
import { InferenceQuotaStatus, useInferenceQuota } from "./InferenceQuotaStatus";
import { getComposerAttachmentId, getComposerAttachmentPreviewUrl } from "./useAIComposerDraft";

export interface AISlashCommand {
  name: string;
  description: string;
}

interface AIComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onContinue?: () => void;
  onStop: () => void;
  onSlashCommandSelect: (command: AISlashCommand) => void;
  slashResults: AISlashCommand[];
  slashIndex: number;
  messages: AIMessageType[];
  context?: PageContext;
  conversationId?: string | null;
  isStreaming: boolean;
  isConnected: boolean;
  canContinue?: boolean;
  stopDisabled?: boolean;
  retryAfter?: number | null;
  approvalMode: AIApprovalMode;
  approvalModeLabel: string;
  setApprovalMode: (mode: AIApprovalMode) => void | Promise<void>;
  modelOptions?: AIInferenceModelOption[];
  selectedModel?: string | null;
  onModelChange?: (model: string) => void | Promise<void>;
  reasoningOptions?: string[];
  selectedReasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string) => void | Promise<void>;
  gatewayInferenceMode?: boolean;
  attachments?: AIComposerAttachment[];
  canAttachImages?: boolean;
  uploadingAttachments?: boolean;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (attachmentId: string) => void;
  onPreviewAttachment?: (attachment: AIComposerAttachment) => void;
  maxRows?: number;
  className?: string;
  surfaceClassName?: string;
  slashPaletteClassName?: string;
  showDisclaimer?: boolean;
}

const MAX_IMAGE_ATTACHMENTS = 3;

function ContextRing({ usage }: { usage: AIContextUsage | null }) {
  const percent = Math.max(0, Math.min(100, usage?.percent ?? 0));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * percent) / 100;

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center text-muted-foreground focus-visible:outline-none"
          aria-label="Context usage"
        >
          <svg className="h-4 w-4 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              strokeWidth="3"
              className="stroke-border"
            />
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="stroke-muted-foreground transition-[stroke-dashoffset]"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="w-64 p-3 text-xs">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Context</span>
            <span className="font-mono">
              {usage
                ? `${usage.estimatedTokens.toLocaleString()} / ${usage.limit.toLocaleString()}`
                : "Loading..."}
            </span>
          </div>
          {usage && (
            <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Used</span>
                <span>{usage.percent}%</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Messages</span>
                <span>{usage.messageCount}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">System</span>
                <span>{usage.systemTokens.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Tools</span>
                <span>{usage.toolsTokens.toLocaleString()}</span>
              </div>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function AIComposer({
  textareaRef,
  input,
  onInputChange,
  onKeyDown,
  onSend,
  onContinue,
  onStop,
  onSlashCommandSelect,
  slashResults,
  slashIndex,
  messages,
  context,
  conversationId,
  isStreaming,
  isConnected,
  canContinue = false,
  stopDisabled = false,
  retryAfter,
  approvalMode,
  approvalModeLabel,
  setApprovalMode,
  modelOptions = [],
  selectedModel,
  onModelChange,
  reasoningOptions = [],
  selectedReasoningEffort,
  onReasoningEffortChange,
  gatewayInferenceMode = false,
  attachments = [],
  canAttachImages = false,
  uploadingAttachments = false,
  onAttachFiles,
  onRemoveAttachment,
  onPreviewAttachment,
  className,
  surfaceClassName,
  slashPaletteClassName,
  showDisclaimer = false,
}: AIComposerProps) {
  const modeMeta = AI_APPROVAL_MODE_META[approvalMode];
  const ModeIcon = modeMeta.icon;
  const [usage, setUsage] = useState<AIContextUsage | null>(null);
  const [updatingProvider, setUpdatingProvider] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextUsageDialog = useAIStore((state) => state.contextUsageDialog);
  const closeContextUsageDialog = useAIStore((state) => state.closeContextUsageDialog);
  const canViewInferenceUsage = useAuthStore((state) =>
    state.hasScope("inference:usage:view:self")
  );

  useEffect(() => {
    let active = true;
    void getAIContextUsage(
      messages,
      context,
      conversationId,
      selectedModel,
      selectedReasoningEffort
    ).then((nextUsage) => {
      if (active) setUsage(nextUsage);
    });
    return () => {
      active = false;
    };
  }, [context, conversationId, messages, selectedModel, selectedReasoningEffort]);

  const inferenceQuota = useInferenceQuota({
    enabled: gatewayInferenceMode && canViewInferenceUsage,
    isStreaming,
  });
  const disabled = !isConnected || !!retryAfter;
  const hasDraft = input.trim().length > 0 || attachments.length > 0;
  const canResume = !hasDraft && canContinue && Boolean(onContinue) && !disabled;

  const changeModel = async (model: string) => {
    if (!onModelChange || model === selectedModel || updatingProvider) return;
    if (conversationId && messages.length > 0) {
      const accepted = await confirm({
        title: "Change model?",
        description:
          "Changing the model during a conversation may increase costs and reduce performance.",
        confirmLabel: "Change model",
        cancelLabel: "Cancel",
        cancelVariant: "ghost",
      });
      if (!accepted) return;
    }
    setUpdatingProvider(true);
    try {
      await onModelChange(model);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change model");
    } finally {
      setUpdatingProvider(false);
    }
  };

  const changeReasoningEffort = async (effort: string) => {
    if (!onReasoningEffortChange || effort === selectedReasoningEffort || updatingProvider) return;
    setUpdatingProvider(true);
    try {
      await onReasoningEffortChange(effort);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change reasoning effort");
    } finally {
      setUpdatingProvider(false);
    }
  };

  const attachFiles = (files: FileList | File[] | null) => {
    if (!canAttachImages || !files || !onAttachFiles) return;
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (images.length + attachments.length > MAX_IMAGE_ATTACHMENTS) {
      toast.error(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
      return;
    }
    if (images.length > 0) void onAttachFiles(images);
  };

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(event) => {
        if (!canAttachImages) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!canAttachImages) return;
        event.preventDefault();
        attachFiles(event.dataTransfer.files);
      }}
    >
      <AIContextUsageDialog usage={contextUsageDialog} onClose={closeContextUsageDialog} />

      <AnimatePresence>
        {!inferenceQuota.exhausted && slashResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className={cn(
              "absolute bottom-full left-0 right-0 z-10 -mb-px border border-border bg-background shadow-md",
              slashPaletteClassName
            )}
          >
            {slashResults.map((command, index) => (
              <button
                key={command.name}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  index === slashIndex ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (isStreaming) return;
                  onSlashCommandSelect(command);
                }}
              >
                <span className="font-mono text-muted-foreground">/{command.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground/60">
                  {command.description}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <InferenceQuotaStatus quota={inferenceQuota} exhaustedClassName={surfaceClassName} />

      {!inferenceQuota.exhausted && (
        <div
          className={cn(
            "flex flex-col border border-border bg-muted/30 transition-colors",
            surfaceClassName
          )}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachments.map((attachment) => (
                <button
                  key={getComposerAttachmentId(attachment)}
                  type="button"
                  className="group relative h-16 w-16 overflow-hidden border border-border bg-muted transition-colors hover:border-foreground"
                  onClick={() => onPreviewAttachment?.(attachment)}
                  aria-label={`Preview ${attachment.filename}`}
                >
                  <img
                    src={getComposerAttachmentPreviewUrl(attachment)}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute inset-0 bg-background/0 transition-colors group-hover:bg-background/30" />
                  <span
                    role="button"
                    tabIndex={-1}
                    className="absolute inset-0 flex items-center justify-center bg-background/45 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveAttachment?.(getComposerAttachmentId(attachment));
                    }}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    <X className="h-7 w-7" />
                  </span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={(event) => attachFiles(event.clipboardData.files)}
            placeholder={isStreaming ? "AI is responding..." : "Ask anything... (/ commands)"}
            disabled={disabled}
            rows={1}
            className="block min-h-[42px] resize-none border-0 bg-transparent px-3 pb-1.5 pt-3 pr-3 leading-5 focus-visible:ring-0"
          />
          <div className="-mt-1 flex min-h-10 items-center gap-1 px-2 pb-2">
            <div className="min-w-0 shrink">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex h-8 max-w-[15rem] items-center gap-2 px-1.5 text-sm transition-colors focus-visible:outline-none",
                      approvalMode === "bypass-everything"
                        ? "text-warning-foreground hover:text-warning focus-visible:text-warning"
                        : "text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                    )}
                    title={approvalModeLabel}
                    aria-label={approvalModeLabel}
                  >
                    <ModeIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{modeMeta.label}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-60">
                  {AI_APPROVAL_MODES.map((mode) => {
                    const item = AI_APPROVAL_MODE_META[mode];
                    const ItemIcon = item.icon;
                    return (
                      <DropdownMenuItem key={mode} onClick={() => void setApprovalMode(mode)}>
                        <ItemIcon className="h-4 w-4" />
                        <span>{item.menuLabel}</span>
                        {approvalMode === mode && <Check className="ml-auto h-4 w-4" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <AIProviderControls
              modelOptions={modelOptions}
              selectedModel={selectedModel}
              onModelChange={onModelChange ? changeModel : undefined}
              reasoningOptions={reasoningOptions}
              selectedReasoningEffort={selectedReasoningEffort}
              onReasoningEffortChange={onReasoningEffortChange ? changeReasoningEffort : undefined}
              disabled={isStreaming || updatingProvider}
            />

            <div className="flex shrink-0 items-center">
              {canAttachImages && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      attachFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAttachments || disabled}
                    aria-label="Attach images"
                    title="Attach images"
                  >
                    {uploadingAttachments ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                  </button>
                </>
              )}
              <ContextRing usage={usage} />
              <button
                type="button"
                className={cn(
                  "flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30",
                  canResume && "text-foreground"
                )}
                onClick={isStreaming ? onStop : canResume ? onContinue : onSend}
                disabled={isStreaming ? stopDisabled : (!hasDraft && !canResume) || disabled}
                aria-label={
                  isStreaming ? "Stop response" : canResume ? "Continue response" : "Send message"
                }
              >
                {isStreaming ? (
                  <Square className="h-4 w-4" />
                ) : canResume ? (
                  <Play className="h-4 w-4 fill-current" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {showDisclaimer && !inferenceQuota.exhausted && <AIComposerDisclaimer />}
    </div>
  );
}

export function AIComposerDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("pt-2 text-center text-[11px] text-muted-foreground", className)}>
      AI can make mistakes. Check important information.
    </p>
  );
}
