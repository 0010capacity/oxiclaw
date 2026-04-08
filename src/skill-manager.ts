/**
 * Skill Registry Manager for OxiClaw
 *
 * Manages skill installation from GitHub repos or registry URLs.
 * Skills are SKILL.md directories that get installed to container/skills/.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// --- Types ---

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  category: 'container-tool' | 'channel' | 'utility' | 'feature';
  repository: string;
  sha?: string;
  skill_md_path: string;
  cli_dependencies?: string[];
}

export interface RegistryIndex {
  'format-version': string;
  registry: string;
  updated_at: string;
  skills: SkillManifest[];
}

export interface InstalledSkillInfo {
  name: string;
  version: string;
  description: string;
  category: string;
  installed_at?: string;
  source?: string;
}

// --- Constants ---

const BUILT_IN_SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const SKILL_REGISTRY_URL =
  'https://raw.githubusercontent.com/oxiclaw/skill-registry/main/registry.json';
const SKILL_REGISTRY_CACHE = path.join(DATA_DIR, 'skill-registry-cache.json');
const LOCAL_REGISTRY = path.join(DATA_DIR, 'skill-registry.json');

// --- Helpers ---

async function fetchRegistry(url: string): Promise<RegistryIndex | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'Failed to fetch remote registry',
      );
      return null;
    }
    const data = await response.json();
    return data as RegistryIndex;
  } catch (err) {
    logger.warn({ err }, 'Error fetching remote registry');
    return null;
  }
}

async function loadLocalRegistry(): Promise<RegistryIndex | null> {
  if (!fs.existsSync(LOCAL_REGISTRY)) {
    return null;
  }
  try {
    return JSON.parse(
      fs.readFileSync(LOCAL_REGISTRY, 'utf-8'),
    ) as RegistryIndex;
  } catch (err) {
    logger.warn({ err }, 'Failed to parse local registry');
    return null;
  }
}

function getInstalledSkillsDir(): string {
  return BUILT_IN_SKILLS_DIR;
}

function readSkillManifest(skillDir: string): SkillManifest | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return null;
  }

  // Parse frontmatter from SKILL.md
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    // No frontmatter — treat as a basic skill with name from directory
    const skillName = path.basename(skillDir);
    return {
      name: skillName,
      version: '1.0.0',
      description: skillName,
      category: 'utility',
      repository: '',
      skill_md_path: 'SKILL.md',
    };
  }

  const frontmatter = frontmatterMatch[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const categoryMatch = frontmatter.match(/^category:\s*(.+)$/m);

  return {
    name: nameMatch?.[1] || path.basename(skillDir),
    version: versionMatch?.[1] || '1.0.0',
    description: descriptionMatch?.[1] || '',
    category: (categoryMatch?.[1] as SkillManifest['category']) || 'utility',
    repository: '',
    skill_md_path: 'SKILL.md',
  };
}

function getInstalledAt(skillDir: string): string | undefined {
  try {
    const stat = fs.statSync(skillDir);
    return stat.mtime.toISOString();
  } catch {
    return undefined;
  }
}

// --- Public API ---

/**
 * List skills available in the registry (cached).
 */
export async function listAvailableSkills(): Promise<SkillManifest[]> {
  // Try cache first
  if (fs.existsSync(SKILL_REGISTRY_CACHE)) {
    try {
      const cached = JSON.parse(
        fs.readFileSync(SKILL_REGISTRY_CACHE, 'utf-8'),
      ) as RegistryIndex;
      if (cached['format-version'] === '1.0') {
        const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
        if (cacheAge < 3600_000) {
          logger.debug('Using cached skill registry');
          return cached.skills;
        }
      }
    } catch {
      // Cache corrupted, re-fetch below
    }
  }

  // Fetch from remote registry
  const registry = await fetchRegistry(SKILL_REGISTRY_URL);
  if (registry) {
    fs.writeFileSync(SKILL_REGISTRY_CACHE, JSON.stringify(registry, null, 2));
    return registry.skills;
  }

  // Fallback: use local registry
  const local = await loadLocalRegistry();
  if (local) {
    return local.skills;
  }

  // Fallback: list built-in skills
  return listBuiltInSkills();
}

/**
 * List built-in skills bundled with OxiClaw.
 */
export function listBuiltInSkills(): SkillManifest[] {
  const skills: SkillManifest[] = [];
  if (!fs.existsSync(BUILT_IN_SKILLS_DIR)) {
    return skills;
  }

  for (const entry of fs.readdirSync(BUILT_IN_SKILLS_DIR)) {
    const skillDir = path.join(BUILT_IN_SKILLS_DIR, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const manifest = readSkillManifest(skillDir);
    if (manifest) {
      skills.push(manifest);
    }
  }

  return skills;
}

/**
 * List skills currently installed in container/skills/.
 */
export function listInstalledSkills(): InstalledSkillInfo[] {
  const installed: InstalledSkillInfo[] = [];

  if (!fs.existsSync(BUILT_IN_SKILLS_DIR)) {
    return installed;
  }

  for (const entry of fs.readdirSync(BUILT_IN_SKILLS_DIR)) {
    const skillDir = path.join(BUILT_IN_SKILLS_DIR, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const manifest = readSkillManifest(skillDir);
    if (manifest) {
      installed.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        category: manifest.category,
        installed_at: getInstalledAt(skillDir),
        source: 'built-in',
      });
    }
  }

  return installed;
}

