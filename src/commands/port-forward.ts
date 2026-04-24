import { DaemonClient } from '../daemon/client.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { isJsonMode, jsonResult } from '../output/json-output.js';

function parseSpec(spec: string): {
  localHost: string;
  localPort: number;
  remotePort: number;
} {
  const parts = spec.split(':');
  if (parts.length === 1) {
    const port = parsePort(parts[0]);
    return { localHost: '127.0.0.1', localPort: port, remotePort: port };
  }
  if (parts.length === 2) {
    return {
      localHost: '127.0.0.1',
      localPort: parsePort(parts[0]),
      remotePort: parsePort(parts[1]),
    };
  }
  if (parts.length === 3) {
    const [localHost, localPort, remotePort] = parts;
    if (!localHost) {
      throw new Error(`Invalid spec "${spec}". Host cannot be empty.`);
    }
    return {
      localHost,
      localPort: parsePort(localPort),
      remotePort: parsePort(remotePort),
    };
  }
  throw new Error(
    `Invalid spec "${spec}". Use REMOTE, LOCAL:REMOTE, or HOST:LOCAL:REMOTE.`,
  );
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
  return runtimeManager.resolveTarget(endpoint);
}

export async function portForwardCreateCommand(
  runtimeManager: RuntimeManager,
  spec: string,
  options: { endpoint?: string; tls?: boolean },
): Promise<void> {
  const { localHost, localPort, remotePort } = parseSpec(spec);
  const server = await resolveServer(runtimeManager, options.endpoint);

  const client = new DaemonClient();
  await client.connect(server.id);
  try {
    const result = await client.portForwardCreate(localHost, localPort, remotePort, options.tls);
    if (isJsonMode()) {
      jsonResult({
        id: result.id,
        localHost: result.localHost,
        localPort: result.localPort,
        remotePort: result.remotePort,
        proxyUrl: result.proxyUrl,
        tls: result.tls,
      });
    } else {
      const scheme = result.tls ? 'https' : 'http';
      console.log(`[#${result.id}] bind ${scheme}://${result.localHost}:${result.localPort} → runtime:${result.remotePort}`);
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
    console.log('ID\tHOST\tLOCAL\tREMOTE\tTLS\tSTARTED\t\t\tPROXY_URL');
    for (const s of sessions) {
      const started = new Date(s.startedAt).toLocaleString();
      console.log(
        `${s.id}\t${s.localHost}\t${s.localPort}\t${s.remotePort}\t${s.tls ? 'yes' : 'no'}\t${started}\t${s.proxyUrl}`,
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
