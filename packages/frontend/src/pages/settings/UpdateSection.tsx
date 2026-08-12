import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { isDevForceUpdatesEnabled } from "@/lib/dev-force-updates";
import { api } from "@/services/api";
import { useUpdateStore } from "@/stores/update";

interface UpdateSectionProps {
  canUpdate: boolean;
}

export function UpdateSection({ canUpdate }: UpdateSectionProps) {
  const {
    status: updateStatus,
    isChecking,
    isUpdating,
    checkForUpdates,
    triggerUpdate,
    fetchStatus,
  } = useUpdateStore();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesList, setReleaseNotesList] = useState<string[] | null>(null);
  const [releaseVersions, setReleaseVersions] = useState<string[] | null>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(updateStatus !== null);

  // Fetch status on mount
  useEffect(() => {
    void fetchStatus().finally(() => setInitialLoadComplete(true));
  }, [fetchStatus]);

  if (!initialLoadComplete) return <Skeleton />;

  const handleCheckUpdate = async () => {
    await checkForUpdates();
    const s = useUpdateStore.getState().status;
    if (s?.updateAvailable) {
      toast.info(`Update available: ${s.latestVersion}`);
    } else {
      toast.success("Already up to date");
    }
  };

  const handleUpdate = async () => {
    if (!updateStatus?.latestVersion) return;
    const ok = await confirm({
      title: "Update Gateway",
      description: `Update from ${updateStatus.currentVersion} to ${updateStatus.latestVersion}? The application will restart automatically.`,
      confirmLabel: "Update",
    });
    if (!ok) return;
    if (isDevForceUpdatesEnabled()) {
      toast.info("Local update preview only");
      return;
    }
    triggerUpdate(updateStatus.latestVersion);
  };

  return (
    <>
      {/* Update available */}
      {updateStatus?.updateAvailable && updateStatus.latestVersion && (
        <PanelShell
          title={<span className="text-warning">Update Available</span>}
          description={`${updateStatus.latestVersion} is ready to install`}
          className="xl:col-span-2"
          dirty
          actions={
            <>
              {updateStatus.releaseNotes && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    setReleaseNotesOpen(true);
                    try {
                      const all = await api.getAllReleaseNotes();
                      if (all.length > 0) {
                        setReleaseVersions(all.map((r) => r.version));
                        setReleaseNotesList(all.map((r) => r.notes));
                      }
                    } catch {
                      // Fallback: just show the cached latest release notes
                    }
                  }}
                >
                  Release notes
                </Button>
              )}
              {canUpdate && (
                <Button
                  onClick={handleUpdate}
                  className="bg-warning text-black hover:bg-warning/90"
                >
                  Update to {updateStatus.latestVersion}
                </Button>
              )}
            </>
          }
        >
          <div className="divide-y divide-border">
            <DetailRow label="Current version" value={updateStatus.currentVersion} />
            <DetailRow label="New version" value={updateStatus.latestVersion} />
          </div>
        </PanelShell>
      )}

      {/* About */}
      <PanelShell
        title="About"
        description="Application info and updates"
        actions={
          canUpdate ? (
            <Button onClick={handleCheckUpdate} disabled={isChecking}>
              {isChecking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Check for updates
            </Button>
          ) : null
        }
      >
        <div className="border-b border-border p-4">
          <div className="flex items-center gap-4">
            <img src="/android-chrome-192x192.png" alt="Gateway" className="h-10 w-10" />
            <div>
              <p className="text-sm font-semibold">Gateway</p>
              <p className="text-xs text-muted-foreground">
                Self-hosted infrastructure control plane
              </p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          <DetailRow label="Version" value={updateStatus?.currentVersion ?? "..."} />
          <DetailRow
            label="Status"
            value={
              updateStatus?.updateAvailable ? (
                <Badge variant="warning">Update available</Badge>
              ) : (
                <Badge variant="success">Up to date</Badge>
              )
            }
          />
          {updateStatus?.lastCheckedAt && (
            <DetailRow
              label="Last checked"
              value={new Date(updateStatus.lastCheckedAt).toLocaleString()}
            />
          )}
        </div>
      </PanelShell>

      {/* Updating overlay */}
      {isUpdating &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-4 text-center">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
              <div>
                <h2 className="text-lg font-semibold">Updating Gateway</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Updating to {updateStatus?.latestVersion}. The application will restart
                  automatically.
                </p>
                <p className="text-xs text-muted-foreground mt-3">This may take a minute...</p>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Release Notes Dialog */}
      <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Release Notes</DialogTitle>
          </DialogHeader>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            {(releaseNotesList ?? [updateStatus?.releaseNotes]).filter(Boolean).map((notes, i) => (
              <div key={i}>
                {releaseNotesList && releaseNotesList.length > 1 && (
                  <h3 className="text-base font-semibold mt-0">{releaseVersions?.[i]}</h3>
                )}
                <Markdown>{notes ?? ""}</Markdown>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
