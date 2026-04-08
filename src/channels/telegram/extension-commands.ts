import type { Telegraf, Context } from 'telegraf';
import type { Update } from '@telegraf/types';
import type { RegisteredGroup } from '../../types.js';
import {
  listExtensions,
  addExtension,
  removeExtension,
  getExtensionInfo,
  AVAILABLE_EXTENSIONS,
} from '../../extension-manager.js';

/**
 * Register extension-related commands on a Telegram bot.
 * Commands:
 *   /extension list              - List all available extensions
 *   /extension add <name>        - Install an extension
 *   /extension remove <name>     - Uninstall an extension
 *   /extension info <name>       - Show extension details
 */
export function registerExtensionCommands(
  bot: Telegraf<Context<Update>>,
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  bot.command('extension', async (ctx: Context<Update>) => {
    const text =
      'text' in (ctx.message || {})
        ? (ctx.message as { text?: string }).text || ''
        : '';
    const parts = text.replace('/extension', '').trim().split(/\s+/);
    const subcommand = parts[0];
    const name = parts[1];

    if (!subcommand) {
      await ctx.reply(
        `<b>Extension Commands</b>\n\n` +
          `/extension list - List available extensions\n` +
          `/extension add &lt;name&gt; - Install an extension\n` +
          `/extension remove &lt;name&gt; - Uninstall an extension\n` +
          `/extension info &lt;name&gt; - Show extension details`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const chatId = String(ctx.message?.chat?.id || 'default');

    try {
      if (subcommand === 'list') {
        const extensions = listExtensions();
        // Look up group.folder from registeredGroups to list extensions
        // from the correct group directory (not the Telegram JID)
        const groups = registeredGroups();
        const group = groups[chatId];
        const groupExtensions = group ? listExtensions(group.folder) : [];

        let message = `<b>Available Extensions</b>\n\n`;
        message += `<b>Global:</b>\n`;
        for (const ext of extensions) {
          message += `• <code>${ext}</code>\n`;
        }

        if (groupExtensions.length > 0) {
          message += `\n<b>Installed:</b>\n`;
          for (const ext of groupExtensions) {
            message += `• <code>${ext}</code>\n`;
          }
        }

        await ctx.reply(message, { parse_mode: 'HTML' });
      } else if (subcommand === 'add' && name) {
        if (!AVAILABLE_EXTENSIONS.includes(name)) {
          await ctx.reply(
            `Unknown extension: ${name}\nAvailable: ${AVAILABLE_EXTENSIONS.join(', ')}`,
          );
          return;
        }

        // Look up group.folder from registeredGroups to ensure extensions
        // are stored in the correct group directory (not the Telegram JID)
        const groups = registeredGroups();
        const group = groups[chatId];
        if (!group) {
          await ctx.reply(`Group not registered: ${chatId}`);
          return;
        }
        addExtension(group.folder, name);
        await ctx.reply(
          `✅ Extension <code>${name}</code> added. Container restarting...`,
          { parse_mode: 'HTML' },
        );
      } else if (subcommand === 'remove' && name) {
        // Look up group.folder from registeredGroups to ensure extensions
        // are removed from the correct group directory (not the Telegram JID)
        const groups = registeredGroups();
        const group = groups[chatId];
        if (!group) {
          await ctx.reply(`Group not registered: ${chatId}`);
          return;
        }
        removeExtension(group.folder, name);
        await ctx.reply(
          `🗑 Extension <code>${name}</code> removed. Container restarting...`,
          { parse_mode: 'HTML' },
        );
      } else if (subcommand === 'info' && name) {
        const info = getExtensionInfo(name);
        if (!info) {
          await ctx.reply(`Unknown extension: ${name}`);
          return;
        }

        const message =
          `<b>${info.name}</b>\n\n` +
          `${info.description}\n\n` +
          `<b>Tools:</b>\n` +
          info.tools.map((t: string) => `• <code>${t}</code>`).join('\n');

        await ctx.reply(message, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(
          `Usage:\n` +
            `/extension list\n` +
            `/extension add &lt;name&gt;\n` +
            `/extension remove &lt;name&gt;\n` +
            `/extension info &lt;name&gt;`,
          { parse_mode: 'HTML' },
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await ctx.reply(`Error: ${errorMessage}`);
    }
  });

  // Shortcut commands for quick access
  bot.command('extensions', async (ctx: Context<Update>) => {
    // Alias for /extension list
    const extensions = listExtensions();
    let message = `<b>Available Extensions</b>\n\n`;
    for (const ext of extensions) {
      const info = getExtensionInfo(ext);
      const desc = info?.description || '';
      message += `• <code>${ext}</code> - ${desc}\n`;
    }
    await ctx.reply(message, { parse_mode: 'HTML' });
  });
}
