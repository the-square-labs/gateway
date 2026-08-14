import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  CircleAlert,
  Compass,
  Folder,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  UserRoundX,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AccountMenuContent } from "@/components/layout/AccountMenuContent";
import {
  dashboardAttentionDotClass,
  dashboardAttentionLabel,
} from "@/components/layout/dashboard-attention";
import { SidebarPinnedResources } from "@/components/layout/SidebarPinnedResources";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { aiConversationRoute } from "@/lib/ai-conversation-route";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import { isSidebarNavigationActive } from "@/lib/sidebar-navigation";
import { cn, getInitials } from "@/lib/utils";
import type { AIConversationFolder, AIConversationSummary } from "@/services/ai-conversations";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { AIConversationStatusIndicator } from "./AIConversationStatusIndicator";
import { AIProgressRing } from "./AIProgressRing";

const EXPANDED_PROJECT_IDS_STORAGE_KEY = "gateway-ai-lite-expanded-project-ids";

interface SidebarPointerPosition {
  x: number;
  y: number;
}

function formatConversationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    const diffMs = Math.max(0, now.getTime() - date.getTime());
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return "now";
    if (diffMinutes < 60) return `${diffMinutes} min ago`;
    return `${Math.floor(diffMinutes / 60)} h ago`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function readExpandedProjectIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECT_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeExpandedProjectIds(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PROJECT_IDS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore unavailable storage; project expansion still works for the current session.
  }
}

