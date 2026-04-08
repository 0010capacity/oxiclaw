/**
 * Step: bootstrap — Run setup.sh and parse its output.
 * This step verifies Node.js, dependencies, and native modules are ready.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface BootstrapResult {
  platform: string;
  isWsl: boolean;
  isRoot: boolean;
  nodeVersion: string;
  nodeOk: boolean;
  nodePath: string;
  depsOk: boolean;
  nativeOk: boolean;
  hasBuildTools: boolean;
  status: string;
}

function parseBootstrapOutput(output: string): BootstrapResult {
  const lines = output.split('\n');
  const result: Partial<BootstrapResult> = {};

  for (const line of lines) {
    const [key, ...valueParts] = line.split(': ');
    const value = valueParts.join(': ').trim();
    switch (key) {
      case 'PLATFORM': result.platform = value; break;
      case 'IS_WSL': result.isWsl = value === 'true'; break;
      case 'IS_ROOT': result.isRoot = value === 'true'; break;
      case 'NODE_VERSION': result.nodeVersion = value; break;
      case 'NODE_OK': result.nodeOk = value === 'true'; break;
      case 'NODE_PATH': result.nodePath = value; break;
      case 'DEPS_OK': result.depsOk = value === 'true'; break;
      case 'NATIVE_OK': result.nativeOk = value === 'true'; break;
      case 'HAS_BUILD_TOOLS': result.hasBuildTools = value === 'true'; break;
      case 'STATUS': result.status = value; break;
    }
  }

  return result as BootstrapResult;
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const scriptPath = path.join(projectRoot, 'setup.sh');

  logger.info('Running bootstrap');

  if (!fs.existsSync(scriptPath)) {
    emitStatus('BOOTSTRAP', {
      STATUS: 'failed',
      ERROR: 'setup.sh not found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  let result: BootstrapResult;
  try {
    const output = execSync(`bash "${scriptPath}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 120000,
    });
    result = parseBootstrapOutput(output);
    logger.info({ result }, 'Bootstrap completed');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Bootstrap failed');

    // Even on failure, try to parse partial output
    const stderr = err instanceof Error && 'stderr' in err
      ? String((err as { stderr?: string }).stderr)
      : '';

    // Try to extract status from error output
    if (stderr) {
      try {
        result = parseBootstrapOutput(stderr);
      } catch {
        // Ignore
      }
    }

    if (!result) {
      result = {
        platform: 'unknown',
        isWsl: false,
        isRoot: false,
        nodeVersion: 'not_found',
        nodeOk: false,
        nodePath: 'not_found',
        depsOk: false,
        nativeOk: false,
        hasBuildTools: false,
        status: 'failed',
      };
    }
  }

  emitStatus('BOOTSTRAP', {
    PLATFORM: result.platform,
    IS_WSL: String(result.isWsl),
    IS_ROOT: String(result.isRoot),
    NODE_VERSION: result.nodeVersion,
    NODE_OK: String(result.nodeOk),
    DEPS_OK: String(result.depsOk),
    NATIVE_OK: String(result.nativeOk),
    HAS_BUILD_TOOLS: String(result.hasBuildTools),
    STATUS: result.status,
    LOG: 'logs/setup.log',
  });

  if (result.status !== 'success') {
    process.exit(1);
  }
}
