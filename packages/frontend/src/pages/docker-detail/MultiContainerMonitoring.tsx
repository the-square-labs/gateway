import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/services/api";
import type { InspectData } from "./helpers";
import { StatsTab } from "./StatsTab";

export interface ContainerMonitoringInstance {
  id: string;
  groupTitle?: string;
  title: string;
  description?: string;
  nodeId: string;
  containerId: string;
  data?: InspectData;
}

type ProcessSnapshot = {
  titles: string[];
  rows: string[][];
  status: "loading" | "ready" | "error";
  truncated?: boolean;
  totalProcesses?: number;
  limit?: number;
};

const PROCESS_COLUMN_WIDTHS: Record<string, string> = {
  PID: "88px",
  USER: "140px",
  "%CPU": "88px",
  "%MEM": "88px",
  VSZ: "100px",
  RSS: "100px",
  TT: "72px",
  STAT: "88px",
  STARTED: "140px",
  TIME: "120px",
};

function processColumnStyle(title: string, index: number, titles: string[]) {
  const flexibleIndex = titles.findIndex((item) => item.toUpperCase() === "COMMAND");
  if (index === (flexibleIndex >= 0 ? flexibleIndex : titles.length - 1)) return undefined;
  return { width: PROCESS_COLUMN_WIDTHS[title.toUpperCase()] ?? "120px" };
}

function normalizeProcessSnapshot(result: {
  Titles?: string[];
  Processes?: string[][];
  truncated?: boolean;
  totalProcesses?: number;
  limit?: number;
}): ProcessSnapshot {
  const ttyIndex = result.Titles?.findIndex((title) => title === "TTY" || title === "TT") ?? -1;
  return {
    titles: result.Titles?.filter((_, index) => index !== ttyIndex) ?? [],
    rows: result.Processes?.map((row) => row.filter((_, index) => index !== ttyIndex)) ?? [],
    status: "ready",
    truncated: result.truncated,
    totalProcesses: result.totalProcesses,
    limit: result.limit,
  };
}

function fallbackInspect(): InspectData {
  return {
    State: {
      Running: true,
      Status: "running",
    },
  } as InspectData;
}

