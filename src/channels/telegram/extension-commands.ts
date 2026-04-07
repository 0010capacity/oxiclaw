import type { Telegraf } from "telegraf";
import { listExtensions, addExtension, removeExtension, getExtensionInfo, AVAILABLE_EXTENSIONS } from "../../extension-manager";

interface ExtensionCommandContext {
  message?: {
    text?: string;
    chat?: {
      id: number;
    };
  };
  reply: (text: string) => Promise<void>;
  replyWithHTML: (text: string) => Promise<void>;
}

/**
 * Register extension-related commands on a Telegram bot.
 * Commands:
 *   /extension list              - List all available extensions
 *   /extension add <name>        - Install an extension
 *   /extension remove <name>     - Uninstall an extension
 *   /extension info <name>       - Show extension details
 */
export function registerExtensionCommands(bot: Telegraf<ExtensionCommandContext>): void {
  bot.command("extension", async (ctx) => {
    const text = ctx.message?.text || "";
    const parts = text.replace("/extension", "").trim().split(/\s+/);
    const subcommand = parts[0];
    const name = parts[1];

    if (!subcommand) {
      await ctx.replyWithHTML(
        `<b>Extension Commands</b>\n\n` +
        `/extension list - List available extensions\n` +
        `/extension add &lt;name&gt; - Install an extension\n` +
        `/extension remove &lt;name&gt; - Uninstall an extension\n` +
        `/extension info &lt;name&gt; - Show extension details`
      );
      return;
    }

    const chatId = String(ctx.message?.chat?.id || "default");

    try {
      if (subcommand === "list") {
        const extensions = listExtensions();
        const groupExtensions = listExtensions(chatId);

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

        await ctx.replyWithHTML(message);
      } else if (subcommand === "add" && name) {
        if (!AVAILABLE_EXTENSIONS.includes(name)) {
          await ctx.reply(`Unknown extension: ${name}\nAvailable: ${AVAILABLE_EXTENSIONS.join(", ")}`);
          return;
        }

        addExtension(chatId, name);
        await ctx.replyWithHTML(`✅ Extension <code>${name}</code> added. Container restarting...`);
      } else if (subcommand === "remove" && name) {
        removeExtension(chatId, name);
        await ctx.replyWithHTML(`🗑 Extension <code>${name}</code> removed. Container restarting...`);
      } else if (subcommand === "info" && name) {
        const info = getExtensionInfo(name);
        if (!info) {
          await ctx.reply(`Unknown extension: ${name}`);
          return;
        }

        const message =
          `<b>${info.name}</b>\n\n` +
          `${info.description}\n\n` +
          `<b>Tools:</b>\n` +
          info.tools.map((t) => `• <code>${t}</code>`).join("\n");

        await ctx.replyWithHTML(message);
      } else {
        await ctx.replyWithHTML(
          `Usage:\n` +
          `/extension list\n` +
          `/extension add &lt;name&gt;\n` +
          `/extension remove &lt;name&gt;\n` +
          `/extension info &lt;name&gt;`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Error: ${errorMessage}`);
    }
  });

  // Shortcut commands for quick access
  bot.command("extensions", async (ctx) => {
    // Alias for /extension list
    const extensions = listExtensions();
    let message = `<b>Available Extensions</b>\n\n`;
    for (const ext of extensions) {
      const info = getExtensionInfo(ext);
      const desc = info?.description || "";
      message += `• <code>${ext}</code> - ${desc}\n`;
    }
    await ctx.replyWithHTML(message);
  });
}