/**
 * Step: credentials — Configure pi-mono SDK auth.json for a group.
 *
 * Supports multiple LLM providers: anthropic, openai, zai, custom, etc.
 * Credentials are stored per-group at data/credentials/{group}/.pi/agent/
 * - auth.json: API keys, OAuth tokens
 * - models.json: model configuration
 *
 * Usage:
 *   --provider <name>     Provider: anthropic, openai, zai, or custom
 *   --api-key <key>       API key for the provider
 *   --base-url <url>      Base URL for custom providers
 *   --list-models         List available models for the provider
 *   --group <name>        Group name (default: main)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface ProviderConfig {
  name: string;
  keyPrefix: string;       // API key prefix to validate
  baseUrl?: string;        // Default base URL for API calls
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    keyPrefix: 'sk-ant-',
    baseUrl: 'https://api.anthropic.com',
  },
  openai: {
    name: 'OpenAI',
    keyPrefix: 'sk-',
    baseUrl: 'https://api.openai.com/v1',
  },
  zai: {
    name: 'ZAI',
    keyPrefix: '',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
};

function parseArgs(args: string[]): {
  group: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  listModels: boolean;
} {
  let group = 'main';
  let provider: string | undefined;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let listModels = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--group' && args[i + 1]) {
      group = args[i + 1];
      i++;
    } else if (args[i] === '--provider' && args[i + 1]) {
      provider = args[i + 1];
      i++;
    } else if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    } else if (args[i] === '--base-url' && args[i + 1]) {
      baseUrl = args[i + 1];
      i++;
    } else if (args[i] === '--list-models') {
      listModels = true;
    }
  }

  return { group, provider, apiKey, baseUrl, listModels };
}

function validateApiKey(provider: string, apiKey: string): string | null {
  const config = PROVIDERS[provider];
  if (!config) {
    return null; // Custom provider, no validation
  }

  if (config.keyPrefix && !apiKey.startsWith(config.keyPrefix)) {
    return `API key must start with "${config.keyPrefix}" for ${config.name}`;
  }
  return null;
}

/**
 * Fetch available models from a provider's API.
 * Uses OpenAI-compatible /models endpoint.
 */
async function fetchModelsFromProvider(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<string[]> {
  const config = PROVIDERS[provider];
  if (!config && !baseUrl) {
    return [];
  }

  const url = `${baseUrl || config!.baseUrl}/models`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn({ provider, url, status: response.status }, 'Failed to fetch models');
      return [];
    }

    const data = await response.json() as { data?: Array<{ id: string }> };

    if (data.data && Array.isArray(data.data)) {
      return data.data.map(m => m.id).sort();
    }

    return [];
  } catch (err) {
    logger.warn({ provider, url, err }, 'Error fetching models');
    return [];
  }
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { group, provider, apiKey, baseUrl, listModels } = parseArgs(args);

  logger.info({ group, provider, hasApiKey: !!apiKey, listModels }, 'Configuring credentials');

  // Handle --list-models flag
  if (listModels) {
    if (!provider) {
      emitStatus('CREDENTIALS', {
        CREDENTIALS: 'missing',
        STATUS: 'needs_input',
        ERROR: '--list-models requires --provider',
        SUPPORTED_PROVIDERS: Object.keys(PROVIDERS),
        LOG: 'logs/setup.log',
      });
      return;
    }

    if (!apiKey) {
      emitStatus('CREDENTIALS', {
        PROVIDER: provider,
        CREDENTIALS: 'missing',
        STATUS: 'needs_input',
        ERROR: '--list-models requires --api-key',
        HINT: `Run with --provider ${provider} --api-key <key> --list-models`,
        LOG: 'logs/setup.log',
      });
      return;
    }

    const models = await fetchModelsFromProvider(provider, apiKey, baseUrl);

    if (models.length === 0) {
      emitStatus('CREDENTIALS', {
        PROVIDER: provider,
        MODELS: [],
        CREDENTIALS: 'no_models_found',
        STATUS: 'needs_input',
        HINT: 'Could not fetch models. Check your API key and network connection.',
        LOG: 'logs/setup.log',
      });
    } else {
      emitStatus('CREDENTIALS', {
        PROVIDER: provider,
        MODELS: models,
        MODEL_COUNT: models.length,
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
    }
    return;
  }

  // Ensure the credential directory exists
  const agentDir = path.join(DATA_DIR, 'credentials', group, '.pi', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  const authFile = path.join(agentDir, 'auth.json');
  const modelsFile = path.join(agentDir, 'models.json');

  // Load existing auth.json or initialize empty
  let auth: Record<string, unknown> = {};
  if (fs.existsSync(authFile)) {
    try {
      auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    } catch {
      auth = {};
    }
  }

  // Initialize models.json if missing
  if (!fs.existsSync(modelsFile)) {
    fs.writeFileSync(modelsFile, '{"providers":{}}', 'utf-8');
  }

  // Check if provider already configured
  if (provider && (auth as Record<string, { type: string; key?: string }>)[provider]?.key) {
    logger.info({ group, provider }, 'Provider already configured');
    emitStatus('CREDENTIALS', {
      GROUP: group,
      PROVIDER: provider,
      CREDENTIALS: 'configured',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // If no provider specified, we need to ask the user
  if (!provider) {
    emitStatus('CREDENTIALS', {
      GROUP: group,
      CREDENTIALS: 'missing',
      STATUS: 'needs_input',
      HINT: 'Run with --provider <anthropic|openai|zai|custom> --api-key <key>',
      SUPPORTED_PROVIDERS: Object.keys(PROVIDERS),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Validate provider
  const isCustom = provider === 'custom';
  if (!isCustom && !PROVIDERS[provider]) {
    emitStatus('CREDENTIALS', {
      GROUP: group,
      CREDENTIALS: 'invalid',
      STATUS: 'failed',
      ERROR: `Unknown provider: ${provider}`,
      SUPPORTED_PROVIDERS: Object.keys(PROVIDERS),
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // If no API key, prompt
  if (!apiKey) {
    emitStatus('CREDENTIALS', {
      GROUP: group,
      PROVIDER: provider,
      CREDENTIALS: 'missing',
      STATUS: 'needs_input',
      HINT: `Run with --provider ${provider} --api-key <your-api-key>`,
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Validate API key format
  const validationError = validateApiKey(provider, apiKey);
  if (validationError) {
    emitStatus('CREDENTIALS', {
      GROUP: group,
      PROVIDER: provider,
      CREDENTIALS: 'invalid',
      STATUS: 'failed',
      ERROR: validationError,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Build auth entry for this provider
  const authEntry: Record<string, unknown> = {
    type: 'api_key',
    key: apiKey,
  };

  // For custom providers, add baseUrl if provided
  if (isCustom && baseUrl) {
    authEntry.baseUrl = baseUrl;
  }

  // Update auth.json with new provider credentials
  auth[provider] = authEntry;
  fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
  logger.info({ group, provider }, 'Credentials written to auth.json');

  emitStatus('CREDENTIALS', {
    GROUP: group,
    PROVIDER: provider,
    CREDENTIALS: 'configured',
    METHOD: 'api_key',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