interface AILiteSidebarProps {
  alwaysExpanded?: boolean;
  mobileMenu?: boolean;
  onClose?: () => void;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  isResizing?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function AILiteSidebar({
  alwaysExpanded = false,
  mobileMenu = false,
  onClose,
  sidebarWidth = 260,
  onSidebarWidthChange,
  isResizing = false,
  onResizeStart,
  onResizeEnd,
}: AILiteSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, hasAnyScope, hasScopedAccess, logout } = useAuthStore();
  const {
    sidebarOpen,
    toggleSidebar,
    pinnedAIConversationIds,
    togglePinnedAIConversation,
    setCommandPaletteOpen: openPalette,
  } = useUIStore();
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const dashboardAttention = dashboardBootstrap?.attention.severity ?? null;
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const siemEnabled = useSystemConfigStore((s) => s.config.features.siemEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);
  const navigationBootstrap = useUIBootstrapStore((s) => s.snapshot?.navigation);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const {
    messages,
    sidebarActiveConversationId,
    recentConversations,
    conversationFolders,
    isLoadingRecentConversations,
    isStartingConversation,
    clearMessages,
    createConversationFolder,
    deleteConversation,
    deleteConversationFolder,
    fetchConversationFolders,
    fetchRecentConversations,
    loadConversation,
    moveConversationsToFolder,
    reorderConversationFolders,
    updateConversationFolder,
  } = useAIStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const pointerPositionRef = useRef<SidebarPointerPosition | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(readExpandedProjectIds);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const {
    open: folderDialogOpen,
    value: folderDialog,
    setValue: setFolderDialog,
    onOpenChange: onFolderDialogOpenChange,
  } = useDeferredDialogState<FolderDialogState>();
  const [dragOverlayConversationId, setDragOverlayConversationId] = useState<string | null>(null);
  const [stoppingImpersonation, setStoppingImpersonation] = useState(false);
  const canAccessAdministration = hasAnyScope("admin:audit", "admin:users", "admin:groups");
  const navigateToGroups = visibleNavigationGroups({
    scopes: user?.scopes ?? [],
    pkiEnabled,
    siemEnabled,
    loggingEnabled,
    inferenceEnabled,
    hasLowInferenceUsage: hasLowInferenceUsage(dashboardBootstrap?.inferenceUsage ?? null),
    statusPageEnabled: navigationBootstrap?.statusPageEnabled ?? false,
    hasNginxNodes: navigationBootstrap?.hasNginxNodes ?? true,
    hasCloudflareIntegration: navigationBootstrap?.hasCloudflareIntegration ?? false,
    hasDockerNodes:
      dockerNodes.length > 0 ||
      [
        "docker:containers:view",
        "docker:images:view",
        "docker:volumes:view",
        "docker:networks:view",
      ].some(hasScopedAccess),
  })
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.id !== "dashboard" &&
          item.id !== "profile" &&
          item.id !== "settings" &&
          item.id !== "administration"
      ),
    }))
    .filter((group) => group.items.length > 0);
  const isExpanded = alwaysExpanded || sidebarOpen;
  const pinnedConversationSet = new Set(pinnedAIConversationIds);
  const pinnedConversations = pinnedAIConversationIds
    .map((id) => recentConversations.find((conversation) => conversation.id === id))
    .filter((conversation): conversation is AIConversationSummary => Boolean(conversation));
  const chatConversations = recentConversations.filter(
    (conversation) => !pinnedConversationSet.has(conversation.id)
  );
  const sortedFolders = [...conversationFolders].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
  const conversationsByFolder = new Map<string | null, AIConversationSummary[]>();
  conversationsByFolder.set(null, []);
  for (const folder of sortedFolders) conversationsByFolder.set(folder.id, []);
  for (const conversation of chatConversations) {
    const folderId =
      conversation.folderId && conversationsByFolder.has(conversation.folderId)
        ? conversation.folderId
        : null;
    conversationsByFolder.get(folderId)?.push(conversation);
  }
  const rootConversations = conversationsByFolder.get(null) ?? [];
  const dragOverlayConversation = dragOverlayConversationId
    ? recentConversations.find((conversation) => conversation.id === dragOverlayConversationId)
    : null;
  const visibleActiveConversationId = messages.length > 0 ? sidebarActiveConversationId : null;

  useEffect(() => {
    void fetchRecentConversations();
    void fetchConversationFolders();
  }, [fetchConversationFolders, fetchRecentConversations]);

  useEffect(() => {
    writeExpandedProjectIds(expandedFolderIds);
  }, [expandedFolderIds]);

  const handleNewChat = () => {
    useAIStore.setState({ sidebarActiveConversationId: null });
    navigate("/", { flushSync: true });
    clearMessages();
  };

  const handleLoadConversation = async (conversationId: string) => {
    if (conversationId === sidebarActiveConversationId) {
      navigate(aiConversationRoute(conversationId));
      return;
    }
    await loadConversation(conversationId);
    navigate(aiConversationRoute(conversationId));
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const deletingActiveConversation = conversationId === visibleActiveConversationId;
    await deleteConversation(conversationId);
    if (deletingActiveConversation) navigate("/");
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // Local auth state still needs to clear if the server session is already gone.
    } finally {
      logout();
      navigate("/login");
    }
  };

  const handleStopImpersonating = async () => {
    setStoppingImpersonation(true);
    try {
      await api.stopImpersonating();
      api.resetSessionState();
      window.location.assign("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to stop impersonating");
      setStoppingImpersonation(false);
    }
  };

  const handleOpenOperationsConsole = () => {
    window.dispatchEvent(new CustomEvent("gateway:open-operations-console"));
  };

  const handleToggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const handleCreateFolder = async (name: string, description: string) => {
    const folder = await createConversationFolder({ name, description });
    if (folder) {
      setExpandedFolderIds((current) => new Set([...current, folder.id]));
      setFolderDialog(null);
    }
  };

  const handleUpdateFolder = async (folderId: string, name: string, description: string) => {
    await updateConversationFolder(folderId, { name, description });
    setFolderDialog(null);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeData = event.active.data.current;
    setDragOverlayConversationId(
      activeData?.type === "conversation" && typeof activeData.conversationId === "string"
        ? activeData.conversationId
        : null
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragOverlayConversationId(null);
    const activeData = event.active.data.current;
    const overData = event.over?.data.current;
    if (!activeData || !overData) return;

    if (activeData.type === "folder" && overData.type === "folder") {
      const oldIndex = sortedFolders.findIndex((folder) => folder.id === activeData.folderId);
      const newIndex = sortedFolders.findIndex((folder) => folder.id === overData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      void reorderConversationFolders(
        arrayMove(sortedFolders, oldIndex, newIndex).map((folder) => folder.id)
      );
      return;
    }

    if (activeData.type === "conversation") {
      const targetFolderId =
        overData.type === "root"
          ? null
          : typeof overData.folderId === "string"
            ? overData.folderId
            : null;
      if (activeData.folderId === targetFolderId) return;
      void moveConversationsToFolder([activeData.conversationId], targetFolderId);
    }
  };

  return (
    <aside
      style={{ width: alwaysExpanded ? "100%" : isExpanded ? sidebarWidth : 48 }}
      onPointerEnter={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerDownCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        pointerPositionRef.current = null;
      }}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-visible border-r border-sidebar-border bg-sidebar-background",
        !isResizing && "transition-[width] duration-200 ease-out"
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {!isExpanded ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center gap-2 py-3"
          >
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleSidebar}>
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Open sidebar</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openPalette(true)}
                    aria-label="Search"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Search</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleNewChat}
                    aria-label="New Work Session"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New Work Session</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8",
                      isSidebarNavigationActive(location.pathname, "/dashboard") &&
                        "bg-sidebar-accent"
                    )}
                    aria-label="Dashboard"
                  >
                    <Link to="/dashboard">
                      <span className="relative flex">
                        <LayoutDashboard className="h-4 w-4" />
                        {dashboardAttention && (
                          <span
                            aria-label={dashboardAttentionLabel(dashboardAttention)}
                            className={cn(
                              "absolute -right-2 -top-2 h-2 w-2",
                              dashboardAttentionDotClass(dashboardAttention)
                            )}
                          />
                        )}
                      </span>
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Dashboard</TooltipContent>
              </Tooltip>
              <Separator className="my-1 w-6" />

              <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden dashboard-scrollbar">
                {isStartingConversation && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 bg-sidebar-accent"
                        aria-label="Starting Work Session..."
                      >
                        <AIProgressRing ariaLabel="Starting Work Session" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Starting Work Session...</TooltipContent>
                  </Tooltip>
                )}
                {recentConversations.length === 0 && !isStartingConversation && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 bg-sidebar-accent"
                        aria-label="New Work Session"
                        onClick={handleNewChat}
                      >
                        <MessageSquare className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">New Work Session</TooltipContent>
                  </Tooltip>
                )}
                {recentConversations.map((conversation) => {
                  return (
                    <Tooltip key={conversation.id}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "h-8 w-8",
                            visibleActiveConversationId === conversation.id && "bg-sidebar-accent"
                          )}
                          aria-label={conversation.title}
                          onClick={() => void handleLoadConversation(conversation.id)}
                        >
                          <AIConversationStatusIndicator conversation={conversation} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{conversation.title}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </nav>

              {navigateToGroups.length > 0 && (
                <Tooltip>
                  <DropdownMenu>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="All sections"
                        >
                          <Compass className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">All sections</TooltipContent>
                    <DropdownMenuContent
                      side="right"
                      align="end"
                      className="max-h-[min(70vh,34rem)] w-60 overflow-y-auto"
                    >
                      {navigateToGroups.map((group, groupIndex) => (
                        <div key={group.id}>
                          {groupIndex > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            {group.label}
                          </DropdownMenuLabel>
                          {group.items.map((item) => (
                            <DropdownMenuItem key={item.id} onSelect={() => navigate(item.href)}>
                              <item.icon className="h-4 w-4" />
                              <span>{item.name}</span>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Tooltip>
              )}

              {
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 bg-sidebar-accent text-sidebar-accent-foreground/80 hover:bg-muted hover:text-sidebar-accent-foreground"
                      onClick={handleOpenOperationsConsole}
                      aria-label="Open Operations Console"
                    >
                      <PanelLeft className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Open Operations Console</TooltipContent>
                </Tooltip>
              }

              {user?.impersonation?.active && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => void handleStopImpersonating()}
                      disabled={stoppingImpersonation}
                      aria-label="Stop impersonating"
                    >
                      <UserRoundX className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Stop impersonating</TooltipContent>
                </Tooltip>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={user?.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {getInitials(user?.name || user?.email || "?")}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" className="w-64">
                  <AccountMenuContent
                    showAdministration={canAccessAdministration}
                    onLogout={handleLogout}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full w-full min-w-0 flex-col"
          >
            {onSidebarWidthChange && (
              <ResizeHandle
                side="left"
                onResize={onSidebarWidthChange}
                onResizeStart={onResizeStart}
                onResizeEnd={onResizeEnd}
                minWidth={200}
                maxWidth={480}
              />
            )}

            <div
              className={cn("flex items-center justify-between px-2", mobileMenu && "h-12")}
              style={
                mobileMenu ? undefined : { paddingTop: 10, paddingBottom: 10, paddingLeft: 10 }
              }
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap pl-1 text-sm font-semibold text-foreground/80">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway AI
              </span>
              <div className="flex items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("md:h-7 md:w-7", mobileMenu ? "h-8 w-8" : "h-10 w-10")}
                      aria-label="Create"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={handleNewChat}>
                      <MessageSquare className="mr-2 h-4 w-4" />
                      New Work Session
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setFolderDialog({ mode: "create", name: "", description: "" })}
                    >
                      <Folder className="mr-2 h-4 w-4" />
                      New project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("md:h-7 md:w-7", mobileMenu ? "h-8 w-8" : "h-10 w-10")}
                      onClick={onClose ?? toggleSidebar}
                      aria-label={onClose ? "Close menu" : "Close sidebar"}
                    >
                      {onClose ? <X className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{onClose ? "Close menu" : "Close sidebar"}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="relative border-y border-border">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                readOnly
                onClick={() => openPalette(true)}
                style={{ height: 44 }}
                className="cursor-pointer border-0 pl-9 text-sm focus-visible:outline-none focus-visible:ring-0"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-xs tracking-widest text-muted-foreground md:inline">
                ⌘K
              </span>
            </div>

            <div className="border-b border-border px-2 py-2">
              <Link
                to="/dashboard"
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                  isSidebarNavigationActive(location.pathname, "/dashboard")
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <LayoutDashboard className="h-4 w-4 shrink-0" />
                <span>Dashboard</span>
                {dashboardAttention && (
                  <span
                    aria-label={dashboardAttentionLabel(dashboardAttention)}
                    className={cn(
                      "ml-auto h-2 w-2 shrink-0",
                      dashboardAttentionDotClass(dashboardAttention)
                    )}
                  />
                )}
              </Link>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto dashboard-scrollbar">
                <SidebarPinnedResources loadBootstrap />
                {isLoadingRecentConversations && recentConversations.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">Loading...</div>
                ) : (
                  <>
                    {pinnedConversations.length > 0 && (
                      <nav className="space-y-0.5 px-2 py-2">
                        <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Pinned
                        </p>
                        {pinnedConversations.map((conversation) => (
                          <ConversationMenuItem
                            key={conversation.id}
                            conversation={conversation}
                            active={visibleActiveConversationId === conversation.id}
                            pinned
                            disableLayoutAnimation={isResizing}
                            hoverSyncRevision={recentConversations.length}
                            pointerPositionRef={pointerPositionRef}
                            onLoad={() => void handleLoadConversation(conversation.id)}
                            onTogglePin={() => togglePinnedAIConversation(conversation.id)}
                            onDelete={() => void handleDeleteConversation(conversation.id)}
                          />
                        ))}
                      </nav>
                    )}

                    <DndContext
                      sensors={sensors}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      onDragCancel={() => setDragOverlayConversationId(null)}
                    >
                      {sortedFolders.length > 0 && (
                        <nav className="space-y-0.5 px-2 py-2">
                          <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            Projects
                          </p>
                          <SortableContext
                            items={sortedFolders.map((folder) => folder.id)}
                            strategy={verticalListSortingStrategy}
                          >
                            {sortedFolders.map((folder) => {
                              const folderConversations =
                                conversationsByFolder.get(folder.id) ?? [];
                              const isFolderExpanded = expandedFolderIds.has(folder.id);
                              return (
                                <div key={folder.id} className="space-y-0.5">
                                  <FolderMenuItem
                                    folder={folder}
                                    conversations={folderConversations}
                                    expanded={isFolderExpanded}
                                    onToggle={() => handleToggleFolder(folder.id)}
                                    onEdit={() =>
                                      setFolderDialog({
                                        mode: "edit",
                                        folderId: folder.id,
                                        name: folder.name,
                                        description: folder.description,
                                      })
                                    }
                                    onDelete={() => void deleteConversationFolder(folder.id)}
                                  />
                                  {folderConversations.length > 0 && (
                                    <AnimatePresence initial={false}>
                                      {isFolderExpanded && (
                                        <motion.div
                                          key={`${folder.id}-conversations`}
                                          initial={{ height: 0, opacity: 0 }}
                                          animate={{ height: "auto", opacity: 1 }}
                                          exit={{ height: 0, opacity: 0 }}
                                          transition={{ duration: 0.16, ease: "easeOut" }}
                                          className="overflow-hidden"
                                        >
                                          <div className="space-y-0.5 pl-4">
                                            {folderConversations.map((conversation) => (
                                              <DraggableConversationMenuItem
                                                key={conversation.id}
                                                conversation={conversation}
                                                folderId={folder.id}
                                                active={
                                                  visibleActiveConversationId === conversation.id
                                                }
                                                pinned={false}
                                                disableLayoutAnimation={isResizing}
                                                hoverSyncRevision={recentConversations.length}
                                                pointerPositionRef={pointerPositionRef}
                                                onLoad={() =>
                                                  void handleLoadConversation(conversation.id)
                                                }
                                                onTogglePin={() =>
                                                  togglePinnedAIConversation(conversation.id)
                                                }
                                                onDelete={() =>
                                                  void handleDeleteConversation(conversation.id)
                                                }
                                              />
                                            ))}
                                          </div>
                                        </motion.div>
                                      )}
                                    </AnimatePresence>
                                  )}
                                </div>
                              );
                            })}
                          </SortableContext>
                        </nav>
                      )}

                      <nav className="space-y-0.5 px-2 py-2">
                        <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Chats
                        </p>
                        {isStartingConversation && (
                          <div
                            aria-current="page"
                            className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground"
                          >
                            <MessageSquare className="h-4 w-4 shrink-0" />
                            <span className="thinking-shimmer truncate text-muted-foreground">
                              Starting Work Session...
                            </span>
                          </div>
                        )}
                        {recentConversations.length === 0 &&
                        sortedFolders.length === 0 &&
                        !isStartingConversation ? (
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground"
                            onClick={handleNewChat}
                          >
                            <MessageSquare className="h-4 w-4 shrink-0" />
                            <span className="truncate">New Work Session</span>
                          </button>
                        ) : (
                          <RootConversationDropZone>
                            {rootConversations.map((conversation) => (
                              <DraggableConversationMenuItem
                                key={conversation.id}
                                conversation={conversation}
                                folderId={null}
                                active={visibleActiveConversationId === conversation.id}
                                pinned={false}
                                disableLayoutAnimation={isResizing}
                                hoverSyncRevision={recentConversations.length}
                                pointerPositionRef={pointerPositionRef}
                                onLoad={() => void handleLoadConversation(conversation.id)}
                                onTogglePin={() => togglePinnedAIConversation(conversation.id)}
                                onDelete={() => void handleDeleteConversation(conversation.id)}
                              />
                            ))}
                          </RootConversationDropZone>
                        )}
                      </nav>
                      <DragOverlay dropAnimation={null}>
                        {dragOverlayConversation ? (
                          <ConversationDragOverlayItem
                            conversation={dragOverlayConversation}
                            width={Math.max(160, Math.min(sidebarWidth - 32, 360))}
                          />
                        ) : null}
                      </DragOverlay>
                    </DndContext>
                  </>
                )}
              </div>
            </div>

            <div className="border-t border-border">
              {navigateToGroups.length > 0 && (
                <>
                  <div className="px-2 py-2">
                    {mobileMenu ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => setSectionsOpen(true)}
                      >
                        <Compass className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">All sections</span>
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      </button>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <Compass className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">All sections</span>
                            <ChevronRight className="h-4 w-4 shrink-0" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="end"
                          className="max-h-[min(70vh,34rem)] w-60 overflow-y-auto"
                        >
                          {navigateToGroups.map((group, groupIndex) => (
                            <div key={group.id}>
                              {groupIndex > 0 && <DropdownMenuSeparator />}
                              <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                {group.label}
                              </DropdownMenuLabel>
                              {group.items.map((item) => (
                                <DropdownMenuItem
                                  key={item.id}
                                  onSelect={() => navigate(item.href)}
                                >
                                  <item.icon className="h-4 w-4" />
                                  <span>{item.name}</span>
                                </DropdownMenuItem>
                              ))}
                            </div>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <Separator />
                </>
              )}
              {
                <>
                  <div className="px-2 py-2">
                    <button
                      type="button"
                      onClick={handleOpenOperationsConsole}
                      className="flex w-full items-center gap-2 bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground/80 transition-colors hover:bg-muted hover:text-sidebar-accent-foreground"
                    >
                      <PanelLeft className="h-4 w-4 shrink-0" />
                      <span className="truncate">Open Operations Console</span>
                    </button>
                  </div>
                  <Separator />
                </>
              }
              {user?.impersonation?.active && (
                <>
                  <div className="px-2 py-2">
                    <Button
                      className="w-full justify-start px-3"
                      onClick={() => void handleStopImpersonating()}
                      disabled={stoppingImpersonation}
                    >
                      <UserRoundX className="h-4 w-4 shrink-0" />
                      <span className="truncate">Stop impersonating</span>
                    </Button>
                  </div>
                  <Separator />
                </>
              )}
              <div className="p-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="flex h-auto w-full items-center justify-start gap-2 px-1 py-1.5"
                    >
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarImage src={user?.avatarUrl ?? undefined} />
                        <AvatarFallback className="text-xs">
                          {getInitials(user?.name || user?.email || "?")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate text-sm font-medium">{user?.name || "User"}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-64">
                    <AccountMenuContent
                      showAdministration={canAccessAdministration}
                      onLogout={handleLogout}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {mobileMenu && (
        <Sheet open={sectionsOpen} onOpenChange={setSectionsOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[80dvh] w-full flex-col gap-0 rounded-t-xl p-0"
          >
            <SheetHeader className="border-b border-border px-4 py-3 text-left">
              <SheetTitle>All sections</SheetTitle>
            </SheetHeader>
            <nav className="min-h-0 flex-1 overflow-y-auto dashboard-scrollbar">
              {navigateToGroups.map((group, groupIndex) => (
                <div key={group.id}>
                  {groupIndex > 0 && <Separator />}
                  <div className="space-y-0.5 px-2 py-2">
                    <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </p>
                    {group.items.map((item) => {
                      const isActive = isSidebarNavigationActive(location.pathname, item.href);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-3 overflow-hidden whitespace-nowrap px-3 py-2 text-left text-sm transition-colors",
                            isActive
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                          )}
                          onClick={() => {
                            setSectionsOpen(false);
                            navigate(item.href);
                            onClose?.();
                          }}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      )}
      {folderDialog && (
        <ConversationFolderDialog
          open={folderDialogOpen}
          state={folderDialog}
          onOpenChange={onFolderDialogOpenChange}
          onCreate={(name, description) => handleCreateFolder(name, description)}
          onUpdate={(folderId, name, description) =>
            handleUpdateFolder(folderId, name, description)
          }
        />
      )}
    </aside>
  );
}

type FolderDialogState =
  | { mode: "create"; name: string; description: string }
  | { mode: "edit"; folderId: string; name: string; description: string };

function ConversationFolderDialog({
  open,
  state,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  state: FolderDialogState;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, description: string) => Promise<void>;
  onUpdate: (folderId: string, name: string, description: string) => Promise<void>;
}) {
  const [draftName, setDraftName] = useState(state.name);
  const [draftDescription, setDraftDescription] = useState(state.description);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canSubmit = draftName.trim().length > 0;

  useEffect(() => {
    setDraftName(state.name);
    setDraftDescription(state.description);
    setIsSubmitting(false);
  }, [state]);

  const submit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      if (state.mode === "create") {
        await onCreate(draftName.trim(), draftDescription.trim());
      } else {
        await onUpdate(state.folderId, draftName.trim(), draftDescription.trim());
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.mode === "create" ? "New project" : "Edit project"}</DialogTitle>
          <DialogDescription>Group related Work Sessions in a sidebar project.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="ai-folder-name" className="text-sm font-medium text-foreground">
              Name
            </label>
            <Input
              id="ai-folder-name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ai-folder-description" className="text-sm font-medium text-foreground">
              Description
            </label>
            <Textarea
              id="ai-folder-description"
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Optional description"
              className="min-h-20 resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={isSubmitting || !canSubmit}>
            {state.mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderMenuItem({
  folder,
  conversations,
  expanded,
  onToggle,
  onEdit,
  onDelete,
}: {
  folder: AIConversationFolder;
  conversations: AIConversationSummary[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: folder.id,
    data: { type: "folder", folderId: folder.id },
  });
  const StatusIcon = getFolderStatusIcon(conversations, expanded);
  const statusClassName = cn(
    "h-4 w-4 shrink-0",
    StatusIcon === Loader2
      ? "animate-spin text-primary"
      : StatusIcon === CircleAlert
        ? "text-warning-foreground"
        : ""
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group flex max-w-full items-center overflow-hidden whitespace-nowrap text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isDragging && "opacity-60"
      )}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-2 pr-1 text-left text-sm"
        onClick={onToggle}
      >
        <StatusIcon className={statusClassName} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{folder.name}</span>
          {folder.description.trim() && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {folder.description}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{conversations.length}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
            aria-label={`Folder actions for ${folder.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RootConversationDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "conversation-root",
    data: { type: "root", folderId: null },
  });
  return (
    <div ref={setNodeRef} className={cn("min-h-2 space-y-0.5", isOver && "bg-sidebar-accent/50")}>
      {children}
    </div>
  );
}

function DraggableConversationMenuItem({
  conversation,
  folderId,
  active,
  pinned,
  disableLayoutAnimation,
  hoverSyncRevision,
  pointerPositionRef,
  onLoad,
  onTogglePin,
  onDelete,
}: {
  conversation: AIConversationSummary;
  folderId: string | null;
  active: boolean;
  pinned: boolean;
  disableLayoutAnimation?: boolean;
  hoverSyncRevision: number;
  pointerPositionRef: { current: SidebarPointerPosition | null };
  onLoad: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `conversation:${conversation.id}`,
    data: { type: "conversation", conversationId: conversation.id, folderId },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && "opacity-60")}
      {...attributes}
      {...listeners}
    >
      <ConversationMenuItem
        conversation={conversation}
        active={active}
        pinned={pinned}
        disableLayoutAnimation={disableLayoutAnimation}
        hoverSyncRevision={hoverSyncRevision}
        pointerPositionRef={pointerPositionRef}
        onLoad={onLoad}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  );
}

function ConversationDragOverlayItem({
  conversation,
  width,
}: {
  conversation: AIConversationSummary;
  width: number;
}) {
  return (
    <div
      style={{ width }}
      className="flex max-w-[calc(100vw-2rem)] items-center gap-3 overflow-hidden whitespace-nowrap border border-sidebar-border bg-sidebar-background px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg"
    >
      <AIConversationStatusIndicator conversation={conversation} />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
    </div>
  );
}

function ConversationMenuItem({
  conversation,
  active,
  pinned,
  disableLayoutAnimation,
  hoverSyncRevision,
  pointerPositionRef,
  onLoad,
  onTogglePin,
  onDelete,
}: {
  conversation: AIConversationSummary;
  active: boolean;
  pinned: boolean;
  disableLayoutAnimation?: boolean;
  hoverSyncRevision: number;
  pointerPositionRef: { current: SidebarPointerPosition | null };
  onLoad: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverSyncRevisionRef = useRef(hoverSyncRevision);
  const [isHovered, setIsHovered] = useState(false);
  useLayoutEffect(() => {
    if (hoverSyncRevisionRef.current === hoverSyncRevision) return;
    hoverSyncRevisionRef.current = hoverSyncRevision;
    const frameId = window.requestAnimationFrame(() => {
      const row = rowRef.current;
      const pointer = pointerPositionRef.current;
      if (!row || !pointer) {
        setIsHovered(false);
        return;
      }
      const bounds = row.getBoundingClientRect();
      const hoveredAfterListUpdate =
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right &&
        pointer.y >= bounds.top &&
        pointer.y <= bounds.bottom;
      setIsHovered((current) =>
        current === hoveredAfterListUpdate ? current : hoveredAfterListUpdate
      );
    });
    return () => window.cancelAnimationFrame(frameId);
  });

  return (
    <div
      ref={rowRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        "group flex max-w-full items-center overflow-hidden whitespace-nowrap transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-2 pr-1 text-left text-sm"
        onClick={onLoad}
      >
        <AIConversationStatusIndicator conversation={conversation} />
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      </button>
      <motion.div
        layout={!disableLayoutAnimation}
        className="mr-2 flex h-6 shrink-0 items-center justify-end overflow-hidden"
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {isHovered ? (
            <motion.div
              key="actions"
              layout={!disableLayoutAnimation}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="flex items-center gap-0.5"
            >
              <button
                type="button"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${conversation.title}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin();
                }}
              >
                {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                aria-label={`Delete ${conversation.title}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.detail > 0) {
                    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
                  }
                  onDelete();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ) : (
            <motion.span
              key="time"
              layout={!disableLayoutAnimation}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="text-xs text-muted-foreground"
            >
              {formatConversationDate(conversation.lastUserMessageAt ?? conversation.createdAt)}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function getFolderStatusIcon(conversations: AIConversationSummary[], expanded: boolean) {
  if (
    conversations.some(
      (conversation) =>
        conversation.activeRunStatus === "waiting_for_approval" ||
        conversation.activeRunStatus === "waiting_for_answer" ||
        conversation.activeRunStatus === "waiting_for_credential" ||
        conversation.activeRunStatus === "waiting_for_setup" ||
        conversation.planStatus === "awaiting_decision" ||
        conversation.planStatus === "paused"
    )
  ) {
    return CircleAlert;
  }
  if (
    conversations.some(
      (conversation) =>
        conversation.activeRunStatus === "queued" || conversation.activeRunStatus === "running"
    )
  ) {
    return Loader2;
  }
  return expanded ? FolderOpen : Folder;
}
