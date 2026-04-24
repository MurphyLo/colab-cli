import { randomUUID, UUID } from 'crypto';
import {
  Assignment,
  ListedAssignment,
  Variant,
  Shape,
  variantToMachineType,
  shapeToMachineShape,
  isHighMemOnlyAccelerator,
} from '../colab/api.js';
import { ColabClient } from '../colab/client.js';
import { log } from '../logging/index.js';
import { startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import {
  StoredServer,
  listStoredServers,
  storeServer,
  removeStoredServer,
} from './storage.js';

export class RuntimeManager {
  constructor(private readonly colabClient: ColabClient) {}

  async resolveTarget(endpoint?: string): Promise<StoredServer> {
    if (endpoint) {
      const server = this.getServerByEndpoint(endpoint);
      if (!server) {
        throw new Error(
          `No local record for endpoint ${endpoint}. Run \`colab runtime list\` to see active runtimes.`,
        );
      }
      return server;
    }

    const server = this.getLatestServer();
    if (!server) {
      throw new Error(
        'No runtime found. Create one first with `colab runtime create`.',
      );
    }

    const assignments = await this.list();
    if (assignments.some((a) => a.endpoint === server.endpoint)) {
      return server;
    }

    await stopDaemon(server.id);
    removeStoredServer(server.id);

    const active = assignments.map((a) => a.endpoint);
    if (active.length === 0) {
      throw new Error(
        `Runtime ${server.endpoint} is no longer active (stale local record removed). No active runtimes — create one with \`colab runtime create\`.`,
      );
    }
    throw new Error(
      `Runtime ${server.endpoint} is no longer active (stale local record removed). Active runtimes: ${active.join(', ')}. Use --endpoint to specify.`,
    );
  }

  async create(options: {
    variant: Variant;
    accelerator?: string;
    shape?: Shape;
    version?: string;
    kernelName?: string;
  }): Promise<StoredServer> {
    const id = randomUUID();
    const accelerator = await this.resolveAccelerator(
      options.variant,
      options.accelerator,
    );
    const shape = this.resolveShape(options.variant, accelerator, options.shape);
    const { assignment } = await this.colabClient.assign(id, {
      variant: options.variant,
      accelerator,
      shape,
      version: options.version,
    });

    const tokenExpiry = new Date(
      Date.now() + assignment.runtimeProxyInfo.tokenExpiresInSeconds * 1000,
    );

    const assignedVariant = (assignment.variant ?? Variant.DEFAULT) as Variant;
    const server: StoredServer = {
      id,
      label: `Colab ${variantToMachineType(assignedVariant)}${
        assignment.accelerator !== 'NONE' ? ` ${assignment.accelerator}` : ''
      }`,
      variant: assignedVariant,
      accelerator: assignment.accelerator,
      endpoint: assignment.endpoint,
      proxyUrl: assignment.runtimeProxyInfo.url,
      token: assignment.runtimeProxyInfo.token,
      tokenExpiry,
      dateAssigned: new Date(),
      kernelName: options.kernelName ?? 'python3',
    };

    storeServer(server);
    await startDaemon(server.id);
    return server;
  }

  async destroy(endpoint: string): Promise<void> {
    const servers = listStoredServers();
    const server = servers.find((s) => s.endpoint === endpoint);

    if (server) {
      await stopDaemon(server.id);
      removeStoredServer(server.id);
    }

    await this.colabClient.unassign(endpoint);
  }

  async list(): Promise<ListedAssignment[]> {
    return this.colabClient.listAssignments();
  }

  getLatestServer(): StoredServer | undefined {
    const servers = listStoredServers();
    if (servers.length === 0) return undefined;
    return servers.sort(
      (a, b) => b.dateAssigned.getTime() - a.dateAssigned.getTime(),
    )[0];
  }

  getServerByEndpoint(endpoint: string): StoredServer | undefined {
    return listStoredServers().find((s) => s.endpoint === endpoint);
  }

  private async resolveAccelerator(
    variant: Variant,
    accelerator?: string,
  ): Promise<string | undefined> {
    if (variant === Variant.DEFAULT) {
      return undefined;
    }

    if (accelerator) {
      return accelerator.toUpperCase();
    }

    const eligibleModels =
      this.colabClient
        .getUserInfo()
        .then(
          (userInfo) =>
            userInfo.eligibleAccelerators.find((acc) => acc.variant === variant)
              ?.models ?? [],
        );

    const model = (await eligibleModels)[0];
    if (!model) {
      throw new Error(
        `No eligible ${variantToMachineType(variant)} accelerators are available for the current account.`,
      );
    }

    log.debug(
      `Auto-selected ${variantToMachineType(variant)} accelerator: ${model}`,
    );
    return model;
  }

  private resolveShape(
    variant: Variant,
    accelerator: string | undefined,
    requestedShape: Shape | undefined,
  ): Shape | undefined {
    if (variant === Variant.DEFAULT || !accelerator) {
      return requestedShape ?? Shape.STANDARD;
    }

    if (!isHighMemOnlyAccelerator(accelerator)) {
      return requestedShape ?? Shape.STANDARD;
    }

    if (requestedShape === Shape.STANDARD) {
      throw new Error(
        `${variantToMachineType(variant)} ${accelerator} only supports ${shapeToMachineShape(Shape.HIGHMEM)} in CLI semantics. Use --shape high-ram or omit --shape.`,
      );
    }

    return Shape.HIGHMEM;
  }
}
