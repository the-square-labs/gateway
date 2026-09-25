import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface InlineFolderEditorProps {
  initialName?: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

export function InlineFolderEditor({
  initialName = "",
  onSave,
  onCancel,
  autoFocus = true,
}: InlineFolderEditorProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [autoFocus]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed) onSave(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
      return;
    }
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-7 w-48 text-sm"
        placeholder="Folder name"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Save folder name"
        onClick={handleSubmit}
        disabled={!name.trim()}
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Cancel renaming" onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
