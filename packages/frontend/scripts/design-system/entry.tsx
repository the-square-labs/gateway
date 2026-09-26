// Entry of the design system bundle: the product's own kit and shared
// components, unchanged, exposed as window.GatewayUI for the previews.
// scripts/design-system/export.mjs bundles it with esbuild (IIFE, React from
// window.React / window.ReactDOM) and reads its exports for the types.

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  Copy,
  Cpu,
  Database,
  Download,
  EllipsisVertical,
  Filter,
  Folder,
  Globe,
  HardDrive,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";

export { AnimatedHeight } from "@/components/common/AnimatedHeight";
export { AvatarCropDialog } from "@/components/common/AvatarCropDialog";
export { ChoiceCard } from "@/components/common/ChoiceCard";
export { Combobox } from "@/components/common/Combobox";
export {
  ConfirmDialog,
  confirm,
  confirmAction,
  useConfirmDialog,
} from "@/components/common/ConfirmDialog";
export { ContentLoading } from "@/components/common/ContentLoading";
export { CopyButton } from "@/components/common/CopyButton";
export { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
export { CopyValueField } from "@/components/common/CopyValueField";
export { CreateFolderSelect } from "@/components/common/CreateFolderSelect";
export { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
export { DetailRow } from "@/components/common/DetailRow";
export { DownloadButton } from "@/components/common/DownloadButton";
export { EditableStringList } from "@/components/common/EditableStringList";
export { EmptyState } from "@/components/common/EmptyState";
export { ErrorBoundary } from "@/components/common/ErrorBoundary";
export { FolderCreateDialog } from "@/components/common/FolderCreateDialog";
export { InlineFolderEditor } from "@/components/common/InlineFolderEditor";
export { LoadingSpinner } from "@/components/common/LoadingSpinner";
export {
  ManagedCertificateDetailRow,
  ManagedCertificateNotice,
} from "@/components/common/ManagedCertificateStatus";
export { Notice, NoticeAction } from "@/components/common/Notice";
export { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
export { OneTimeTokenDialog } from "@/components/common/OneTimeTokenDialog";
export { PageBackButton } from "@/components/common/PageBackButton";
export { PageHeader } from "@/components/common/PageHeader";
export { PageTransition } from "@/components/common/PageTransition";
export { PanelShell } from "@/components/common/PanelShell";
export { PoweredByFooter } from "@/components/common/PoweredByFooter";
export { ReferenceTable } from "@/components/common/ReferenceTable";
export {
  HeaderOverflowMenu,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
export { ResourceListForm } from "@/components/common/ResourceListForm";
export {
  ResourceListCell,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListSectionHeader,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
export {
  databaseHealthTone,
  dockerStateTone,
  isDockerStateTransitional,
  nodeStatusTone,
  proxyHealthTone,
  statusDotClass,
} from "@/components/common/resource-status";
export { ContentLoader, useContentLoading } from "@/components/common/reveal-gate";
export { ScopeSearchFilter } from "@/components/common/ScopeSearchFilter";
export { SearchFilterBar } from "@/components/common/SearchFilterBar";
export { SectionHeader } from "@/components/common/SectionHeader";
export {
  SettingsControlRow,
  SettingsHelpTitle,
  SettingsInlineControl,
} from "@/components/common/SettingsControlRow";
export { SimpleTable } from "@/components/common/SimpleTable";
export { StatusBadge } from "@/components/common/StatusBadge";
export { ToggleField } from "@/components/common/ToggleField";
export { ValueTile } from "@/components/common/ValueTile";
export { AnsiText } from "@/components/ui/ansi-text";
export { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
export { Badge, badgeVariants } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { CodeEditor } from "@/components/ui/code-editor";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
export { DataTable } from "@/components/ui/data-table";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export { HealthBars } from "@/components/ui/health-bars";
export { Input } from "@/components/ui/input";
export { NumericInput } from "@/components/ui/numeric-input";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
export { ProgressBar } from "@/components/ui/progress-bar";
export { RefreshButton } from "@/components/ui/refresh-button";
export { ResizeHandle } from "@/components/ui/resize-handle";
export { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export { Separator } from "@/components/ui/separator";
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
export { Skeleton } from "@/components/ui/skeleton";
export { Slider } from "@/components/ui/slider";
export { Toaster } from "@/components/ui/sonner";
export { Sparkline } from "@/components/ui/sparkline";
export { StatCard } from "@/components/ui/stat-card";
export { Switch } from "@/components/ui/switch";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
export { Textarea } from "@/components/ui/textarea";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
export { TruncateStart } from "@/components/ui/truncate-start";
export { VirtualLogList } from "@/components/ui/virtual-log-list";
export { cn } from "@/lib/utils";

/** Lucide icons the previews use; the product draws every icon with lucide-react. */
export const Icons = {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  Copy,
  Cpu,
  Database,
  Download,
  EllipsisVertical,
  Filter,
  Folder,
  Globe,
  HardDrive,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  Shield,
  Trash2,
  X,
};

/** Router for components that link (EmptyState, PageBackButton, notice actions). */
export { MemoryRouter, toast };