export function MultiContainerMonitoring({
  instances,
}: {
  instances: ContainerMonitoringInstance[];
}) {
  const identity = useMemo(
    () =>
      instances
        .map((instance) => `${instance.id}:${instance.nodeId}:${instance.containerId}`)
        .join("|"),
    [instances]
  );
  const [inspectById, setInspectById] = useState<Record<string, InspectData>>({});
  const [processesById, setProcessesById] = useState<Record<string, ProcessSnapshot>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [readyStats, setReadyStats] = useState<Record<string, string>>({});
  const instancesRef = useRef(instances);
  const identityRef = useRef(identity);
  instancesRef.current = instances;
  identityRef.current = identity;
  const groups = useMemo(() => {
    const grouped = new Map<string, { title?: string; instances: ContainerMonitoringInstance[] }>();
    for (const instance of instances) {
      const key = instance.groupTitle ? `group:${instance.groupTitle}` : `instance:${instance.id}`;
      const group = grouped.get(key) ?? { title: instance.groupTitle, instances: [] };
      group.instances.push(instance);
      grouped.set(key, group);
    }
    return [...grouped.entries()].map(([id, group]) => ({ id, ...group }));
  }, [instances]);

  useEffect(() => {
    let cancelled = false;
    const requestedIdentity = identity;
    const currentInstances = instancesRef.current;
    setInspectById({});
    void Promise.all(
      currentInstances.map(async (instance) => {
        if (instance.data) return [instance.id, instance.data] as const;
        try {
          return [
            instance.id,
            (await api.inspectContainer(
              instance.nodeId,
              instance.containerId,
              true
            )) as InspectData,
          ] as const;
        } catch {
          return [instance.id, fallbackInspect()] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled && identityRef.current === requestedIdentity) {
        setInspectById(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    const requestedIdentity = identity;
    const currentInstances = instancesRef.current;
    setProcessesById(
      Object.fromEntries(
        currentInstances.map((instance) => [
          instance.id,
          { titles: [], rows: [], status: "loading" } satisfies ProcessSnapshot,
        ])
      )
    );
    const load = async () => {
      const entries = await Promise.all(
        currentInstances.map(async (instance) => {
          try {
            const result = await api.getContainerTop(instance.nodeId, instance.containerId);
            return [instance.id, normalizeProcessSnapshot(result)] as const;
          } catch {
            return [
              instance.id,
              { titles: [], rows: [], status: "error" } satisfies ProcessSnapshot,
            ] as const;
          }
        })
      );
      if (!cancelled && identityRef.current === requestedIdentity) {
        setProcessesById(Object.fromEntries(entries));
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [identity]);

  if (instances.length === 0) {
    return (
      <PanelShell title="Monitoring">
        <div className="px-4 py-8 text-sm text-muted-foreground">
          No serving instances are available for monitoring.
        </div>
      </PanelShell>
    );
  }

  const processTitles = instances
    .map((instance) => processesById[instance.id]?.titles)
    .find((titles) => titles && titles.length > 0) ?? ["COMMAND"];
  // Keep the initial page-load registration alive across inspect -> stats.
  // StatsTab mounts after inspect, too late to register with PageTransition itself.
  const initialLoadPending = instances.some(
    (instance) =>
      readyStats[instance.id] !== identity ||
      !processesById[instance.id] ||
      processesById[instance.id].status === "loading"
  );

  return (
    <div className="space-y-4 pb-6">
      {initialLoadPending && <Skeleton />}
      {groups.map((group) => (
        <section key={group.id} className="space-y-4">
          {group.title && (
            <h2 className="text-base font-semibold text-foreground">{group.title}</h2>
          )}
          {group.instances.map((instance) => {
            const inspect = inspectById[instance.id] ?? instance.data;
            return (
              <div key={instance.id} className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{instance.title}</h3>
                  {instance.description && (
                    <p className="text-xs text-muted-foreground">{instance.description}</p>
                  )}
                </div>
                {inspect ? (
                  <StatsTab
                    nodeId={instance.nodeId}
                    containerId={instance.containerId}
                    data={inspect}
                    showProcesses={false}
                    className="pb-0"
                    onInitialLoadComplete={() => {
                      if (identityRef.current !== identity) return;
                      setReadyStats((previous) =>
                        previous[instance.id] === identity
                          ? previous
                          : { ...previous, [instance.id]: identity }
                      );
                    }}
                  />
                ) : (
                  <Skeleton />
                )}
              </div>
            );
          })}
        </section>
      ))}

      <PanelShell
        title="Processes"
        description="Running processes grouped by container instance."
        bodyClassName="overflow-x-auto"
      >
        <table className="w-full min-w-[1120px] table-fixed">
          <colgroup>
            {processTitles.map((title, columnIndex) => (
              <col key={title} style={processColumnStyle(title, columnIndex, processTitles)} />
            ))}
          </colgroup>
          <thead className="bg-muted">
            <tr className="border-b border-border text-left">
              {processTitles.map((title) => (
                <th
                  key={title}
                  className="px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          {instances.map((instance, instanceIndex) => {
            const snapshot = processesById[instance.id] ?? {
              titles: [],
              rows: [],
              status: "loading" as const,
            };
            const isExpanded = expanded[instance.id] ?? true;
            const isLastInstance = instanceIndex === instances.length - 1;
            const label = instance.groupTitle
              ? `${instance.groupTitle} · ${instance.title}`
              : instance.title;
            return (
              <tbody key={instance.id}>
                <tr className="bg-muted/60">
                  <td colSpan={processTitles.length} className="p-0">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground transition-colors hover:bg-muted/80"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((current) => ({ ...current, [instance.id]: !isExpanded }))
                      }
                    >
                      <span>{label}</span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                  </td>
                </tr>
                <tr className={isLastInstance ? undefined : "border-b border-border"}>
                  <td colSpan={processTitles.length} className="p-0">
                    <div
                      aria-hidden={!isExpanded}
                      inert={isExpanded ? undefined : true}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                      }`}
                    >
                      <div
                        className={`min-h-0 overflow-hidden ${isExpanded ? "border-t border-border" : ""}`}
                      >
                        {snapshot.rows.length > 0 ? (
                          <table className="w-full table-fixed">
                            <colgroup>
                              {processTitles.map((title, columnIndex) => (
                                <col
                                  key={title}
                                  style={processColumnStyle(title, columnIndex, processTitles)}
                                />
                              ))}
                            </colgroup>
                            <tbody>
                              {snapshot.rows.map((row, rowIndex) => (
                                <tr
                                  key={`${instance.id}-${rowIndex}`}
                                  className="border-b border-border last:border-b-0"
                                >
                                  {processTitles.map((title, columnIndex) => (
                                    <td
                                      key={`${title}-${columnIndex}`}
                                      className="px-4 py-2 font-mono text-xs"
                                    >
                                      {row[columnIndex] ?? "—"}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="px-4 py-5 text-sm text-muted-foreground">
                            {snapshot.status === "loading"
                              ? "Loading processes..."
                              : snapshot.status === "error"
                                ? "Process list is temporarily unavailable. Retrying automatically."
                                : "No running processes reported. Retrying automatically."}
                          </div>
                        )}
                        {snapshot.truncated && (
                          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                            Showing first {snapshot.limit ?? snapshot.rows.length} of{" "}
                            {snapshot.totalProcesses ?? "many"} processes.
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            );
          })}
        </table>
      </PanelShell>
    </div>
  );
}
