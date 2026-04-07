import type { Extension } from "@mariozechner/pi-coding-agent";

/**
 * pi Extension template demonstrating the standard extension pattern.
 * Use this as a reference when creating new extensions.
 */
export default function templateExtension(pi: Extension): void {
  pi.registerTool({
    name: "template_hello",
    label: "Hello",
    description: "Says hello to the specified name",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
      },
      required: ["name"],
    },
    async execute(id, params, signal, onUpdate) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
      };
    },
  });
}