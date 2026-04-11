/**
 * Container runtime abstraction for OxiClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** Supported container runtimes. */
export type ContainerRuntime = 'docker' | 'apple-container';

/**
 * Detect and return the runtime binary name.
 * Checks CONTAINER_RUNTIME env var first, then auto-detects.
 */
export function getRuntimeBin(): string {
  const env = process.env.CONTAINER_RUNTIME;
  if (env === 'apple-container') return 'container';
  if (env === 'docker') return 'docker';
  // Auto-detect: prefer apple-container on macOS if available
  if (os.platform() === 'darwin') {
    try {
      execSync('command -v container', { stdio: 'ignore' });
      return 'container';
    } catch {
      return 'docker';
    }
  }
  return 'docker';
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = getRuntimeBin();

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Apple Container and non-Linux don't need host-gateway args
  if (os.platform() !== 'linux') return [];
  // On Linux Docker, host.docker.internal isn't built-in — add it explicitly
  const bin = getRuntimeBin();
  if (bin === 'container') return [];
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Stop a container by name. Uses execFileSync to avoid shell injection.
 * @param name Container name (validated against injection patterns)
 * @param runtime Container runtime to use
 */
export function stopContainer(
  name: string,
  runtime: ContainerRuntime = 'docker',
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  const bin = runtime === 'apple-container' ? 'container' : 'docker';
  execSync(`${bin} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  const bin = getRuntimeBin();
  try {
    execSync(`${bin} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    if (bin === 'docker') {
      console.error(
        '║  1. Ensure Docker is installed and running                     ║',
      );
      console.error(
        '║  2. Run: docker info                                           ║',
      );
    } else {
      console.error(
        '║  1. Ensure Apple Container runtime is installed                 ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
    }
    console.error(
      '║  3. Restart OxiClaw                                            ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned OxiClaw containers from previous runs. */
export function cleanupOrphans(): void {
  const bin = getRuntimeBin();
  try {
    const output = execSync(
      `${bin} ps --filter name=oxiclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        // Use default runtime for orphan cleanup
        stopContainer(name, bin === 'container' ? 'apple-container' : 'docker');
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
