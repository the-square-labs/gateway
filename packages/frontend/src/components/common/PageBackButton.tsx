import { ArrowLeft } from "lucide-react";
import type * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getReturnNavigationTarget } from "@/lib/return-navigation";
import { cn } from "@/lib/utils";

type PageBackButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function PageBackButton({ className, onClick, ...props }: PageBackButtonProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const returnTarget = getReturnNavigationTarget(location.state, "");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9 shrink-0", className)}
      aria-label="Back"
      onClick={(event) => {
        if (returnTarget) {
          navigate(returnTarget);
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}
