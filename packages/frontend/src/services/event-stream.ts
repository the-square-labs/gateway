import { INFERENCE_CATALOG_CHANGED_CHANNEL } from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";

type EventHandler = (payload: unknown) => void;

/** Cache projections warmed independently from the request cache. */
const invalidate = (...prefixes: string[]) => {
  for (const prefix of prefixes) api.invalidateCache(prefix);
};

interface ServerMsg {
  type: string;
  channel?: string;
  payload?: unknown;
  scopes?: string[];
  channels?: string[];
  rejected?: string[];
  message?: string;
}

/**
 * Singleton WebSocket client for the realtime `/api/events` channel.
 * - One persistent connection per session, reconnects with exponential backoff.
 * - `subscribe(channel, handler)` returns an unsubscribe function.
 * - Buffers subscribe requests until the socket is OPEN.
 * - On reconnect, re-issues the current subscription set.
 */
class EventStream {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  /** Channels currently subscribed on the wire (subset of handlers.keys() once acked) */
  private wireSubs = new Set<string>();
  private pendingSubs = new Set<string>();
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Refcount of callers who want the connection open. React StrictMode runs
   * effects mount→cleanup→mount which would otherwise spawn duplicate sockets.
   */
  private refCount = 0;
  /** Microtask handle for the deferred initial open */
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private listeners = new Set<(connected: boolean) => void>();
  private reconnectListeners = new Set<() => void>();
  private hasConnected = false;
  private nodeChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNodeChangedPayload: unknown;

