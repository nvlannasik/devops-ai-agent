import type { ToolDefinition } from "../llm/types.js";

/**
 * What the agent needs from an MCP server, whatever carries it: HTTP today (MCPClient), an SQS
 * bridge per app cluster next (multi-cluster part 1). A class with private fields is nominal to
 * TypeScript, so the agent takes this instead of MCPClient.
 */
export interface McpTools {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getTools(): ToolDefinition[];
  ping(): Promise<boolean>;
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
}
