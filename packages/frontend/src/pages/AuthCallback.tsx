import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

let currentUserRequest: ReturnType<typeof api.getCurrentUser> | null = null;

function loadCurrentUserOnce() {
  if (!currentUserRequest) {
    currentUserRequest = api.getCurrentUser().finally(() => {
      currentUserRequest = null;
    });
  }
  return currentUserRequest;
}

export function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuthStore();

  useEffect(() => {
    let cancelled = false;

    const handleCallback = async () => {
      const errorParam = searchParams.get("error");

      if (errorParam) {
        if (!cancelled) setError(errorParam);
        return;
      }

      try {
        const user = await loadCurrentUserOnce();
        if (cancelled) return;
        login(user);
        navigate("/", { replace: true });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Authentication failed";
        setError(message);
      }
    };

    void handleCallback();

    return () => {
      cancelled = true;
    };
  }, [searchParams, login, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <h2 className="text-lg font-semibold text-foreground">Authentication Failed</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => navigate("/login")}
            className="mt-2 border border-border px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner className="" />
        <p className="text-sm text-muted-foreground">Authenticating...</p>
      </div>
    </div>
  );
}
