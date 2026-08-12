export interface ShutdownWebSocketClient {
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface ShutdownWebSocketClients extends Iterable<ShutdownWebSocketClient> {
  readonly size: number;
}

export async function drainWebSocketsForRestart(clients: ShutdownWebSocketClients, deadline: number): Promise<void> {
  for (const client of clients) client.close(1012, 'Service Restart');
  await waitWhileConnected(clients, deadline);
}

export function terminateRemainingWebSockets(clients: ShutdownWebSocketClients): void {
  for (const client of clients) client.terminate();
}

async function waitWhileConnected(clients: ShutdownWebSocketClients, deadline: number): Promise<void> {
  while (clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    });
  }
}
