import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../../config/index.js";
import logger from "../../utils/logger/index.js";
import type { ToolDefinition } from "../llm/types.js";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

// simple async mutex — prevents concurrent reconnects from racing
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.locked = false; }
  }
}

export class MCPClient {
  private client: Client;
  private tools: ToolDefinition[] = [];
  private connected = false;
  private reconnectMutex = new Mutex();

  constructor() {
    this.client = new Client({ name: "devops-ai-agent", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    await this.connectWithRetry(0);
  }

  private async connectWithRetry(attempt: number): Promise<void> {
    try {
      const transport =
        config.mcp.transport === "http"
          ? new StreamableHTTPClientTransport(new URL(config.mcp.http.url))
          : new StdioClientTransport({
              command: config.mcp.stdio.command,
              args: config.mcp.stdio.args,
            });

      // recreate client on reconnect to reset state
      this.client = new Client({ name: "devops-ai-agent", version: "1.0.0" });
      await this.client.connect(transport);
      this.connected = true;
      logger.info(`MCP client connected via ${config.mcp.transport}`);
      await this.discoverTools();
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`MCP connection failed after ${MAX_RETRIES} attempts: ${err}`);
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(`MCP connect attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
      await this.connectWithRetry(attempt + 1);
    }
  }

  private async discoverTools(): Promise<void> {
    const { tools } = await this.client.listTools();
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    logger.info(`Discovered ${this.tools.length} MCP tools`);
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.connected) {
      await this.reconnectMutex.acquire();
      try {
        if (!this.connected) { // double-check after acquiring lock
          logger.warn("MCP not connected, attempting reconnect...");
          await this.connectWithRetry(0);
        }
      } finally {
        this.reconnectMutex.release();
      }
    }

    try {
      const result = await this.client.callTool({ name, arguments: input }, undefined, { timeout: config.mcp.toolTimeoutMs });
      const content = result.content as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text ?? "").join("\n");
    } catch (err) {
      // reconnect once on failure, serialized via mutex
      await this.reconnectMutex.acquire();
      try {
        logger.warn(`Tool call failed, reconnecting: ${err}`);
        this.connected = false;
        await this.connectWithRetry(0);
      } finally {
        this.reconnectMutex.release();
      }
      const result = await this.client.callTool({ name, arguments: input }, undefined, { timeout: config.mcp.toolTimeoutMs });
      const content = result.content as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text ?? "").join("\n");
    }
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
