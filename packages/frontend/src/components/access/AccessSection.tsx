import { useState } from "react";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { AccessPanel } from "./AccessPanel";
import { type AccessScopePickerProps, AccessScopesDialog } from "./AccessScopesDialog";
import { type AccessGrantMode, AddAccessDialog } from "./AddAccessDialog";
import type { AccessEditor } from "./use-access-editor";

interface AccessSectionProps {
  editor: AccessEditor;
  /** Who gets the access ("orders-team"). */
  subject: string;
  description: string;
  mode: AccessGrantMode;
  readOnly?: boolean;
  picker: AccessScopePickerProps;
  /** "Review N scopes" of the enclosing dialog's footer. */
  scopesOpen: boolean;
  onScopesOpenChange: (open: boolean) => void;
}

/**
 * The access list with its Add Access and scope picker dialogs: what the group, user and token
 * dialogs share. The enclosing dialog renders `AccessDialogFooter`, whose link opens the picker.
 */
export function AccessSection({
  editor,
  subject,
  description,
  mode,
  readOnly = false,
  picker,
  scopesOpen,
  onScopesOpenChange,
}: AccessSectionProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  // Scopes of a line being added or edited, opened from Add Access.
  const [draftScopes, setDraftScopes] = useState<string[] | null>(null);
  const shownDraftScopes = useRetainedDialogValue(draftScopes, draftScopes !== null);
  const editingLine = editing === null ? null : (editor.lines[editing] ?? null);

  const edit = (index: number) => {
    if (editor.lines[index]?.kind === "custom") {
      onScopesOpenChange(true);
      return;
    }
    setEditing(index);
    setAddOpen(true);
  };

  return (
    <>
      <AccessPanel
        views={editor.views}
        description={description}
        loading={!editor.catalog.ready}
        onAdd={
          readOnly
            ? undefined
            : () => {
                setEditing(null);
                setAddOpen(true);
              }
        }
        onEdit={readOnly ? undefined : edit}
        onRemove={readOnly ? undefined : editor.removeLine}
      />
      <AddAccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        subject={subject}
        line={editingLine}
        catalog={editor.catalog}
        mode={mode}
        onSave={(line) => editor.saveLine(line, editing ?? undefined)}
        onReviewScopes={setDraftScopes}
      />
      <AccessScopesDialog
        open={scopesOpen}
        onOpenChange={onScopesOpenChange}
        title={`Scopes of ${subject}`}
        scopes={editor.scopes}
        picker={picker}
        onApply={readOnly ? undefined : editor.replaceScopes}
      />
      <AccessScopesDialog
        open={draftScopes !== null}
        onOpenChange={(open) => {
          if (!open) setDraftScopes(null);
        }}
        title={editingLine ? "Scopes of this access" : "Scopes of the new access"}
        scopes={shownDraftScopes ?? []}
        picker={{ ...picker, inheritedScopes: undefined, inheritedFromName: undefined }}
        onApply={(scopes) => {
          editor.replaceScopes([...editor.scopesWithout(editing ?? undefined), ...scopes]);
          setAddOpen(false);
        }}
      />
    </>
  );
}
