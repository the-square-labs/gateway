import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHealth } from './healthcheck.mjs';

async function withServer(server, run) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(server.address().port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('falls back from TLS to plaintext without child processes', async () => {
  let requests = 0;
  await withServer(createServer((request, response) => {
    assert.equal(request.url, '/health');
    requests++;
    response.end('ok');
  }), async (port) => {
    for (let i = 0; i < 8; i++) assert.equal(await checkHealth({ port }), true);
    assert.equal(requests, 8);
  });
});

test('fails a non-200 response', async () => {
  await withServer(createServer((_request, response) => {
    response.writeHead(503).end();
  }), async (port) => assert.equal(await checkHealth({ port }), false));
});

test('accepts local self-signed TLS without disabling certificate checks globally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-healthcheck-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    await withServer(createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.end('ok')),
      async (port) => assert.equal(await checkHealth({ port }), true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bounds silent sockets including TLS handshake and destroys both attempts', async () => {
  await withServer(createTcpServer(), async (port) => {
    const started = Date.now();
    assert.equal(await checkHealth({ port, timeoutMs: 30 }), false);
    assert.ok(Date.now() - started < 1000);
  });
});

test('images reap orphans and generated Compose inherits the image probe', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
  assert.match(dockerfile, /CMD \["node", "\/app\/healthcheck.mjs"\]/);
  for (const file of ['../docker-compose.yml', './install.sh']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!text.includes('wget --no-check-certificate -qO- https://127.0.0.1:3000/health'));
  }
});
