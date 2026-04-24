import chalk from 'chalk';
import {
  Variant,
  Shape,
  SubscriptionTier,
  variantToMachineType,
  shapeToMachineShape,
  isHighMemOnlyAccelerator,
} from '../colab/api.js';
import type { Resources } from '../colab/api.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { ColabClient } from '../colab/client.js';
import { DaemonClient } from '../daemon/client.js';
import { createSpinner, isJsonMode, jsonResult } from '../output/json-output.js';
import { RUNTIME_VERSION_INFO } from '../colab/runtime-versions.js';

export async function createRuntimeCommand(
  runtimeManager: RuntimeManager,
  options: {
    accelerator?: string;
    shape?: string;
    runtimeVersion?: string;
    kernel?: string;
  },
): Promise<void> {
  const selection = parseAcceleratorSelection(options.accelerator);
  const variant = selection.variant;

  const shape = options.shape === 'high-ram' ? Shape.HIGHMEM
    : options.shape === 'standard' ? Shape.STANDARD
    : undefined;

  const versionLabel = options.runtimeVersion || undefined;
  const kernelName = options.kernel ?? 'python3';
  const spinner = createSpinner(
    `Creating ${variantToMachineType(variant)} runtime${versionLabel ? ` (version ${versionLabel})` : ''}${kernelName !== 'python3' ? ` [${kernelDisplayName(kernelName)}]` : ''}...`,
  ).start();
  try {
    const server = await runtimeManager.create({
      variant,
      accelerator: selection.accelerator,
      shape,
      version: versionLabel,
      kernelName,
    });
    if (isJsonMode()) {
      jsonResult({ command: 'runtime.create', label: server.label, endpoint: server.endpoint, kernelName });
    } else {
      spinner.succeed(
        `Runtime created: ${server.label} (endpoint: ${server.endpoint})${kernelName !== 'python3' ? ` [${kernelDisplayName(kernelName)}]` : ''}`,
      );
    }
  } catch (err) {
    spinner.fail('Failed to create runtime');
    throw err;
  }
}

function kernelDisplayName(kernelName: string): string {
  switch (kernelName) {
    case 'python3': return 'Python 3';
    case 'r': return 'R';
    case 'julia': return 'Julia';
    default: return kernelName;
  }
}

function parseAcceleratorSelection(accelerator: string | undefined): {
  variant: Variant;
  accelerator?: string;
} {
  if (!accelerator) {
    console.error(
      'Missing accelerator. Use --accelerator with one of: CPU, H100, G4, A100, L4, T4, v6e-1, v5e-1.',
    );
    process.exit(1);
  }

  const normalized = accelerator
    .trim()
    .toUpperCase()
    .replace(/\s+(GPU|TPU)$/, '')
    .replace(/-/g, '')
    .replace(/\s+/g, '');

  switch (normalized) {
    case 'CPU':
      return { variant: Variant.DEFAULT };
    case 'H100':
    case 'G4':
    case 'A100':
    case 'L4':
    case 'T4':
      return { variant: Variant.GPU, accelerator: normalized };
    case 'V6E1':
    case 'V5E1':
      return { variant: Variant.TPU, accelerator: normalized };
    default:
      console.error(
        `Unknown accelerator: ${accelerator}. Use one of: CPU, H100, G4, A100, L4, T4, v6e-1, v5e-1.`,
      );
      process.exit(1);
  }
}

export async function listRuntimesCommand(
  runtimeManager: RuntimeManager,
): Promise<void> {
  const spinner = createSpinner('Fetching runtimes...').start();
  try {
    const assignments = await runtimeManager.list();
    spinner.stop();

    if (isJsonMode()) {
      jsonResult({
        command: 'runtime.list',
        runtimes: assignments.map((a) => ({
          type: variantToMachineType(a.variant),
          accelerator: a.accelerator && a.accelerator !== 'NONE' ? a.accelerator : undefined,
          shape: shapeToMachineShape(isHighMemOnlyAccelerator(a.accelerator) ? Shape.HIGHMEM : a.machineShape),
          endpoint: a.endpoint,
        })),
      });
      return;
    }

    if (assignments.length === 0) {
      console.log('No active runtimes.');
      return;
    }

    console.log(chalk.bold('\nActive Runtimes:'));
    for (const a of assignments) {
      const type = variantToMachineType(a.variant);
      const displayShape =
        isHighMemOnlyAccelerator(a.accelerator) ? Shape.HIGHMEM : a.machineShape;
      const shape = shapeToMachineShape(displayShape);
      const accel =
        a.accelerator && a.accelerator !== 'NONE'
          ? ` ${a.accelerator}`
          : '';
      console.log(
        `  ${chalk.green('●')} ${type}${accel} (${shape}) - ${chalk.dim(a.endpoint)}`,
      );
    }
    console.log('');
  } catch (err) {
    spinner.fail('Failed to list runtimes');
    throw err;
  }
}