  start() {
    this.refCount++;
    if (this.refCount > 1) return;
    // Defer the actual socket open by one tick so a StrictMode tight
    // mount→cleanup→mount cycle nets to a single connection.
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (this.refCount === 0) return;
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      this.openSocket();
    }, 0);
  }

  stop() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return;
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.nodeChangedTimer) {
      clearTimeout(this.nodeChangedTimer);
      this.nodeChangedTimer = null;
      this.pendingNodeChangedPayload = undefined;
    }
    if (this.ws) {
      const dying = this.ws;
      this.ws = null;
      try {
        dying.onopen = null;
        dying.onmessage = null;
        dying.onclose = null;
        dying.onerror = null;
        dying.close();
      } catch {
        /* ignore */
      }
    }
    this.wireSubs.clear();
    this.pendingSubs.clear();
    this.hasConnected = false;
    this.setConnected(false);
  }

  private get wantOpen() {
    return this.refCount > 0;
  }

  private openSocket() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/events`;
    const ws = new WebSocket(url);
    this.ws = ws;

    // Property-based handlers so stop() can null them out and prevent late
    // events from a closing socket from mutating singleton state after a
    // subsequent start() has already opened a replacement.
    ws.onopen = () => {
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      this.backoffMs = 1000;
      this.setConnected(true);
      const desired = new Set([...this.handlers.keys(), ...this.pendingSubs]);
      this.wireSubs.clear();
      this.pendingSubs.clear();
      if (desired.size > 0) {
        this.sendSubscribe([...desired]);
      }
      if (isReconnect) {
        for (const listener of this.reconnectListeners) listener();
      }
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "event" && msg.channel) {
        // Direct store invalidation for node status changes
        if (msg.channel === "node.changed") {
          const payload = msg.payload as { action?: string; id?: string } | undefined;
          const immediate = payload?.action === "deleted";
          this.scheduleNodeChanged(msg.payload, immediate);
          if (payload?.action === "deleted" && payload.id) {
            usePinnedNodesStore.getState().removePin(payload.id);
          }
          return;
        } else if (msg.channel === "domain.changed") {
          invalidate("req:/api/domains", "domains:list");
        } else if (msg.channel === "ca.changed") {
          api.invalidateCache("req:/api/cas");
          api.invalidateCache("cas:list:");
          api.invalidateCache("req:/api/monitoring/dashboard");
          api.invalidateCache("dashboard:stats:");
        } else if (msg.channel === "cert.changed") {
          api.invalidateCache("req:/api/certificates");
          api.invalidateCache("certificates:list:");
          api.invalidateCache("req:/api/cas");
          api.invalidateCache("cas:list:");
          api.invalidateCache("req:/api/monitoring/dashboard");
          api.invalidateCache("dashboard:stats:");
        } else if (msg.channel === "ssl.cert.changed") {
          api.invalidateCache("req:/api/ssl-certificates");
          api.invalidateCache("ssl:list:");
          api.invalidateCache("req:/api/monitoring/dashboard");
          api.invalidateCache("dashboard:stats:");
        } else if (msg.channel === "proxy.host.changed") {
          api.invalidateCache("req:/api/proxy-hosts");
          api.invalidateCache("req:/api/proxy-host-folders/grouped");
          api.invalidateCache("proxy:grouped");
          api.invalidateCache("req:/api/domains");
          api.invalidateCache("domains:list");
          api.invalidateCache("req:/api/monitoring/dashboard");
          api.invalidateCache("req:/api/monitoring/health-status");
          api.invalidateCache("dashboard:stats:");
          api.invalidateCache("dashboard:health");
          const payload = msg.payload as { action?: string; id?: string } | undefined;
          if (payload?.action === "deleted" && payload.id) {
            usePinnedProxiesStore.getState().removePin(payload.id);
          }
        } else if (msg.channel === "pki.template.changed") {
          invalidate("req:/api/templates", "templates:list");
        } else if (msg.channel === "nginx.template.changed") {
          api.invalidateCache("req:/api/nginx-templates");
          api.invalidateCache("nginx-templates:list");
        } else if (msg.channel === "access-list.changed") {
          api.invalidateCache("req:/api/access-lists");
          api.invalidateCache("access-lists:list");
        } else if (msg.channel === "user.changed") {
          api.invalidateCache("req:/api/admin/users");
          api.invalidateCache("admin:users");
        } else if (msg.channel === "group.changed") {
          api.invalidateCache("req:/api/admin/groups");
          api.invalidateCache("req:/api/admin/users");
          api.invalidateCache("admin:groups");
          api.invalidateCache("admin:users");
        } else if (msg.channel === "docker.registry.changed") {
          api.invalidateCache("req:/api/docker/registries");
          api.invalidateCache("settings:docker-registries");
        } else if (msg.channel === "integration.connector.changed") {
          api.invalidateCache("req:/api/integrations/gitlab/connectors");
          api.invalidateCache("settings:gitlab-connectors");
          api.invalidateCache("req:/api/integrations/cloudflare/connectors");
          api.invalidateCache("settings:cloudflare-connectors");
          api.invalidateCache("req:/api/docker/registries");
          api.invalidateCache("settings:docker-registries");
        } else if (msg.channel === "notification.alert-rule.changed") {
          invalidate("req:/api/notifications/alert-rules", "notifications:alerts");
        } else if (msg.channel === "notification.webhook.changed") {
          invalidate("req:/api/notifications/webhooks", "notifications:webhooks");
        } else if (msg.channel === "siem.destination.changed") {
          api.invalidateCache("req:/api/audit/siem/destinations");
          api.invalidateCache("audit:siem:destinations");
          api.invalidateCache("audit:siem:deliveries");
        } else if (msg.channel === "siem.delivery.changed") {
          api.invalidateCache("req:/api/audit/siem/deliveries");
          api.invalidateCache("audit:siem:deliveries");
        } else if (
          msg.channel === "database.changed" ||
          msg.channel === "database.folder.changed"
        ) {
          const payload = msg.payload as { action?: string; id?: string } | undefined;
          if (!(msg.channel === "database.changed" && payload?.action === "health.sampled")) {
            invalidate("req:/api/databases", "databases:list");
          }
          if (msg.channel === "database.changed" && payload?.action === "deleted" && payload.id) {
            usePinnedDatabasesStore.getState().removePin(payload.id);
          }
        } else if (msg.channel === "node.folder.changed") {
          this.invalidateNodeStores();
        } else if (msg.channel.startsWith("docker.")) {
          invalidate("req:/api/docker", "docker:");
          if (msg.channel === "docker.container.changed") {
            const payload = msg.payload as
              | { action?: string; id?: string; oldId?: string }
              | undefined;
            const removedId =
              payload?.action === "removed" ? (payload.id ?? payload.oldId) : undefined;
            if (removedId) {
              usePinnedContainersStore.getState().removePin(removedId);
            }
          } else if (msg.channel === "docker.deployment.changed") {
            const payload = msg.payload as { action?: string; deploymentId?: string } | undefined;
            if (payload?.deploymentId && ["deleted", "removed"].includes(payload.action ?? "")) {
              usePinnedContainersStore.getState().removePin(payload.deploymentId);
            }
          }
        } else if (msg.channel.startsWith("alert.")) {
          api.invalidateCache("req:/api/notifications/deliveries");
        } else if (msg.channel === "logging.environment.changed") {
          invalidate("req:/api/logging/environments", "logging:environments");
        } else if (msg.channel === "logging.schema.changed") {
          invalidate("req:/api/logging/schemas", "logging:schemas");
        } else if (msg.channel === "system.relay.health.changed") {
          invalidate("req:/api/system/relay", "relay:", "settings:relay");
        } else if (msg.channel === "system.config.changed") {
          invalidate(
            "req:/api/system/config",
            "req:/api/system/license",
            "req:/api/housekeeping",
            "settings:",
            "housekeeping:"
          );
        } else if (msg.channel === "system.update.changed") {
          invalidate("req:/api/system/version", "system:version");
        } else if (msg.channel === INFERENCE_CATALOG_CHANGED_CHANNEL) {
          invalidate("req:/api/inference", "settings:ai-config", "req:/api/ai/config");
        }

        this.dispatch(msg.channel, msg.payload);
      } else if (msg.type === "subscribed" && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) this.wireSubs.add(ch);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // racing stop()→start() — leave singleton alone
      if (event.code === 1012) {
        useAppStatusStore.getState().setGatewayRestartingActive(true);
      }
      this.setConnected(false);
      this.ws = null;
      this.wireSubs.clear();
      if (this.wantOpen) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // The close handler will fire next; nothing to do here.
    };
  }

  private dispatch(channel: string, payload: unknown) {
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        /* handler error */
      }
    }
  }

  private invalidateNodeStores() {
    api.invalidateCache("req:/api/nodes");
    api.invalidateCache("databases:nodes");
    useNodesStore.getState().invalidate();
    usePinnedNodesStore.getState().invalidate();
  }

  private scheduleNodeChanged(payload: unknown, immediate: boolean) {
    this.pendingNodeChangedPayload = payload;
    if (immediate) {
      if (this.nodeChangedTimer) {
        clearTimeout(this.nodeChangedTimer);
        this.nodeChangedTimer = null;
      }
      this.flushNodeChanged();
      return;
    }
    if (this.nodeChangedTimer) return;
    this.nodeChangedTimer = setTimeout(() => {
      this.nodeChangedTimer = null;
      this.flushNodeChanged();
    }, 750);
  }

  private flushNodeChanged() {
    const payload = this.pendingNodeChangedPayload;
    this.pendingNodeChangedPayload = undefined;
    this.invalidateNodeStores();
    this.dispatch("node.changed", payload);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.openSocket();
    }, delay);
  }

  private sendSubscribe(channels: string[]) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", channels }));
    } else {
      for (const ch of channels) this.pendingSubs.add(ch);
    }
  }

  private sendUnsubscribe(channels: string[]) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", channels }));
    }
    for (const ch of channels) {
      this.wireSubs.delete(ch);
      this.pendingSubs.delete(ch);
    }
  }

  subscribe(channel: string, handler: EventHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.sendSubscribe([channel]);
    }
    set.add(handler);

    return () => {
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(channel);
        this.sendUnsubscribe([channel]);
      }
    };
  }

  isConnected() {
    return this.connected;
  }

  onStatus(fn: (connected: boolean) => void): () => void {
    this.listeners.add(fn);
    fn(this.connected);
    return () => {
      this.listeners.delete(fn);
    };
  }

  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const fn of this.listeners) {
      try {
        fn(value);
      } catch {
        /* ignore */
      }
    }
  }
}

export const eventStream = new EventStream();
