/**
 * Step: skills — Offer optional skills after setup completes.
 *
 * Detects installed channels from .env and existing config,
 * then recommends and applies selected skills.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface SkillInfo {
  name: string;
  reason: string;
  path: string;
}

/** Detect which channels are installed by checking .env and auth dirs. */
function detectInstalledChannels(projectRoot: string): string[] {
  const channels: string[] = [];

  // Telegram: check .env
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    if (/^TELEGRAM_BOT_TOKEN=/m.test(content)) {
      channels.push('telegram');
    }
  }

  return channels;
}

/** Check if a skill directory exists in .claude/skills/. */
function skillExists(name: string): boolean {
  const skillDir = path.join(process.cwd(), '.claude', 'skills', name);
  return fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory();
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting skills offering');

  // Check for --install flag (used when setup skill re-invokes with selections)
  const installIdx = args.indexOf('--install');
  const skipOfferIdx = args.indexOf('--skip-offer');

  // If --install is provided, apply those skills directly
  if (installIdx !== -1 && args[installIdx + 1]) {
    const skillNames = args[installIdx + 1].split(',').filter(Boolean);
    const results: string[] = [];
    for (const skill of skillNames) {
      const skillName = skill.trim();
      if (!skillExists(skillName)) {
        logger.warn({ skill: skillName }, 'Skill not found, skipping');
        continue;
      }
      logger.info({ skill: skillName }, 'Skill available (merge branch to apply)');
      results.push(skillName);
    }

    emitStatus('SKILLS', {
      INSTALLED: results.join(','),
      STATUS: results.length > 0 ? 'success' : 'skipped',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // If --skip-offer, just emit success
  if (skipOfferIdx !== -1) {
    emitStatus('SKILLS', {
      INSTALLED: '',
      STATUS: 'skipped',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Detect installed channels
  const channels = detectInstalledChannels(projectRoot);

  // Build recommendations
  const recommendations: SkillInfo[] = [];

  // Always recommended
  if (skillExists('add-compact')) {
    recommendations.push({
      name: 'add-compact',
      reason: 'Prevents context rotation and improves long-term memory',
      path: '.claude/skills/add-compact',
    });
  }

  // Channel-specific recommendations
  if (channels.includes('telegram')) {
    if (skillExists('add-telegram-swarm')) {
      recommendations.push({
        name: 'add-telegram-swarm',
        reason: 'Enable per-agent bot identities via @agent_* mentions',
        path: '.claude/skills/add-telegram-swarm',
      });
    }
  }

  // Advanced/optional skills
  const advancedSkills = [
    { name: 'add-gmail', reason: 'Read and send emails via Gmail' },
    { name: 'add-emacs', reason: 'Open files in Emacs, manage org-mode tasks' },
    {
      name: 'add-parallel',
      reason: 'Run multiple Claude agents in parallel',
    },
    { name: 'add-ollama-tool', reason: 'Query local Ollama models' },
    { name: 'claw', reason: 'Quick CLI commands for common tasks' },
  ];
  for (const s of advancedSkills) {
    if (skillExists(s.name)) {
      recommendations.push({
        name: s.name,
        reason: s.reason,
        path: `.claude/skills/${s.name}`,
      });
    }
  }

  // Emit the detected channels and available recommendations
  emitStatus('SKILLS', {
    DETECTED_CHANNELS: channels.join(','),
    RECOMMENDATIONS: recommendations.map((r) => r.name).join(','),
    RECOMMENDATION_COUNT: recommendations.length,
    STATUS: 'offer',
    LOG: 'logs/setup.log',
  });
}