export async function listAvailableRuntimesCommand(
  colabClient: ColabClient,
): Promise<void> {
  const spinner = createSpinner('Fetching available runtime options...').start();
  try {
    const userInfo = await colabClient.getUserInfo();
    spinner.stop();

    const supportsHighMem = userInfo.subscriptionTier !== SubscriptionTier.NONE;
    const available = new Map<string, { variant: Variant; accelerator?: string }>();
    available.set('CPU', { variant: Variant.DEFAULT });
    for (const acc of userInfo.eligibleAccelerators) {
      for (const model of acc.models) {
        available.set(`${acc.variant}:${model}`, {
          variant: acc.variant,
          accelerator: model,
        });
      }
    }

    if (isJsonMode()) {
      const options = getPreferredAvailableOptions(available).map((option) => ({
        label: formatAvailableOptionLabel(option.variant, option.accelerator),
        variant: option.variant,
        accelerator: option.accelerator,
        shapes: getDisplayShapes(option.variant, option.accelerator, supportsHighMem).map(shapeToMachineShape),
      }));
      jsonResult({ command: 'runtime.available', options });
      return;
    }

    console.log(chalk.bold('\nAvailable Runtime Options:'));

    for (const option of getPreferredAvailableOptions(available)) {
      const shapes = getDisplayShapes(
        option.variant,
        option.accelerator,
        supportsHighMem,
      );
      console.log(
        `  ${chalk.green('●')} ${formatAvailableOptionLabel(option.variant, option.accelerator)} (${shapes.map(shapeToMachineShape).join(', ')})`,
      );
    }

    console.log('');
  } catch (err) {
    spinner.fail('Failed to fetch available runtime options');
    throw err;
  }
}

function getPreferredAvailableOptions(
  available: Map<string, { variant: Variant; accelerator?: string }>,
): Array<{ variant: Variant; accelerator?: string }> {
  const orderedKeys = [
    'CPU',
    `${Variant.GPU}:H100`,
    `${Variant.GPU}:G4`,
    `${Variant.GPU}:A100`,
    `${Variant.GPU}:L4`,
    `${Variant.GPU}:T4`,
    `${Variant.TPU}:V6E1`,
    `${Variant.TPU}:V5E1`,
  ];

  const ordered = orderedKeys
    .map((key) => available.get(key))
    .filter((option): option is { variant: Variant; accelerator?: string } => option !== undefined);

  const leftovers = [...available.entries()]
    .filter(([key]) => !orderedKeys.includes(key))
    .map(([, option]) => option)
    .sort((a, b) => formatAvailableOptionLabel(a.variant, a.accelerator).localeCompare(
      formatAvailableOptionLabel(b.variant, b.accelerator),
    ));

  return [...ordered, ...leftovers];
}

function formatAvailableOptionLabel(
  variant: Variant,
  accelerator?: string,
): string {
  if (variant === Variant.DEFAULT) {
    return 'CPU';
  }

  const type = variantToMachineType(variant);
  if (!accelerator) {
    return type;
  }

  if (variant === Variant.TPU) {
    switch (accelerator) {
      case 'V6E1':
        return `${type} v6e-1`;
      case 'V5E1':
        return `${type} v5e-1`;
      default:
        return `${type} ${accelerator.toLowerCase()}`;
    }
  }

  return `${type} ${accelerator}`;
}

function getDisplayShapes(
  variant: Variant,
  accelerator: string | undefined,
  supportsHighMem: boolean,
): Shape[] {
  if (variant === Variant.DEFAULT) {
    return supportsHighMem ? [Shape.STANDARD, Shape.HIGHMEM] : [Shape.STANDARD];
  }

  if (accelerator && isHighMemOnlyAccelerator(accelerator)) {
    return [Shape.HIGHMEM];
  }

  return supportsHighMem ? [Shape.STANDARD, Shape.HIGHMEM] : [Shape.STANDARD];
}

