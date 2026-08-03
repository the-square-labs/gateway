import { KeyRound, Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SetupUnlockStep({
  busy,
  code,
  onSubmit,
  setCode,
}: {
  busy: boolean;
  code: string;
  onSubmit: () => void;
  setCode: (value: string) => void;
}) {
  return (
    <form
      className="space-y-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim() && !busy) onSubmit();
      }}
    >
      <div className="space-y-1 text-center">
        <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
          <LockKeyhole className="h-5 w-5" /> Welcome to Gateway
        </h2>
        <p className="text-sm text-muted-foreground">
          This Gateway has not been configured yet. Enter the one-time setup code printed by the
          installer.
        </p>
      </div>
      <Input
        value={code}
        autoFocus
        autoComplete="off"
        placeholder="gws_…"
        onChange={(event) => setCode(event.target.value)}
      />
      <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        Start setup
      </Button>
    </form>
  );
}
