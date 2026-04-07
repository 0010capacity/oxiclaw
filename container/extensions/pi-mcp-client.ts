import type { Extension } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "util";

interface MCPServerConfig {
  [name: string]: string;
}

interface MCPConfig {
  command: string;
  args?: string[];
}

function parseMCPConfig(): MCPServerConfig {
  const env = process.env.MCP_SERVERS;
  if (!env) return {};
  try {
    return JSON.parse(env);
  } catch {
    console.error("[pi-mcp-client] Failed to parse MCP_SERVERS env var");
    return {};
  }
}

function parseCommandLine(cmd: string): MCPConfig {
  const parts = cmd.trim().split(/\s+/);
  const { values } = parseArgs({ args: parts.slice(1), options: {}, allowPositionals: true });
  const positional = values._ as string[];
  return {
    command: parts[0],
    args: positional,
  };
}

/**
 * pi-mcp-client extension - bridges MCP servers to pi tools.
 * Parses MCP_SERVERS env var and registers MCP tools as pi Extension tools.
 */
export default function piMCPClientExtension(pi: Extension): void {
  const mcpServers = parseMCPConfig();

  if (Object.keys(mcpServers).length === 0) {
    console.log("[pi-mcp-client] No MCP servers configured (MCP_SERVERS env var not set)");
    return;
  }

  console.log(`[pi-mcp-client] Connecting to ${Object.keys(mcpServers).length} MCP server(s)`);

  for (const [name, commandLine] of Object.entries(mcpServers)) {
    const { command, args } = parseCommandLine(commandLine);

    console.log(`[pi-mcp-client] Connecting to MCP server: ${name} (${command} ${(args || []).join(" ")})`);

    const transport = new StdioClientTransport({ command, args: args || [] });
    const client = new Client({ name: `pi-${name}`, version: "1.0.0" }, { capabilities: {} });

    (async () => {
      try {
        await client.connect(transport);
        console.log(`[pi-mcp-client] Connected to MCP server: ${name}`);

        // List and register MCP tools
        const tools = await client.listTools();
        console.log(`[pi-mcp-client] Registering ${tools.tools.length} tools from ${name}`);

        for (const tool of tools.tools) {
          pi.registerTool({
            name: `mcp_${name}_${tool.name}`,
            label: `[MCP:${name}] ${tool.name}`,
            description: tool.description || `MCP tool: ${tool.name}`,
            parameters: typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
            async execute(id, params, signal, onUpdate) {
              try {
                const result = await client.callTool(
                  { name: tool.name, arguments: params },
                  signal
                );
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              } catch (error) {
                return {
                  content: [{ type: "text", text: `MCP error: ${error instanceof Error ? error.message : String(error)}` }],
                };
              }
            },
          });
        }
      } catch (e) {
        console.error(`[pi-mcp-client] Failed to connect to ${name}:`, e);
      }
    })();
  }
}