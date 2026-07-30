import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import type { GitLabUserCredentialStatus } from "@/types/integrations";

export function GitLabAuthorizationModal() {
  const { pendingCredentialChallenge, resolveCredentialChallenge } = useAIStore();
  const [metadata, setMetadata] = useState<GitLabUserCredentialStatus | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const challenge = pendingCredentialChallenge;
    setMetadata(null);
    setToken("");
    setError(null);
    if (!challenge) return;

    let cancelled = false;
    void api
      .getGitLabUserCredentialStatus(challenge.connectorId)
      .then((status) => {
        if (cancelled) return;
        setMetadata(status);
        if (status.authorized) resolveCredentialChallenge("authorized");
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Failed to load GitLab authorization details"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pendingCredentialChallenge, resolveCredentialChallenge]);

  useEffect(() => {
    if (error && !loading) inputRef.current?.focus();
  }, [error, loading]);

  if (!pendingCredentialChallenge) return null;

  const submit = async () => {
    const nextToken = token.trim();
    if (!nextToken || loading) return;
    setLoading(true);
    setError(null);
    try {
      const status = await api.authorizeGitLabUserCredential(
        pendingCredentialChallenge.connectorId,
        nextToken
      );
      setMetadata(status);
      setToken("");
      resolveCredentialChallenge("authorized");
    } catch (requestError) {
      setToken("");
      setError(requestError instanceof Error ? requestError.message : "GitLab rejected this token");
    } finally {
      setLoading(false);
    }
  };

  const reject = () => {
    if (loading) return;
    setToken("");
    resolveCredentialChallenge("rejected");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && reject()}>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>Authorize GitLab</DialogTitle>
          <DialogDescription>
            Gateway needs your personal access token for this connector. It is sent directly to
            Gateway, stored encrypted, used only for this GitLab connector, and never added to the
            AI conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div className="font-medium">{metadata?.connectorName ?? "GitLab connector"}</div>
            <div className="mt-1 break-all text-xs text-muted-foreground">
              {metadata?.baseUrl ?? "Loading connector details…"}
            </div>
          </div>

          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>Open GitLab’s personal access token page using the link below.</li>
            <li>Review the expiry and keep the preselected API scope.</li>
            <li>Generate the “Gateway AI” token and copy it before leaving the page.</li>
            <li>Return here and paste the token below.</li>
          </ol>

          {metadata?.patCreationUrl ? (
            <Button variant="outline" className="w-full" asChild>
              <a href={metadata.patCreationUrl} target="_blank" rel="noopener noreferrer">
                Create personal access token in GitLab
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="gitlab-personal-token" className="text-sm font-medium">
              Personal access token
            </label>
            <Input
              ref={inputRef}
              id="gitlab-personal-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              autoComplete="off"
              autoFocus
              disabled={loading}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "gitlab-personal-token-error" : undefined}
            />
            {error ? (
              <p
                id="gitlab-personal-token-error"
                className="text-sm text-destructive"
                role="alert"
                aria-live="polite"
              >
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={reject} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={loading || !token.trim()}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {loading ? "Checking GitLab access…" : "Authorize"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
