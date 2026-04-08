/**
 * X Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * Uses pi-mono's defineTool + TypeBox for schema definition.
 */

// @ts-ignore - SDK available in container environment only
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'x_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 60000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create X integration MCP tools
 */
export function createXTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  const xPostTool = defineTool({
    name: 'x_post',
    description: 'Post a tweet to X (Twitter). Main group only.\n\nThe host machine will execute the browser automation to post the tweet.\nMake sure the content is appropriate and within X\'s character limit (280 chars for text).',
    parameters: Type.Object({
      content: Type.String({ description: 'The tweet content to post (max 280 characters)' }),
    }),
    execute: async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text', text: 'Only the main group can post tweets.' }],
          isError: true
        };
      }

      if (args.content.length > 280) {
        return {
          content: [{ type: 'text', text: `Tweet exceeds 280 character limit (current: ${args.content.length})` }],
          isError: true
        };
      }

      const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_post',
        requestId,
        content: args.content,
        groupFolder,
        timestamp: new Date().toISOString()
      });

      const result = await waitForResult(requestId);
      return {
        content: [{ type: 'text', text: result.message }],
        isError: !result.success
      };
    }
  });

  const xLikeTool = defineTool({
    name: 'x_like',
    description: 'Like a tweet on X (Twitter). Main group only.\n\nProvide the tweet URL or tweet ID to like.',
    parameters: Type.Object({
      tweet_url: Type.String({ description: 'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID' }),
    }),
    execute: async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
          isError: true
        };
      }

      const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_like',
        requestId,
        tweetUrl: args.tweet_url,
        groupFolder,
        timestamp: new Date().toISOString()
      });

      const result = await waitForResult(requestId);
      return {
        content: [{ type: 'text', text: result.message }],
        isError: !result.success
      };
    }
  });

  const xReplyTool = defineTool({
    name: 'x_reply',
    description: 'Reply to a tweet on X (Twitter). Main group only.\n\nProvide the tweet URL and your reply content.',
    parameters: Type.Object({
      tweet_url: Type.String({ description: 'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID' }),
      content: Type.String({ description: 'The reply content (max 280 characters)' }),
    }),
    execute: async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
          isError: true
        };
      }

      const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_reply',
        requestId,
        tweetUrl: args.tweet_url,
        content: args.content,
        groupFolder,
        timestamp: new Date().toISOString()
      });

      const result = await waitForResult(requestId);
      return {
        content: [{ type: 'text', text: result.message }],
        isError: !result.success
      };
    }
  });

  const xRetweetTool = defineTool({
    name: 'x_retweet',
    description: 'Retweet a tweet on X (Twitter). Main group only.\n\nProvide the tweet URL to retweet.',
    parameters: Type.Object({
      tweet_url: Type.String({ description: 'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID' }),
    }),
    execute: async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
          isError: true
        };
      }

      const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_retweet',
        requestId,
        tweetUrl: args.tweet_url,
        groupFolder,
        timestamp: new Date().toISOString()
      });

      const result = await waitForResult(requestId);
      return {
        content: [{ type: 'text', text: result.message }],
        isError: !result.success
      };
    }
  });

  const xQuoteTool = defineTool({
    name: 'x_quote',
    description: 'Quote tweet on X (Twitter). Main group only.\n\nRetweet with your own comment added.',
    parameters: Type.Object({
      tweet_url: Type.String({ description: 'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID' }),
      comment: Type.String({ description: 'Your comment for the quote tweet (max 280 characters)' }),
    }),
    execute: async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
          isError: true
        };
      }

      const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_quote',
        requestId,
        tweetUrl: args.tweet_url,
        comment: args.comment,
        groupFolder,
        timestamp: new Date().toISOString()
      });

      const result = await waitForResult(requestId);
      return {
        content: [{ type: 'text', text: result.message }],
        isError: !result.success
      };
    }
  });

  return [xPostTool, xLikeTool, xReplyTool, xRetweetTool, xQuoteTool];
}
