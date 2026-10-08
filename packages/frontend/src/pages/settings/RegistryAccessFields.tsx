import { EditableStringList } from "@/components/common/EditableStringList";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { hasScopeBase } from "@/lib/scope-utils";
import { hasLicenseFeature } from "@/stores/license-paywall";
import type { TokenRegistryAccess } from "@/types";

type RegistryAction = "pull" | "push";
type RegistryLevel = "none" | "pull" | "push";

/** The legacy registry scopes: a token's registry access is set here, not in its scope list. */
export const LEGACY_REGISTRY_SCOPES = new Set([
  "docker:registries:internal:pull",
  "docker:registries:internal:push",
]);

/** What lets a user give a token each action; mirrors token-registry-access.ts in the backend. */
const REGISTRY_ACCESS_BASIS: Record<RegistryAction, readonly string[]> = {
  pull: ["docker:containers:view", "docker:compose:view", "docker:images:view"],
  push: ["docker:containers:edit", "docker:containers:manage", "docker:compose:manage"],
};

function mayGive(userScopes: readonly string[], action: RegistryAction): boolean {
  const scopes = [...REGISTRY_ACCESS_BASIS[action], `docker:registries:internal:${action}`];
  return scopes.some((scope) => hasScopeBase(userScopes, scope));
}

function levelOf(access: TokenRegistryAccess): RegistryLevel {
  if (access.push) return "push";
  return access.pull ? "pull" : "none";
}

export function hasTokenRegistryAccess(access: TokenRegistryAccess): boolean {
  return levelOf(access) !== "none";
}

/** Repository lists trimmed, without blank rows; an error when a narrowed action names none. */
export function finalRegistryAccess(access: TokenRegistryAccess): {
  access: TokenRegistryAccess;
  error: string | null;
} {
  const result: TokenRegistryAccess = {};
  for (const action of ["pull", "push"] as const) {
    const repositories = access[action];
    if (repositories === undefined) continue;
    if (repositories === "all") {
      result[action] = "all";
      continue;
    }
    const names = [...new Set(repositories.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) {
      return { access: result, error: `Enter at least one repository to ${action}` };
    }
    result[action] = names;
  }
  return { access: result, error: null };
}

export function registryAccessSummary(access: TokenRegistryAccess | undefined): string | null {
  if (!access || !hasTokenRegistryAccess(access)) return null;
  return access.push ? "Registry: pull and push" : "Registry: pull";
}

/**
 * Whether a token can be given internal registry access: `docker login` reaches the registry only
 * through its external endpoint (Settings, Internal registry, external access, Business+). While
 * that is off the option is hidden and a token's stored access is left as it is.
 */
export function registryAccessOffered(externalAccessEnabled: boolean | null): boolean {
  return externalAccessEnabled === true && hasLicenseFeature("git-push-to-deploy") === true;
}

const LEVEL_LABELS: Record<RegistryLevel, string> = {
  none: "None",
  pull: "Pull",
  push: "Pull and push",
};

/**
 * Internal registry access of an API token (`docker login` with the token). Pull is offered to
 * users who can view a Docker workload or image, push to users who can change a workload; either
 * may be narrowed to repositories.
 */
export function RegistryAccessFields({
  value,
  onChange,
  userScopes,
}: {
  value: TokenRegistryAccess;
  onChange: (value: TokenRegistryAccess) => void;
  userScopes: readonly string[];
}) {
  const level = levelOf(value);
  const canPull = mayGive(userScopes, "pull");
  const canPush = mayGive(userScopes, "push");
  if (!canPull && level === "none") return null;

  const levels: RegistryLevel[] = [
    "none",
    ...(canPull || level !== "none" ? (["pull"] as const) : []),
    ...(canPush || level === "push" ? (["push"] as const) : []),
  ];
  const changeLevel = (next: RegistryLevel) => {
    if (next === "none") onChange({});
    else if (next === "pull") onChange({ pull: value.pull ?? "all" });
    else onChange({ pull: value.pull ?? "all", push: value.push ?? value.pull ?? "all" });
  };
  const actions = (["pull", "push"] as const).filter((action) => value[action] !== undefined);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Internal registry</label>
        <Select value={level} onValueChange={(next) => changeLevel(next as RegistryLevel)}>
          <SelectTrigger aria-label="Internal registry access">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levels.map((item) => (
              <SelectItem key={item} value={item}>
                {LEVEL_LABELS[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          What docker login with this token may do. Pull needs view access to a Docker workload or
          image; push needs edit or manage on a workload.
        </p>
      </div>
      {actions.map((action) => {
        const repositories = value[action];
        const selected = repositories !== "all";
        const title = action === "pull" ? "Pull from" : "Push to";
        return (
          <div key={action} className="space-y-1.5">
            <label className="text-sm font-medium">{title}</label>
            <Select
              value={selected ? "selected" : "all"}
              onValueChange={(choice) =>
                onChange({ ...value, [action]: choice === "all" ? "all" : [] })
              }
            >
              <SelectTrigger
                aria-label={action === "pull" ? "Pull repositories" : "Push repositories"}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All repositories</SelectItem>
                <SelectItem value="selected">Selected repositories</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Selected repositories match by exact name, such as team/app.
            </p>
            {selected ? (
              <EditableStringList
                values={repositories ?? []}
                onChange={(names) => onChange({ ...value, [action]: names })}
                placeholder="team/app"
                itemLabel="Repository"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
