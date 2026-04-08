/**
 * Setup CLI entry point.
 * Usage: npx tsx setup/index.ts --step <name> [args...]
 */
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const STEPS: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  // Step order matches the SKILL.md 10-step flow:
  // 1. environment  — detect OS/WSL/container runtime/existing config
  // 2. bootstrap    — run setup.sh, verify Node/dependencies/native modules
  // 3. timezone     — detect and persist IANA timezone
  // 4. container    — build agent container image
  // 5. credentials  — configure pi-mono SDK auth.json
  // 6. channels    — (handled by SKILL.md via AskUserQuestion, this step is a passthrough)
  // 7. groups      — sync group metadata from messaging platforms
  // 8. skills      — offer optional skills
  // 9. mounts      — configure external directory access allowlist
  // 10. service    — register launchd/systemd/nohup service
  // 11. verify     — end-to-end health check
  environment: () => import('./environment.js'),
  bootstrap: () => import('./bootstrap.js'),
  timezone: () => import('./timezone.js'),
  container: () => import('./container.js'),
  credentials: () => import('./credentials.js'),
  channels: () => import('./channels.js'),
  groups: () => import('./groups.js'),
  skills: () => import('./skills.js'),
  mounts: () => import('./mounts.js'),
  service: () => import('./service.js'),
  verify: () => import('./verify.js'),
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepIdx = args.indexOf('--step');

  if (stepIdx === -1 || !args[stepIdx + 1]) {
    console.error(
      `Usage: npx tsx setup/index.ts --step <${Object.keys(STEPS).join('|')}> [args...]`,
    );
    process.exit(1);
  }

  const stepName = args[stepIdx + 1];
  const stepArgs = args.filter(
    (a, i) => i !== stepIdx && i !== stepIdx + 1 && a !== '--',
  );

  const loader = STEPS[stepName];
  if (!loader) {
    console.error(`Unknown step: ${stepName}`);
    console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }

  try {
    const mod = await loader();
    await mod.run(stepArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: stepName }, 'Setup step failed');
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

main();