export async function destroyRuntimeCommand(
  runtimeManager: RuntimeManager,
  endpoint?: string,
): Promise<void> {
  if (!endpoint) {
    const server = await runtimeManager.resolveTarget();
    endpoint = server.endpoint;
  }

  const spinner = createSpinner('Destroying runtime...').start();
  try {
    await runtimeManager.destroy(endpoint);
    if (isJsonMode()) {
      jsonResult({ command: 'runtime.destroy', endpoint });
    } else {
      spinner.succeed(`Runtime destroyed: ${endpoint}`);
    }
  } catch (err) {
    spinner.fail('Failed to destroy runtime');
    throw err;
  }
}

export async function restartRuntimeCommand(
  runtimeManager: RuntimeManager,
  endpoint?: string,
): Promise<void> {
  const server = await runtimeManager.resolveTarget(endpoint);

  const spinner = createSpinner('Restarting kernel...').start();
  const client = new DaemonClient();
  try {
    await client.connect(server.id);
    await client.restart();
    if (isJsonMode()) {
      jsonResult({ command: 'runtime.restart', endpoint: server.endpoint });
    } else {
      spinner.succeed('Kernel restarted');
    }
  } catch (err) {
    spinner.fail('Failed to restart kernel');
    throw err;
  } finally {
    client.close();
  }
}

export async function listRuntimeVersionsCommand(
  colabClient: ColabClient,
): Promise<void> {
  const spinner = createSpinner('Fetching runtime versions...').start();
  try {
    const versions = await colabClient.getRuntimeVersions();
    spinner.stop();

    if (isJsonMode()) {
      const items = versions.map((v) => ({
        version: v,
        info: RUNTIME_VERSION_INFO.get(v) ?? null,
      }));
      jsonResult({ command: 'runtime.versions', versions: items });
      return;
    }

    if (versions.length === 0) {
      console.log('No runtime versions available.');
      return;
    }

    console.log(chalk.bold('\nAvailable Runtime Versions:'));
    for (const v of versions) {
      const info = RUNTIME_VERSION_INFO.get(v);
      console.log(`\n  ${chalk.green('●')} ${chalk.bold(v)}${v === versions[0] ? chalk.dim(' (latest)') : ''}`);
      if (info) {
        console.log(`    Ubuntu ${info.ubuntu}`);
        console.log(`    Python ${info.python} | numpy ${info.numpy}`);
        console.log(`    PyTorch ${info.pytorch} | Jax ${info.jax}`);
        console.log(`    TensorFlow ${info.tensorflow}`);
        console.log(`    R ${info.r}`);
        console.log(`    Julia ${info.julia}`);
      } else {
        console.log(chalk.dim(`    (environment details not yet available)`));
      }
    }
    console.log('');
  } catch (err) {
    spinner.fail('Failed to fetch runtime versions');
    throw err;
  }
}

// --- Resources command ---

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(1)} ${units[i]}`;
}

function pct(used: number, total: number): string {
  if (total === 0) return '0%';
  return `${((used / total) * 100).toFixed(1)}%`;
}

export async function resourcesCommand(
  runtimeManager: RuntimeManager,
  colabClient: ColabClient,
  endpoint?: string,
): Promise<void> {
  const server = await runtimeManager.resolveTarget(endpoint);

  const spinner = createSpinner('Fetching runtime resources...').start();
  try {
    const resources = await colabClient.getResources(server.proxyUrl, server.token);
    spinner.stop();

    if (isJsonMode()) {
      jsonResult({ command: 'runtime.resources', endpoint: server.endpoint, ...resources });
      return;
    }

    printResources(resources);
  } catch (err) {
    spinner.fail('Failed to fetch runtime resources');
    throw err;
  }
}

function printResources(r: Resources): void {
  console.log(chalk.bold('\nRuntime Resources:'));

  const ramUsed = r.memory.totalBytes - r.memory.freeBytes;
  console.log(`  ${chalk.cyan('RAM')}:  ${formatBytes(ramUsed)} / ${formatBytes(r.memory.totalBytes)} (${pct(ramUsed, r.memory.totalBytes)})`);

  for (const disk of r.disks) {
    const fs = disk.filesystem;
    const label = fs.label ? ` [${fs.label}]` : '';
    console.log(`  ${chalk.cyan('Disk')}${label}: ${formatBytes(fs.usedBytes)} / ${formatBytes(fs.totalBytes)} (${pct(fs.usedBytes, fs.totalBytes)})`);
  }

  if (r.gpus.length > 0) {
    for (const gpu of r.gpus) {
      const name = gpu.name ?? 'GPU';
      const memUsage = `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`;
      const util = gpu.gpuUtilization != null ? ` | util ${(gpu.gpuUtilization * 100).toFixed(0)}%` : '';
      console.log(`  ${chalk.cyan(name)}: ${memUsage}${util}`);
    }
  }

  console.log('');
}
