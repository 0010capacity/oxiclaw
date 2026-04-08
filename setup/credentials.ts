/**
 * Step: credentials — Configure pi-mono SDK auth.json for a group.
 *
 * Credentials are stored per-group at data/credentials/{group}/.pi/agent/
 * - auth.json: API keys, OAuth tokens
 * - models.json: model configuration
 *
 * These are mounted into containers at /workspace/group/.pi/agent/ via XDG_CONFIG_HOME.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { group: string } {
  let group = 'main';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--group' && args[i + 1]) {
      group = args[i + 1];
      i++;
    }
  }
  return { group };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { group } = parseArgs(args);

  logger.info({ group }, 'Configuring credentials');

  // Ensure the credential directory exists
  const agentDir = path.join(DATA_DIR, 'credentials', group, '.pi', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  const authFile = path.join(agentDir, 'auth.json');
  const modelsFile = path.join(agentDir, 'models.json');

  // Initialize auth.json if missing
  if (!fs.existsSync(authFile)) {
    fs.writeFileSync(authFile, '{}', 'utf-8');
  }

  // Initialize models.json if missing
  if (!fs.existsSync(modelsFile)) {
    fs.writeFileSync(modelsFile, '{"providers":{}}', 'utf-8');
  }

  // Check if already configured
  let alreadyConfigured = false;
  try {
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    if (auth.providers?.anthropic?.api_key) {
      alreadyConfigured = true;
    }
  } catch {
    // Invalid JSON — will be overwritten below
  }

  if (alreadyConfigured) {
    logger.info({ group }, 'Credentials already configured');
    emitStatus('CREDENTIALS', {
      GROUP: group,
      CREDENTIALS: 'configured',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Prompt the user to provide credentials
  // (The setup skill handles AskUserQuestion; this step emits a status
  // indicating credentials are pending, then the caller re-invokes with --api-key)
  const apiKeyIdx = args.indexOf('--api-key');

  if (apiKeyIdx !== -1 && args[apiKeyIdx + 1]) {
    const apiKey = args[apiKeyIdx + 1].trim();
    if (!apiKey.startsWith('sk-ant-')) {
      emitStatus('CREDENTIALS', {
        GROUP: group,
        CREDENTIALS: 'invalid',
        STATUS: 'failed',
        ERROR: 'api_key_invalid_format',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }

    const auth = {
      providers: {
        anthropic: {
          api_key: apiKey,
        },
      },
    };
    fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
    logger.info({ group }, 'API key written to auth.json');

    emitStatus('CREDENTIALS', {
      GROUP: group,
      CREDENTIALS: 'configured',
      METHOD: 'api_key',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // No credentials provided — prompt for them
  emitStatus('CREDENTIALS', {
    GROUP: group,
    CREDENTIALS: 'missing',
    STATUS: 'needs_input',
    HINT: 'Run with --api-key <key>',
    LOG: 'logs/setup.log',
  });
}
