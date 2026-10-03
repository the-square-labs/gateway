import { CheckboxCard } from "@/components/common/CheckboxCard";
import type { HostAccessInstallOptions as Options } from "@/lib/node-host-access";

/**
 * Setup command options that turn host access off on the node being installed. The installer writes them to the
 * daemon config on the node, where Gateway cannot turn them back on.
 */
export function HostAccessInstallOptions({
  value,
  onChange,
}: {
  value: Options;
  onChange: (value: Options) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <CheckboxCard
        checked={value.disableConsole}
        onCheckedChange={(disableConsole) => onChange({ ...value, disableConsole })}
        label="Disable host console"
        description="Adds --disable-console: no shell or console commands on this host from Gateway."
      />
      <CheckboxCard
        checked={value.disableFiles}
        onCheckedChange={(disableFiles) => onChange({ ...value, disableFiles })}
        label="Disable host files"
        description="Adds --disable-files: no host file browsing or writes from Gateway. Disable both to remove host access."
      />
    </div>
  );
}