/**
 * Install a skill by name or git URL.
 * - If name matches a registry entry, download from git
 * - If it's a git URL, clone directly
 * - SKILL.md is copied to container/skills/{name}/
 */
export async function installSkill(
  nameOrUrl: string,
  options?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; skillName?: string }> {
  const skillsDir = getInstalledSkillsDir();
  fs.mkdirSync(skillsDir, { recursive: true });

  let skillName: string;
  let gitUrl: string;

  if (nameOrUrl.startsWith('https://') || nameOrUrl.startsWith('git@')) {
    // Direct git URL
    gitUrl = nameOrUrl;
    // Extract repo name from URL
    const repoMatch = nameOrUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    if (!repoMatch) {
      return { ok: false, error: 'Invalid git URL' };
    }
    skillName = repoMatch[1].replace(/^skill-/, '');
  } else {
    // Name lookup from registry
    const available = await listAvailableSkills();
    const skill = available.find(
      (s) => s.name === nameOrUrl || s.name === `skill-${nameOrUrl}`,
    );
    if (!skill) {
      return { ok: false, error: `Skill '${nameOrUrl}' not found in registry` };
    }
    skillName = skill.name;
    gitUrl = skill.repository;
  }

  const targetDir = path.join(skillsDir, skillName);
  if (fs.existsSync(targetDir) && !options?.force) {
    return {
      ok: false,
      error: `Skill '${skillName}' is already installed. Use --force to reinstall.`,
    };
  }

  // Remove existing installation if force
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
  }

  // Clone the repository to a temp directory
  const tmpDir = path.join(DATA_DIR, 'tmp', `skill-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    logger.info({ gitUrl, targetDir }, 'Installing skill from git');

    execSync(`git clone --depth 1 ${gitUrl} ${tmpDir}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    // Find SKILL.md (either at root or in a subdirectory)
    let skillMdPath = path.join(tmpDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      // Try to find SKILL.md in subdirectories
      const subdirs = fs.readdirSync(tmpDir, { withFileTypes: true });
      for (const dir of subdirs) {
        if (dir.isDirectory()) {
          const nestedPath = path.join(tmpDir, dir.name, 'SKILL.md');
          if (fs.existsSync(nestedPath)) {
            skillMdPath = nestedPath;
            break;
          }
        }
      }
    }

    if (!fs.existsSync(skillMdPath)) {
      return { ok: false, error: 'SKILL.md not found in repository' };
    }

    // Create target directory and copy SKILL.md
    fs.mkdirSync(targetDir, { recursive: true });
    const targetSkillMd = path.join(targetDir, 'SKILL.md');
    fs.copyFileSync(skillMdPath, targetSkillMd);

    // Copy supporting files (everything except .git)
    for (const entry of fs.readdirSync(tmpDir)) {
      if (entry === '.git') continue;
      if (entry === 'SKILL.md') continue;
      const src = path.join(tmpDir, entry);
      const dst = path.join(targetDir, entry);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    logger.info({ skillName, targetDir }, 'Skill installed successfully');
    return { ok: true, skillName };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to install skill');
    return { ok: false, error: errorMsg };
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Remove a skill from container/skills/.
 */
export function removeSkill(name: string): { ok: boolean; error?: string } {
  const skillsDir = getInstalledSkillsDir();
  const targetDir = path.join(skillsDir, name);

  if (!fs.existsSync(targetDir)) {
    return { ok: false, error: `Skill '${name}' is not installed` };
  }

  // Prevent removing critical built-in skills
  const criticalSkills = ['capabilities', 'status'];
  if (criticalSkills.includes(name)) {
    return { ok: false, error: `Cannot remove critical skill '${name}'` };
  }

  fs.rmSync(targetDir, { recursive: true });
  logger.info({ name }, 'Skill removed');
  return { ok: true };
}

/**
 * Format installed skills as a readable string for display.
 */
export function formatInstalledSkillsList(
  skills: InstalledSkillInfo[],
): string {
  if (skills.length === 0) {
    return 'No skills installed.';
  }

  const lines = skills.map(
    (s) => `• ${s.name} v${s.version} — ${s.description} [${s.category}]`,
  );
  return ['Installed Skills:', ...lines].join('\n');
}

/**
 * Format available skills from registry as a readable string.
 */
export function formatAvailableSkillsList(
  skills: SkillManifest[],
  installedNames: Set<string>,
): string {
  if (skills.length === 0) {
    return 'No skills available in registry.';
  }

  const lines = skills.map((s) => {
    const installed = installedNames.has(s.name) ? ' (installed)' : '';
    return `• ${s.name} v${s.version}${installed} — ${s.description} [${s.category}]`;
  });
  return ['Available Skills:', ...lines].join('\n');
}
