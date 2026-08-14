import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { GitHubOAuthSession, GitHubOAuthStartRequest } from "@/types/integrations";

export function GitHubDeviceFlow({
  request,
  disabled,
  onCompleted,
}: {
  request: GitHubOAuthStartRequest;
  disabled?: boolean;
  onCompleted: (connectorId: string) => void | Promise<void>;
}) {
  const [session, setSession] = useState<GitHubOAuthSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const sessionRef = useRef<GitHubOAuthSession | null>(null);
  sessionRef.current = session;

  useEffect(
    () => () => {
      const current = sessionRef.current;
      if (current?.status === "pending" || current?.status === "processing") {
        void api.cancelGitHubOAuth(current.id).catch(() => {});
      }
    },
    []
  );

  useEffect(() => {
    if (!session || (session.status !== "pending" && session.status !== "processing")) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.getGitHubOAuthStatus(session.id);
        if (cancelled) return;
        setSession(next);
        if (next.status === "complete" && next.connectorId) await onCompleted(next.connectorId);
        else if (["error", "expired", "cancelled"].includes(next.status)) {
          toast.error(next.errorMessage ?? "GitHub authorization did not complete");
        }
      } catch (cause) {
        if (!cancelled) {
          toast.error(cause instanceof Error ? cause.message : "GitHub authorization check failed");
          setPollAttempt((current) => current + 1);
        }
      }
    }, Math.max(1, session.pollIntervalSeconds) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onCompleted, pollAttempt, session]);

  const start = async () => {
    setStarting(true);
    try {
      // Deliberately do not open GitHub here. The code must be visible before
      // the user explicitly chooses to leave the Gateway tab.
      setSession(await api.startGitHubOAuth(request));
      setPollAttempt(0);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "GitHub authorization could not be started");
    } finally {
      setStarting(false);
    }
  };

  if (!session) {
    return (
      <Button type="button" disabled={disabled || starting} onClick={() => void start()}>
        {starting ? <Loader2 className="animate-spin" /> : null}
        Start GitHub authorization
      </Button>
    );
  }

  const terminal = ["error", "expired", "cancelled"].includes(session.status);
  if (terminal) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-destructive">
          {session.errorMessage ?? "GitHub authorization did not complete."}
        </p>
        <Button type="button" variant="outline" onClick={() => setSession(null)}>
          Restart authorization
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <CopyValueField
        label="Authorization code"
        value={session.userCode}
        valueClassName="font-mono"
        actions={
          <Button
            type="button"
            variant="ghost"
            className="h-9 rounded-none border-l border-input bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => window.open(session.verificationUri, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open GitHub
          </Button>
        }
      />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Waiting for GitHub authorization…
      </p>
      <p className="text-xs text-muted-foreground">
        Code expires {new Date(session.expiresAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}
