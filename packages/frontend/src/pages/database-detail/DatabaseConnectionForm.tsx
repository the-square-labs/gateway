import { AnimatePresence, motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  ClickHouseDatabaseConfig,
  DatabaseConnection,
  DatabaseType,
  PostgresDatabaseConfig,
  RedisDatabaseConfig,
} from "@/types";

const CONNECTION_FIELDS_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export interface DatabaseConnectionDraft {
  name: string;
  description: string;
  tags: string;
  manualSizeLimitMb: string;
  type: DatabaseType;
  connectionMethod: "credentials" | "uri";
  connectionString: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
  db: string;
  tlsEnabled: boolean;
  hasStoredPassword?: boolean;
}

function isValidPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hasValidConnectionUri(type: DatabaseType, value: string) {
  try {
    const url = new URL(value.trim());
    if (!url.hostname || !url.username || !url.password) return false;
    if (type === "postgres") {
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        decodeURIComponent(url.pathname.replace(/^\//, "")).trim().length > 0
      );
    }
    if (type === "clickhouse") {
      return (
        ["http:", "https:"].includes(url.protocol) &&
        (url.searchParams.get("database")?.trim().length ?? 0) > 0
      );
    }
    const db = Number(url.pathname.replace(/^\//, "") || "0");
    return (
      ["redis:", "rediss:"].includes(url.protocol) && Number.isInteger(db) && db >= 0 && db <= 15
    );
  } catch {
    return false;
  }
}

export function canCreateDatabase(draft: DatabaseConnectionDraft) {
  if (!draft.name.trim()) return false;
  if (draft.connectionMethod === "uri") {
    return hasValidConnectionUri(draft.type, draft.connectionString);
  }
  if (!draft.host.trim() || !isValidPort(draft.port) || draft.password.length === 0) return false;
  if (draft.type === "redis") {
    const db = Number(draft.db);
    return Number.isInteger(db) && db >= 0 && db <= 15;
  }
  return Boolean(draft.database.trim() && draft.username.trim());
}

export function draftFromConnection(
  connection?: DatabaseConnection | null
): DatabaseConnectionDraft {
  if (!connection) {
    return {
      name: "",
      description: "",
      tags: "",
      manualSizeLimitMb: "",
      type: "postgres",
      connectionMethod: "credentials",
      connectionString: "",
      host: "",
      port: "5432",
      database: "",
      username: "",
      password: "",
      sslEnabled: false,
      db: "0",
      tlsEnabled: false,
      hasStoredPassword: false,
    };
  }

  if (connection.type === "postgres") {
    const config = connection.config as PostgresDatabaseConfig;
    return {
      name: connection.name,
      description: connection.description ?? "",
      tags: connection.tags.join(", "),
      manualSizeLimitMb:
        connection.manualSizeLimitMb != null ? String(connection.manualSizeLimitMb) : "",
      type: "postgres",
      connectionMethod: "credentials",
      connectionString: "",
      host: config.host,
      port: String(config.port),
      database: config.database,
      username: config.username,
      password: "",
      sslEnabled: config.sslEnabled,
      db: "0",
      tlsEnabled: false,
      hasStoredPassword: connection.hasStoredPassword,
    };
  }

  if (connection.type === "clickhouse") {
    const config = connection.config as ClickHouseDatabaseConfig;
    return {
      name: connection.name,
      description: connection.description ?? "",
      tags: connection.tags.join(", "),
      manualSizeLimitMb: "",
      type: "clickhouse",
      connectionMethod: "credentials",
      connectionString: "",
      host: config.host,
      port: String(config.port),
      database: config.database,
      username: config.username,
      password: "",
      sslEnabled: false,
      db: "0",
      tlsEnabled: config.tlsEnabled,
      hasStoredPassword: connection.hasStoredPassword,
    };
  }

  const config = connection.config as RedisDatabaseConfig;
  return {
    name: connection.name,
    description: connection.description ?? "",
    tags: connection.tags.join(", "),
    manualSizeLimitMb: "",
    type: "redis",
    connectionMethod: "credentials",
    connectionString: "",
    host: config.host,
    port: String(config.port),
    database: "",
    username: config.username ?? "",
    password: "",
    sslEnabled: false,
    db: String(config.db),
    tlsEnabled: config.tlsEnabled,
    hasStoredPassword: connection.hasStoredPassword,
  };
}

export function buildDatabasePayload(draft: DatabaseConnectionDraft): Record<string, unknown> {
  const tags = draft.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (draft.type === "postgres") {
    return {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      tags,
      manualSizeLimitMb:
        draft.manualSizeLimitMb.trim() === "" ? null : Number(draft.manualSizeLimitMb),
      type: "postgres",
      config: {
        ...(draft.connectionMethod === "uri"
          ? { connectionString: draft.connectionString.trim() }
          : {
              ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
              ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
              ...(draft.database.trim() ? { database: draft.database.trim() } : {}),
              ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
              ...(draft.password !== "" ? { password: draft.password } : {}),
              sslEnabled: draft.sslEnabled,
            }),
      },
    };
  }

  if (draft.type === "clickhouse") {
    return {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      tags,
      type: "clickhouse",
      config: {
        ...(draft.connectionMethod === "uri"
          ? { connectionString: draft.connectionString.trim() }
          : {
              ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
              ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
              ...(draft.database.trim() ? { database: draft.database.trim() } : {}),
              ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
              ...(draft.password !== "" ? { password: draft.password } : {}),
              tlsEnabled: draft.tlsEnabled,
            }),
      },
    };
  }

  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    tags,
    type: "redis",
    config: {
      ...(draft.connectionMethod === "uri"
        ? { connectionString: draft.connectionString.trim() }
        : {
            ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
            ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
            ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
            ...(draft.password !== "" ? { password: draft.password } : {}),
            db: Number(draft.db || "0"),
            tlsEnabled: draft.tlsEnabled,
          }),
    },
  };
}

export function DatabaseConnectionForm({
  draft,
  onChange,
  disableType = false,
  mode = "full",
}: {
  draft: DatabaseConnectionDraft;
  onChange: (next: DatabaseConnectionDraft) => void;
  disableType?: boolean;
  mode?: "full" | "metadata";
}) {
  const set = <K extends keyof DatabaseConnectionDraft>(
    key: K,
    value: DatabaseConnectionDraft[K]
  ) => onChange({ ...draft, [key]: value });
  const metadataOnly = mode === "metadata";

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${metadataOnly ? "md:grid-cols-1" : "md:grid-cols-2"}`}>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Name</label>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        {!metadataOnly && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Type</label>
            <Select
              value={draft.type}
              onValueChange={(value) =>
                onChange({
                  ...draft,
                  type: value as DatabaseType,
                  port: value === "postgres" ? "5432" : value === "clickhouse" ? "8123" : "6379",
                  connectionString: "",
                  host: "",
                  database: "",
                  username: "",
                  password: "",
                  db: "0",
                  manualSizeLimitMb: value === "postgres" ? draft.manualSizeLimitMb : "",
                  sslEnabled: false,
                  tlsEnabled: false,
                })
              }
              disabled={disableType}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">Postgres</SelectItem>
                <SelectItem value="clickhouse">ClickHouse</SelectItem>
                <SelectItem value="redis">Redis</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Description</label>
        <Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Tags</label>
        <Input
          placeholder="team, red:production, green:analytics"
          value={draft.tags}
          onChange={(e) => set("tags", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple, pink,
          orange, gray.
        </p>
      </div>

      {metadataOnly && draft.type === "postgres" && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Size Limit (MB)</label>
          <Input
            type="number"
            min="1"
            step="1"
            placeholder="Optional"
            value={draft.manualSizeLimitMb}
            onChange={(e) => set("manualSizeLimitMb", e.target.value)}
          />
        </div>
      )}

      {!metadataOnly && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="database-connection-method" className="text-sm font-medium">
              Connection method
            </label>
            <Select
              value={draft.connectionMethod}
              onValueChange={(value) =>
                set("connectionMethod", value as DatabaseConnectionDraft["connectionMethod"])
              }
            >
              <SelectTrigger id="database-connection-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="credentials">Credentials</SelectItem>
                <SelectItem value="uri">Connection URI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="relative overflow-hidden">
            <AnimatePresence initial={false} mode="popLayout">
              {draft.connectionMethod === "uri" ? (
                <motion.div
                  key={`uri-${draft.type}`}
                  {...CONNECTION_FIELDS_ANIMATION}
                  className="space-y-1.5 overflow-hidden"
                >
                  <label htmlFor="database-connection-uri" className="text-sm font-medium">
                    Connection URI
                  </label>
                  <Input
                    id="database-connection-uri"
                    placeholder={
                      draft.type === "postgres"
                        ? "postgresql://user:password@host:5432/database"
                        : draft.type === "clickhouse"
                          ? "https://user:password@clickhouse.example.com:8443?database=analytics"
                          : "redis://:password@host:6379/0"
                    }
                    value={draft.connectionString}
                    onChange={(e) => set("connectionString", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Include credentials and the TLS scheme in the URI.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key={`credentials-${draft.type}`}
                  {...CONNECTION_FIELDS_ANIMATION}
                  className="space-y-3 overflow-hidden"
                >
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),140px]">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Host</label>
                      <Input value={draft.host} onChange={(e) => set("host", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Port</label>
                      <Input value={draft.port} onChange={(e) => set("port", e.target.value)} />
                    </div>
                  </div>

                  {draft.type !== "redis" ? (
                    <>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Database</label>
                          <Input
                            value={draft.database}
                            onChange={(e) => set("database", e.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Username</label>
                          <Input
                            value={draft.username}
                            onChange={(e) => set("username", e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Password</label>
                        <Input
                          type="password"
                          placeholder={
                            draft.hasStoredPassword ? "Leave blank to keep current password" : ""
                          }
                          value={draft.password}
                          onChange={(e) => set("password", e.target.value)}
                        />
                        {draft.hasStoredPassword && draft.password === "" && (
                          <Badge variant="secondary">Existing password preserved</Badge>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-4 border border-border bg-card px-3 py-2.5">
                        <div>
                          <p className="text-sm font-medium">TLS / SSL</p>
                          <p className="text-xs text-muted-foreground">
                            {draft.type === "postgres"
                              ? "Require TLS for the Postgres connection"
                              : "Use HTTPS for the ClickHouse connection"}
                          </p>
                        </div>
                        <Switch
                          checked={draft.type === "postgres" ? draft.sslEnabled : draft.tlsEnabled}
                          onChange={(checked) =>
                            draft.type === "postgres"
                              ? set("sslEnabled", checked)
                              : set("tlsEnabled", checked)
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),140px]">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Username</label>
                          <Input
                            value={draft.username}
                            onChange={(e) => set("username", e.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Redis DB</label>
                          <Input value={draft.db} onChange={(e) => set("db", e.target.value)} />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Password</label>
                        <Input
                          type="password"
                          placeholder={
                            draft.hasStoredPassword ? "Leave blank to keep current password" : ""
                          }
                          value={draft.password}
                          onChange={(e) => set("password", e.target.value)}
                        />
                        {draft.hasStoredPassword && draft.password === "" && (
                          <Badge variant="secondary">Existing password preserved</Badge>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-4 border border-border bg-card px-3 py-2.5">
                        <div>
                          <p className="text-sm font-medium">TLS</p>
                          <p className="text-xs text-muted-foreground">
                            Use TLS when connecting to Redis
                          </p>
                        </div>
                        <Switch
                          checked={draft.tlsEnabled}
                          onChange={(checked) => set("tlsEnabled", checked)}
                        />
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}
