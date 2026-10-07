import { EditableStringList } from "@/components/common/EditableStringList";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SegmentedChoice, type SegmentedChoiceOption } from "@/components/ui/segmented-choice";
import { hasScopeBase } from "@/lib/scope-utils";
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

const SCOPE_OPTIONS: SegmentedChoiceOption<"all" | "selected">[] = [
  { value: "all", label: "All repositories" },
  { value: "selected", label: "Selected" },
];

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

  const levelOptions: SegmentedChoiceOption<RegistryLevel>[] = [
    { value: "none", label: "None" },
    ...(canPull || level !== "none" ? [{ value: "pull" as const, label: "Pull" }] : []),
    ...(canPush || level === "push" ? [{ value: "push" as const, label: "Pull and push" }] : []),
  ];
  const changeLevel = (next: RegistryLevel) => {
    if (next === "none") onChange({});
    else if (next === "pull") onChange({ pull: value.pull ?? "all" });
    else onChange({ pull: value.pull ?? "all", push: value.push ?? value.pull ?? "all" });
  };
  const actions = (["pull", "push"] as const).filter((action) => value[action] !== undefined);

  return (
    <div className="border border-border">
      <SettingsControlRow
        title="Internal registry"
        description="What docker login with this token may do. Pull needs view access to a Docker workload or image; push needs edit or manage on a workload."
      >
        <SegmentedChoice
          size="sm"
          aria-label="Internal registry access"
          value={level}
          options={levelOptions}
          onChange={changeLevel}
        />
      </SettingsControlRow>
      {actions.map((action) => {
        const repositories = value[action];
        const selected = repositories !== "all";
        return (
          <div key={action} className="border-b border-border last:border-b-0">
            <SettingsControlRow
              className="border-b-0"
              title={action === "pull" ? "Pull from" : "Push to"}
              description="Selected repositories match by exact name, such as team/app."
            >
              <SegmentedChoice
                size="sm"
                aria-label={action === "pull" ? "Pull repositories" : "Push repositories"}
                value={selected ? "selected" : "all"}
                options={SCOPE_OPTIONS}
                onChange={(choice) =>
                  onChange({ ...value, [action]: choice === "all" ? "all" : [] })
                }
              />
            </SettingsControlRow>
            {selected ? (
              <div className="px-4 pb-3">
                <EditableStringList
                  values={repositories ?? []}
                  onChange={(names) => onChange({ ...value, [action]: names })}
                  placeholder="team/app"
                  itemLabel="Repository"
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
