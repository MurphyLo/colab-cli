import { DaemonClient } from '../daemon/client.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { isJsonMode, jsonResult } from '../output/json-output.js';

function parseSpec(spec: string): { localPort: number; remotePort: number } {
  const parts = spec.split(':');
  if (parts.length === 1) {
    const port = parsePort(parts[0]);
    return { localPort: port, remotePort: port };
  }
  if (parts.length === 2) {
    return { localPort: parsePort(parts[0]), remotePort: parsePort(parts[1]) };
  }
  throw new Error(`Invalid spec "${spec}". Use PORT or LOCAL:REMOTE.`);
}

function parsePort(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port "${s}" (must be 1-65535)`);
  }
  return n;
}

async function resolveServer(
  runtimeManager: RuntimeManager,
  endpoint: string | undefined,
) {
  const server = endpoint
    ? runtimeManager.getServerByEndpoint(endpoint)
    : runtimeManager.getLatestServer();
  if (!server) {
    console.error('No runtime found. Create one first with `colab runtime create`.');
    process.exit(1);
  }
  return server;
}

export async function portForwardCreateCommand(
  runtimeManager: RuntimeManager,
  spec: string,
  options: { endpoint?: string },
): Promise<void> {
  const { localPort, remotePort } = parseSpec(spec);
  const server = await resolveServer(runtimeManager, options.endpoint);

  const client = new DaemonClient();
  await client.connect(server.id);
  try {
    const result = await client.portForwardCreate(localPort, remotePort);
    if (isJsonMode()) {
      jsonResult({
        id: result.id,
        localPort: result.localPort,
        remotePort: result.remotePort,
        proxyUrl: result.proxyUrl,
      });
    } else {
      console.log(
        `[#${result.id}] http://localhost:${result.localPort} → runtime:${result.remotePort}`,
      );
      console.log(`proxy: ${result.proxyUrl}`);
    }
  } finally {
    client.close();
  }
}

export async function portForwardListCommand(
  runtimeManager: RuntimeManager,
  options: { endpoint?: string },
): Promise<void> {
  const server = await resolveServer(runtimeManager, options.endpoint);
  const client = new DaemonClient();
  await client.connect(server.id);
  try {
    const sessions = await client.portForwardList();
    if (isJsonMode()) {
      jsonResult({ sessions });
      return;
    }
    if (sessions.length === 0) {
      console.log('No port forwards.');
      return;
    }
    console.log('ID\tLOCAL\tREMOTE\tSTARTED\t\t\tPROXY_URL');
    for (const s of sessions) {
      const started = new Date(s.startedAt).toLocaleString();
      console.log(
        `${s.id}\t${s.localPort}\t${s.remotePort}\t${started}\t${s.proxyUrl}`,
      );
    }
  } finally {
    client.close();
  }
}

export async function portForwardCloseCommand(
  runtimeManager: RuntimeManager,
  idArg: string | undefined,
  options: { endpoint?: string; all?: boolean },
): Promise<void> {
  if (!options.all && !idArg) {
    console.error('Provide an ID or --all');
    process.exit(1);
  }
  const server = await resolveServer(runtimeManager, options.endpoint);
  const client = new DaemonClient();
  await client.connect(server.id);
  try {
    let ids: number[];
    if (options.all) {
      ids = await client.portForwardClose({ all: true });
    } else {
      const id = parseInt(idArg!, 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid forward id: ${idArg}`);
      }
      ids = await client.portForwardClose({ id });
    }
    if (isJsonMode()) {
      jsonResult({ closed: ids });
    } else if (ids.length === 0) {
      console.log('Nothing to close.');
    } else {
      console.log(`Closed ${ids.length === 1 ? 'forward' : 'forwards'}: ${ids.join(', ')}`);
    }
  } finally {
    client.close();
  }
}
