import { LogOut, Settings, Shield, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { getInitials } from "@/lib/utils";
import { CompactInferenceUsage } from "@/pages/inference/InferenceUsagePanels";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";

interface AccountMenuContentProps {
  onLogout: () => void;
  onNavigate?: () => void;
  showAdministration?: boolean;
}

export function AccountMenuContent({
  onLogout,
  onNavigate,
  showAdministration = false,
}: AccountMenuContentProps) {
  const navigate = useNavigate();
  const { user, hasScope } = useAuthStore();
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);
  const showInferenceUsage =
    inferenceEnabled && hasScope("inference:use") && hasScope("inference:usage:view:self");

  const navigateTo = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-2 py-2">
        <Avatar className="h-8 w-8">
          <AvatarImage src={user?.avatarUrl ?? undefined} />
          <AvatarFallback className="text-xs">
            {getInitials(user?.name || user?.email || "?")}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user?.name || "User"}</p>
          {user?.email ? (
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          ) : null}
        </div>
      </div>
      <DropdownMenuSeparator className="bg-border" />
      {showInferenceUsage ? (
        <>
          <CompactInferenceUsage />
          <DropdownMenuSeparator className="bg-border" />
        </>
      ) : null}
      <DropdownMenuItem onClick={() => navigateTo("/profile")}>
        <UserRound />
        Profile
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigateTo("/settings")}>
        <Settings />
        Settings
      </DropdownMenuItem>
      {showAdministration ? (
        <DropdownMenuItem onClick={() => navigateTo("/administration")}>
          <Shield />
          Administration
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator className="bg-border" />
      <DropdownMenuItem onClick={onLogout}>
        <LogOut />
        Log out
      </DropdownMenuItem>
    </>
  );
}
