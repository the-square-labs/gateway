import { Combobox } from "@/components/common/Combobox";

export function groupSelectionLabel(
  ids: readonly string[],
  groups: readonly { id: string; name: string }[],
  fallback = "Select groups"
) {
  return ids.length > 1
    ? `${ids.length} groups`
    : (groups.find((group) => group.id === ids[0])?.name ?? fallback);
}

export function UserGroupSelect({
  value,
  groups,
  onChange,
  disabled = false,
  fallback,
}: {
  value: string[];
  groups: { id: string; name: string }[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  fallback?: string;
}) {
  return (
    <Combobox
      multiple
      freeText={false}
      value={value}
      onValueChange={onChange}
      ariaLabel="Permission groups"
      placeholder="Select groups"
      searchPlaceholder="Search groups..."
      selectionLabel={(ids) => groupSelectionLabel(ids, groups, fallback)}
      options={groups.map((group) => ({
        value: group.id,
        label: group.name,
        disabled: disabled || (value.length === 1 && value[0] === group.id),
      }))}
    />
  );
}
