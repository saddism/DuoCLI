import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runFile = promisify(execFile);

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

// A byte-for-byte TCP relay also preserves HTTP streaming and WebSocket upgrades.
// The application continues to handle all authentication and authorization.
export function createWakeGateway({
  targetPort = 9800,
  launch,
  startupTimeoutMs = 25_000,
  retryDelayMs = 5_000,
  pollMs = 200,
  log = console.log,
}) {
  let starting = null;
  let retryAfter = 0;
  let stopped = false;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };

  async function ensureRunning() {
    if (starting) return starting;
    starting = (async () => {
      if (await isListening(targetPort)) return;
      if (stopped) throw new Error('Gateway stopped');
      if (Date.now() < retryAfter) throw new Error('Startup retry pending');
      const deadline = Date.now() + startupTimeoutMs;
      log('[wake] Remote request received; starting DuoCLI');
      try {
        await launch();
        while (!stopped && Date.now() < deadline) {
          if (await isListening(targetPort)) {
            log('[wake] DuoCLI is ready');
            return;
          }
          await delay(pollMs);
        }
        throw new Error('DuoCLI startup timed out');
      } catch (error) {
        retryAfter = Date.now() + retryDelayMs;
        throw error;
      }
    })();
    try { await starting; } finally { starting = null; }
  }

  const server = net.createServer({ pauseOnConnect: true }, async (client) => {
    track(client);
    // Limit sockets waiting for an app launch, including disconnected clients.
    if (sockets.size > 128) { client.destroy(); return; }
    try {
      await ensureRunning();
      if (client.destroyed || stopped) return;
      const upstream = track(net.connect({ host: '127.0.0.1', port: targetPort }));
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    } catch (error) {
      log(`[wake] ${error.message}`);
      if (!client.destroyed) {
        client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\nContent-Length: 0\r\n\r\n');
        client.setTimeout(1000, () => client.destroy());
      }
    }
  });
  server.stop = () => {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appPath = process.env.DUOCLI_WAKE_APP;
  if (!appPath) throw new Error('DUOCLI_WAKE_APP must identify the installed DuoCLI.app');
  const gateway = createWakeGateway({
    launch: () => runFile('/usr/bin/open', ['-g', appPath], { timeout: 10_000 }),
    startupTimeoutMs: Number(process.env.DUOCLI_WAKE_STARTUP_TIMEOUT_MS) || 25_000,
  });
  gateway.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  gateway.listen(9801, '127.0.0.1', () => console.log('[wake] Listening on 127.0.0.1:9801'));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { void gateway.stop(); });
  }
}
