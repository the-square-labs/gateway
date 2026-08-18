import { Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function PagesFeatureDisabledDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  const openSettings = () => {
    onOpenChange(false);
    navigate("/settings/features", { state: { scrollTarget: "pages" } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pages is disabled</DialogTitle>
        </DialogHeader>
        <div>
          <p className="text-sm text-muted-foreground">
            Enable Pages in Features before selecting a Page Project and Tag for this Route.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={openSettings}>
            <Settings className="h-4 w-4" />
            Open Pages settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
