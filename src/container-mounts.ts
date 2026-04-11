/**
 * Shared container mount-building logic for OxiClaw.
 *
 * Extracted from container-runner.ts and container-pool.ts to eliminate
 * ~200 lines of duplicated mount construction code. Both modules now
 * delegate to `buildVolumeMounts()` defined here.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full set of volume mounts for a group's container.
 *
 * Handles main vs. non-main groups, per-group sessions, skills sync,
 * IPC directories, agent-runner source, additional mounts, and credentials.
 */
export function buildVolumeMounts(
  projectRoot: string,
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);

  // --- Main vs. non-main workspace mounts ---
  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: true });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({ hostPath: '/dev/null', containerPath: '/workspace/project/.env', readonly: true });
    }

    // Main gets writable access to the store (SQLite DB)
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({ hostPath: storeDir, containerPath: '/workspace/project/store', readonly: false });

    // Main gets its group folder as the working directory
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: false });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
    }
  }

  // --- Per-group pi-mono sessions directory ---
  // Each group gets their own .pi/ to prevent cross-group session access
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.pi');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          extensions: ['/workspace/group/extensions'],
          env: { PI_ENABLE_AUTO_MEMORY: '1' },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // --- Sync skills from container/skills/ into each group's .pi/skills/ ---
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      // Only copy if destination doesn't exist or source is newer
      const needsCopy =
        !fs.existsSync(dstDir) ||
        fs.statSync(srcDir).mtimeMs > fs.statSync(dstDir).mtimeMs;
      if (needsCopy) {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }
    }
  }
  // Mount at /home/node/.pi/agent so the SDK finds skills and settings
  mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.pi/agent', readonly: false });

  // --- Per-group IPC namespace ---
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({ hostPath: groupIpcDir, containerPath: '/workspace/ipc', readonly: false });

  // --- Copy agent-runner source into per-group writable location ---
  // Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) && fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({ hostPath: groupAgentRunnerDir, containerPath: '/app/src', readonly: false });

  // --- Additional mounts from external allowlist ---
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // --- Per-group pi-mono SDK credentials ---
  const agentDir = path.join(DATA_DIR, 'credentials', group.folder, '.pi', 'agent');
  const authFile = path.join(agentDir, 'auth.json');
  const modelsFile = path.join(agentDir, 'models.json');
  fs.mkdirSync(agentDir, { recursive: true });
  if (!fs.existsSync(authFile)) fs.writeFileSync(authFile, '{}', 'utf-8');
  if (!fs.existsSync(modelsFile)) fs.writeFileSync(modelsFile, '{"providers":{}}', 'utf-8');
  mounts.push({ hostPath: agentDir, containerPath: '/workspace/group/pi/agent', readonly: false });

  return mounts;
}
