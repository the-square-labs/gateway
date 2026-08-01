import { Expand } from "lucide-react";
import { useState } from "react";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function configPreview(value: string) {
  return value.replace(/\s+/g, " ").trim() || "No custom configuration";
}

export function ClickHouseConfigField({
  value,
  onChange,
  disabled = false,
  label = "ClickHouse configuration fragment",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <>
      <CopyValueField
        label={label}
        value={configPreview(value)}
        copyable={false}
        valueClassName={cn("font-mono", !value.trim() && "text-muted-foreground")}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setEditorOpen(true)}
            disabled={disabled}
            aria-label="Expand ClickHouse configuration editor"
            title="Expand editor"
          >
            <Expand className="h-3.5 w-3.5" />
          </Button>
        }
      />

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex h-[85vh] w-[92vw] flex-col sm:max-w-[58rem]">
          <DialogHeader>
            <DialogTitle>ClickHouse configuration fragment</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            <CodeEditor
              value={value}
              onChange={onChange}
              language="xml"
              height="100%"
              minHeight="0px"
              className="h-full flex-1"
              showGutterBorder={false}
              readOnly={disabled}
            />
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setEditorOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
