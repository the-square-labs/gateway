import type pg from 'pg';

/**
 * pg-pool listens for `error` only on idle clients. A client checked out for a transaction, a session lock or a
 * series of statements reports a lost connection (the server stopped, a tunnel dropped) as an `error` event too,
 * right after it failed its running query. Without a listener that event is an uncaught exception that ends the
 * process. The operation holding the client still gets the error: its running query fails, and so does every later
 * query on the client. The client leaves the pool at once, so a holder that never releases it (a failed BEGIN) does
 * not keep its slot; the holder's own release afterwards does nothing.
 */
export function releaseLostCheckedOutClients(pool: pg.Pool, onLost?: (error: Error) => void): void {
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_error, client) => checkedOut.delete(client));
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      // An idle client is the pool's: its own listener removes the client and emits the error on the pool.
      if (!checkedOut.has(client)) return;
      checkedOut.delete(client);
      const release = client.release;
      client.release = () => undefined;
      release(error);
      onLost?.(error);
    });
  });
}
