import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../../config/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";
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
      const authToken = config.mcp.http.authToken;
      const transport =
        config.mcp.transport === "http"
          ? new StreamableHTTPClientTransport(
              new URL(config.mcp.http.url),
              authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : undefined
            )
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
        throw new Error(`MCP connection failed after ${MAX_RETRIES} attempts: ${errDetail(err)}`);
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      // the reason was previously dropped, so a wrong URL and a bad token looked identical
      const target = config.mcp.transport === "http" ? config.mcp.http.url : config.mcp.stdio.command;
      logger.warn(`MCP connect attempt ${attempt + 1}/${MAX_RETRIES + 1} to ${target} failed, retrying in ${delay}ms: ${errDetail(err)}`);
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

  // Real liveness check for /health: sends an MCP ping request (protocol built-in,
  // auto-answered by the server SDK — cheaper than listTools). Short timeout so a dead
  // server can't stall the probe. On failure, flips `connected` so the next tool call
  // takes the reconnect path.
  async ping(): Promise<boolean> {
    try {
      await this.client.ping({ timeout: 5000 });
      return true;
    } catch {
      this.connected = false;
      return false;
    }
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
        logger.warn(`MCP tool "${name}" failed, reconnecting: ${errDetail(err)}`);
        this.connected = false;
        await this.connectWithRetry(0);
      } catch (reconnectErr) {
        // surface BOTH: the reconnect error alone hides why the tool call failed first
        throw new Error(`MCP tool "${name}" failed (${errDetail(err)}) and reconnect failed: ${errDetail(reconnectErr)}`);
      } finally {
        this.reconnectMutex.release();
      }
      try {
        const result = await this.client.callTool({ name, arguments: input }, undefined, { timeout: config.mcp.toolTimeoutMs });
        const content = result.content as Array<{ type: string; text?: string }>;
        return content.map((c) => c.text ?? "").join("\n");
      } catch (retryErr) {
        logger.error(`MCP tool "${name}" failed again after reconnect: ${errDetail(retryErr)}`);
        throw retryErr;
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
