import type { Extension } from "@mariozechner/pi-coding-agent";
import fs from "fs";
import path from "path";

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 30_000;

interface IpcTask {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

interface IpcResult {
  id: string;
  status: "pending" | "done" | "error";
  result?: unknown;
  error?: string;
}

function getGroupFolder(): string {
  const cwd = process.env.AGENT_CWD ?? "/workspace";
  return path.basename(cwd);
}

function writeTask(group: string, task: IpcTask): void {
  const dir = `/workspace/ipc/${group}/tasks`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(task));
}

function readResult(group: string, taskId: string): IpcResult | null {
  const resultPath = `/workspace/ipc/${group}/task-results/${taskId}.json`;
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as IpcResult;
  } catch {
    return null;
  }
}

async function runIpcTask(
  group: string,
  task: IpcTask,
  signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  writeTask(group, task);

  const start = Date.now();
  while (!signal.aborted) {
    const elapsed = Date.now() - start;
    if (elapsed >= TIMEOUT_MS) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Task timed out after ${TIMEOUT_MS / 1000}s`,
          },
        ],
      };
    }

    const result = readResult(group, task.id);
    if (result && result.status !== "pending") {
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }],
        };
      }
      const text =
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result, null, 2);
      return { content: [{ type: "text", text }] };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return {
    content: [{ type: "text", text: "Error: Task aborted" }],
  };
}

export default function skillManagerExtension(pi: Extension): void {
  const group = getGroupFolder();

  pi.registerTool({
    name: "install_skill",
    label: "[Skill] Install",
    description: "Install a skill by name or git URL",
    parameters: {
      type: "object",
      properties: {
        name_or_url: {
          type: "string",
          description:
            "Skill name from registry (e.g. 'qodo-pr-resolver') or a git URL",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Force reinstall if already installed",
        },
      },
      required: ["name_or_url"],
    },
    async execute(id, params: { name_or_url: string; force?: boolean }, signal) {
      const task: IpcTask = {
        id,
        type: "install_skill",
        skillNameOrUrl: params.name_or_url,
        force: params.force ?? false,
      };
      return runIpcTask(group, task, signal);
    },
  });

  pi.registerTool({
    name: "remove_skill",
    label: "[Skill] Remove",
    description: "Remove an installed skill",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the skill to remove",
        },
      },
      required: ["name"],
    },
    async execute(id, params: { name: string }, signal) {
      const task: IpcTask = {
        id,
        type: "remove_skill",
        skillNameOrUrl: params.name,
      };
      return runIpcTask(group, task, signal);
    },
  });

  pi.registerTool({
    name: "list_skills",
    label: "[Skill] List Installed",
    description: "List skills currently installed in container/skills/",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(id, _params, signal) {
      const task: IpcTask = {
        id,
        type: "list_skills",
      };
      return runIpcTask(group, task, signal);
    },
  });

  pi.registerTool({
    name: "list_available_skills",
    label: "[Skill] List Available",
    description: "List skills available in the registry",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(id, _params, signal) {
      const task: IpcTask = {
        id,
        type: "list_available_skills",
      };
      return runIpcTask(group, task, signal);
    },
  });
}
