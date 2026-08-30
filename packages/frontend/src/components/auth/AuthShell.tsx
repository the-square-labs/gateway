import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

export function AuthShell({
  children,
  contentClassName,
  footerLeading,
  wide = false,
}: {
  children: React.ReactNode;
  contentClassName?: string;
  footerLeading?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div
        className={cn(
          "w-full space-y-6 text-center",
          wide ? "max-w-md" : "max-w-sm",
          contentClassName
        )}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            <img src="/android-chrome-192x192.png" alt="Gateway" className="h-10 w-10" />
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Gateway</h1>
          </div>
          <p className="text-sm text-muted-foreground">Infrastructure control plane</p>
        </div>
        {children}
        <div className="flex flex-col items-center gap-2 pt-3 text-xs text-muted-foreground">
          {footerLeading}
          <p>
            Powered by{" "}
            <a
              href="https://thesquarelabs.com"
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:underline"
            >
              Square Labs
            </a>
          </p>
        </div>
      </div>
      <Toaster position="bottom-center" />
    </div>
  );
}
