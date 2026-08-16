import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ScopeList } from "@/components/common/ScopeList";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import {
  buildFinalScopes,
  canonicalizeScopeSelection,
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
} from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type { DatabaseConnection, LoggingSchema, Node, ProxyHost, User } from "@/types";
import { GROUP_ASSIGNABLE_SCOPES, RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";

interface UserAdditionalPermissionsDialogProps {
  open: boolean;
  user: User | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (user: User) => void;
}

function TabCount({ children }: { children: number }) {
  return (
    <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-current/15 px-1 text-[10px] font-medium leading-none tabular-nums opacity-80">
      {children}
    </span>
  );
}

function findMissingResourceSelection(
  baseScopes: string[],
  resources: Record<string, string[]>,
  allowedResourceIdsByScope: Record<string, string[]>,
  initiallyResourceLimitedScopes: readonly string[]
): string | null {
  for (const scope of baseScopes) {
    if (
      requiresResourceSelection(scope, allowedResourceIdsByScope, initiallyResourceLimitedScopes) &&
      (resources[scope]?.length ?? 0) === 0
    ) {
      return scope;
    }
  }
  return null;
}

export function UserAdditionalPermissionsDialog({
  open,
  user,
  onOpenChange,
  onSaved,
}: UserAdditionalPermissionsDialogProps) {
  const displayedUser = useRetainedDialogValue(user, open);
  const currentUser = useAuthStore((state) => state.user);
  const { cas, fetchCAs } = useCAStore();
  const [baseScopes, setBaseScopes] = useState<string[]>([]);
  const [resources, setResources] = useState<Record<string, string[]>>({});
  const [initialResourceLimitedScopes, setInitialResourceLimitedScopes] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [databases, setDatabases] = useState<DatabaseConnection[]>([]);
  const [loggingSchemas, setLoggingSchemas] = useState<LoggingSchema[]>([]);

  const actorScopes = currentUser?.scopes ?? [];
  const groupScopes = displayedUser?.groupScopes ?? [];
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(actorScopes),
    [actorScopes]
  );
  const assignableScopes = useMemo(
    () =>
      GROUP_ASSIGNABLE_SCOPES.filter((scope) => hasSelectableScopeBase(actorScopes, scope.value)),
    [actorScopes]
  );

  useEffect(() => {
    if (!open || !user) return;
    const parsed = parseScopesForForm(user.additionalScopes ?? []);
    setBaseScopes(parsed.baseScopes);
    setResources(parsed.resources);
    setInitialResourceLimitedScopes(Object.keys(parsed.resources));
    setSearch("");
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    void fetchCAs();
    void api
      .listNodes({ limit: 100 })
      .then((response) => setNodes(response.data ?? []))
      .catch(() => setNodes([]));
    void api
      .listProxyHosts({ limit: 100 })
      .then((response) => setProxyHosts(response.data ?? []))
      .catch(() => setProxyHosts([]));
    void api
      .listDatabases({ limit: 200 })
      .then((response) => setDatabases(response.data ?? []))
      .catch(() => setDatabases([]));
    void api
      .listLoggingSchemas()
      .then((items) => setLoggingSchemas(items ?? []))
      .catch(() => setLoggingSchemas([]));
  }, [fetchCAs, open]);

  const additionalScopes = useMemo(
    () => buildFinalScopes(baseScopes, resources),
    [baseScopes, resources]
  );
  const effectiveScopes = useMemo(
    () => canonicalizeScopeSelection([...groupScopes, ...additionalScopes]),
    [additionalScopes, groupScopes]
  );
  const groupParsed = useMemo(() => parseScopesForForm(groupScopes), [groupScopes]);
  const effectiveParsed = useMemo(() => parseScopesForForm(effectiveScopes), [effectiveScopes]);

  const toggleScope = (scope: string) => {
    setBaseScopes((current) => {
      if (current.includes(scope)) {
        setResources((currentResources) => {
          const next = { ...currentResources };
          delete next[scope];
          return next;
        });
        return current.filter((value) => value !== scope);
      }
      const allowedIds = allowedResourceIdsByScope[scope];
      if (allowedIds?.length) {
        setResources((currentResources) => ({ ...currentResources, [scope]: allowedIds }));
      }
      return [...current, scope];
    });
  };

  const toggleResource = (scope: string, resourceId: string) => {
    const selected = resources[scope] ?? [];
    const nextSelected = selected.includes(resourceId)
      ? selected.filter((id) => id !== resourceId)
      : [...selected, resourceId];
    setResources((current) => ({ ...current, [scope]: nextSelected }));
    setBaseScopes((current) => [...new Set([...current, scope])]);
  };

  const handleSave = async () => {
    if (!user) return;
    const missingScope = findMissingResourceSelection(
      baseScopes,
      resources,
      allowedResourceIdsByScope,
      initialResourceLimitedScopes
    );
    if (missingScope) {
      toast.error(`Select at least one resource for ${missingScope}`);
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateUserAdditionalPermissions(user.id, additionalScopes);
      api.invalidateCache("req:");
      api.invalidateCache("admin:users");
      onSaved(updated);
      onOpenChange(false);
      toast.success("Additional permissions updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update permissions");
    } finally {
      setSaving(false);
    }
  };

  const resetAdditionalPermissions = () => {
    setBaseScopes([]);
    setResources({});
    setInitialResourceLimitedScopes([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Additional permissions</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {displayedUser?.name || displayedUser?.email} receives these permissions in addition to
            the {displayedUser?.groupName} group.
          </p>
        </DialogHeader>

        <Tabs defaultValue="additional">
          <TabsList>
            <TabsTrigger value="additional">
              Additional <TabCount>{additionalScopes.length}</TabCount>
            </TabsTrigger>
            <TabsTrigger value="group">
              Group <TabCount>{groupScopes.length}</TabCount>
            </TabsTrigger>
            <TabsTrigger value="effective">
              Effective <TabCount>{effectiveScopes.length}</TabCount>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="additional" className="border border-border">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search permissions..."
              className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
            />
            <ScopeList
              scopes={assignableScopes}
              search={search}
              selected={baseScopes}
              onToggle={toggleScope}
              resources={resources}
              onToggleResource={toggleResource}
              cas={cas}
              nodes={nodes}
              proxyHosts={proxyHosts}
              databases={databases}
              loggingSchemas={loggingSchemas}
              restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
              allowedResourceIds={allowedResourceIdsByScope}
              inheritedScopes={groupScopes}
              inheritedFromName={displayedUser?.groupName}
              viewportClassName="max-h-[min(25rem,48dvh)] overflow-y-auto overscroll-contain"
            />
          </TabsContent>

          <TabsContent value="group" className="border border-border">
            <ScopeList
              scopes={TOKEN_SCOPES}
              search=""
              selected={groupParsed.baseScopes}
              onToggle={() => {}}
              resources={groupParsed.resources}
              cas={cas}
              nodes={nodes}
              proxyHosts={proxyHosts}
              databases={databases}
              loggingSchemas={loggingSchemas}
              restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
              readOnly
              viewportClassName="max-h-[min(25rem,48dvh)] overflow-y-auto overscroll-contain"
            />
          </TabsContent>

          <TabsContent value="effective" className="border border-border">
            <ScopeList
              scopes={TOKEN_SCOPES}
              search=""
              selected={effectiveParsed.baseScopes}
              onToggle={() => {}}
              resources={effectiveParsed.resources}
              cas={cas}
              nodes={nodes}
              proxyHosts={proxyHosts}
              databases={databases}
              loggingSchemas={loggingSchemas}
              restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
              readOnly
              viewportClassName="max-h-[min(25rem,48dvh)] overflow-y-auto overscroll-contain"
            />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="sm:mr-auto"
            onClick={resetAdditionalPermissions}
            disabled={additionalScopes.length === 0 || saving}
          >
            <RotateCcw />
            Reset additional
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
