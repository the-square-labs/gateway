import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";

export { SettingsControlRow } from "@/components/common/SettingsControlRow";

export function SaveSettingsButton({
  onClick,
  disabled,
  pending = false,
}: {
  onClick: () => void;
  disabled: boolean;
  pending?: boolean;
}) {
  return (
    <Button onClick={onClick} disabled={disabled} pending={pending}>
      <Save className="h-4 w-4" />
      Save
    </Button>
  );
}
