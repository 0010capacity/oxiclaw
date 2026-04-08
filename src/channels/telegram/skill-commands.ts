import type { Telegraf, Context } from 'telegraf';
import type { Update } from '@telegraf/types';
import type { RegisteredGroup } from '../../types.js';
import {
  installSkill,
  listInstalledSkills,
  listAvailableSkills,
  removeSkill,
} from '../../skill-manager.js';
import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Register skill-related commands on a Telegram bot.
 * Commands:
 *   /skill list        - List installed skills
 *   /skill available   - List available skills from registry
 *   /skill install <name> - Install a skill by name or git URL
 *   /skill remove <name> - Remove an installed skill
 *   /skill info <name>   - Show skill details
 */
export function registerSkillCommands(
  bot: Telegraf<Context<Update>>,
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  bot.command('skill', async (ctx: Context<Update>) => {
    const text =
      'text' in (ctx.message || {})
        ? (ctx.message as { text?: string }).text || ''
        : '';
    const parts = text.replace('/skill', '').trim().split(/\s+/);
    const subcommand = parts[0];
    const name = parts[1];

    if (!subcommand || subcommand === 'help') {
      await ctx.reply(
        `<b>Skill Commands</b>\n\n` +
          `/skill list - List installed skills\n` +
          `/skill available - List available skills\n` +
          `/skill install &lt;name&gt; - Install a skill\n` +
          `/skill remove &lt;name&gt; - Remove a skill\n` +
          `/skill info &lt;name&gt; - Show skill details`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    switch (subcommand) {
      case 'list': {
        const skills = listInstalledSkills();
        if (skills.length === 0) {
          await ctx.reply('No skills installed.');
          return;
        }
        const lines = skills.map(
          (s) =>
            `• <b>${s.name}</b> v${s.version}\n  ${s.description} [${s.category}]`,
        );
        await ctx.reply(`<b>Installed Skills</b>\n\n${lines.join('\n\n')}`, {
          parse_mode: 'HTML',
        });
        break;
      }

      case 'available': {
        await ctx.reply('<i>Fetching available skills...</i>', {
          parse_mode: 'HTML',
        });
        const skills = await listAvailableSkills();
        if (skills.length === 0) {
          await ctx.reply('No skills available in registry.');
          return;
        }
        // Show first 20 to avoid message length limits
        const shown = skills.slice(0, 20);
        const lines = shown.map(
          (s) => `• <b>${s.name}</b>\n  ${s.description} [${s.category}]`,
        );
        const footer =
          skills.length > 20
            ? `\n\n<i>...and ${skills.length - 20} more. Install with /skill install &lt;name&gt;</i>`
            : `\n\n<i>Install with /skill install &lt;name&gt;</i>`;
        await ctx.reply(
          `<b>Available Skills</b>\n\n${lines.join('\n\n')}${footer}`,
          {
            parse_mode: 'HTML',
          },
        );
        break;
      }

      case 'install': {
        if (!name) {
          await ctx.reply('Usage: /skill install &lt;name-or-url&gt;');
          return;
        }
        await ctx.reply(`<i>Installing '${name}'...</i>`, {
          parse_mode: 'HTML',
        });
        const result = await installSkill(name);
        if (result.ok) {
          // Write restart sentinel so container restarts to pick up the new skill
          const chatId = String(ctx.message?.chat?.id || '');
          const group = registeredGroups()[chatId];
          const groupFolder = group?.folder || 'main';
          const sessionsDir = path.join(DATA_DIR, 'sessions', groupFolder);
          try {
            mkdirSync(sessionsDir, { recursive: true });
            writeFileSync(path.join(sessionsDir, '.restart-skill'), '');
            logger.info({ groupFolder }, 'Restart sentinel written for skill install');
          } catch (err) {
            logger.warn({ err, groupFolder }, 'Failed to write restart sentinel');
          }
          await ctx.reply(
            `✅ Skill <b>${result.skillName || name}</b> installed.\n<i>Container restarting to apply...</i>`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.reply(`❌ Failed: ${result.error}`);
        }
        break;
      }

      case 'remove': {
        if (!name) {
          await ctx.reply('Usage: /skill remove &lt;name&gt;');
          return;
        }
        const result = removeSkill(name);
        if (result.ok) {
          // Write restart sentinel so container restarts to pick up the change
          const chatId = String(ctx.message?.chat?.id || '');
          const group = registeredGroups()[chatId];
          const groupFolder = group?.folder || 'main';
          const sessionsDir = path.join(DATA_DIR, 'sessions', groupFolder);
          try {
            mkdirSync(sessionsDir, { recursive: true });
            writeFileSync(path.join(sessionsDir, '.restart-skill'), '');
          } catch { /* ignore */ }
          await ctx.reply(
            `🗑 Skill <b>${name}</b> removed.\n<i>Container restarting to apply...</i>`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.reply(`❌ ${result.error}`);
        }
        break;
      }

      case 'info': {
        if (!name) {
          await ctx.reply('Usage: /skill info &lt;name&gt;');
          return;
        }
        // Check installed first
        const installed = listInstalledSkills().find((s) => s.name === name);
        if (installed) {
          await ctx.reply(
            `<b>${installed.name}</b> (installed)\n\n` +
              `${installed.description}\n\n` +
              `<b>Version:</b> ${installed.version}\n` +
              `<b>Category:</b> ${installed.category}\n` +
              `<b>Installed:</b> ${installed.installed_at || 'unknown'}`,
            { parse_mode: 'HTML' },
          );
          return;
        }
        // Check available
        const available = (await listAvailableSkills()).find(
          (s) => s.name === name,
        );
        if (available) {
          await ctx.reply(
            `<b>${available.name}</b> (available)\n\n` +
              `${available.description}\n\n` +
              `<b>Version:</b> ${available.version}\n` +
              `<b>Category:</b> ${available.category}\n\n` +
              `Install with /skill install ${available.name}`,
            { parse_mode: 'HTML' },
          );
          return;
        }
        await ctx.reply(`Skill '${name}' not found.`);
        break;
      }

      default:
        await ctx.reply(
          `Unknown subcommand: ${subcommand}\n` +
            `Use /skill without args for help.`,
        );
    }
  });
}
