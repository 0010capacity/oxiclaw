/**
 * Step: channels — Confirm channel configuration status.
 *
 * Note: The actual channel selection and skill invocation is handled by the
 * SKILL.md step 5 workflow (via AskUserQuestion and skill invocations).
 * This step is a passthrough that confirms whether channels were configured.
 */
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  // Check for --skip flag (setup skill can skip this step if channels
  // are handled directly by the skill workflow)
  if (args.includes('--skip')) {
    emitStatus('CHANNELS', {
      STATUS: 'skipped',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // This step is primarily informational — SKILL.md drives channel setup.
  // Emit a status indicating this step is handled by the skill.
  emitStatus('CHANNELS', {
    STATUS: 'handled_by_skill',
    NOTE: 'Channel selection is handled via AskUserQuestion in SKILL.md step 5',
    LOG: 'logs/setup.log',
  });
}
