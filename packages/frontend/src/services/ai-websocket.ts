import type { WSClientMessage, WSServerMessage } from "@/types/ai";

type MessageHandler = (msg: WSServerMessage) => void;
type StatusHandler = (connected: boolean) => void;
type ErrorHandler = (message: string) => void;

const PING_INTERVAL = 15_000;
const PONG_TIMEOUT = 5_000;
const CONNECT_TIMEOUT = 10_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000];

export class AIWebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _isConnected = false;
  private intentionalClose = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(): Promise<boolean> {
    this.reconnectAttempts = 0;
    this.intentionalClose = false;
    return this.doConnect();
  }

  private doConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      this.cleanupSocket();

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ai/ws`;

      try {
        this.ws = new WebSocket(url);
      } catch {
        this.errorHandler?.("Failed to create AI connection");
        resolve(false);
        return;
      }

      const timeout = setTimeout(() => {
        resolve(false);
        this.cleanupSocket();
        this.scheduleReconnect();
      }, CONNECT_TIMEOUT);

      this.ws.onopen = () => {
        // waiting for auth_ok
      };

      this.ws.onmessage = (event) => {
        let msg: WSServerMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "auth_ok") {
          clearTimeout(timeout);
          this.setConnected(true);
          this.reconnectAttempts = 0;
          this.startPingPong();
          resolve(true);
          return;
        }

        if (msg.type === "auth_error") {
          clearTimeout(timeout);
          this.intentionalClose = true; // don't reconnect on auth failure
          this.errorHandler?.(msg.message);
          resolve(false);
          this.cleanupSocket();
          return;
        }

        if (msg.type === "pong") {
          this.clearPongTimeout();
          return;
        }

        this.messageHandler?.(msg);
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (!this._isConnected) {
          this.errorHandler?.("AI connection failed");
          resolve(false);
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        const wasConnected = this._isConnected;
        this.setConnected(false);
        this.stopPingPong();

        if (!wasConnected && !this._isConnected) {
          resolve(false);
        }

        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopPingPong();
    this.cleanupSocket();
    this.setConnected(false);
  }

  send(msg: WSClientMessage): true {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("AI connection is not open");
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  onConnectionError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  // ── Ping/pong liveness detection ──

  private startPingPong(): void {
    this.stopPingPong();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        // Expect pong within timeout, otherwise connection is dead
        this.pongTimer = setTimeout(() => {
          this.handlePongTimeout();
        }, PONG_TIMEOUT);
      }
    }, PING_INTERVAL);
  }

  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private handlePongTimeout(): void {
    // Server didn't respond to ping — connection is dead
    this.stopPingPong();
    this.cleanupSocket();
    this.setConnected(false);
    this.scheduleReconnect();
  }

  // ── Reconnection ──

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.errorHandler?.("AI connection unavailable");
      return;
    }

    this.clearReconnectTimer();
    this.errorHandler?.("Reconnecting...");
    const delay = RECONNECT_DELAYS[this.reconnectAttempts] || 8000;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Helpers ──

  private setConnected(connected: boolean): void {
    if (this._isConnected !== connected) {
      this._isConnected = connected;
      this.statusHandler?.(connected);
    }
  }

  private cleanupSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
