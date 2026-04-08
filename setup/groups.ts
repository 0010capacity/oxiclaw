/**
 * Step: groups — List group metadata from the local database.
 * Group names for Telegram/Slack/Discord are resolved at runtime.
 * Replaces 05-sync-groups.sh + 05b-list-groups.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  // pi-mono resolves group names at runtime; no upfront sync needed.
  console.log('GROUPS_SYNC: STATUS=skipped REASON=pi_mono_no_upfront_sync');
}