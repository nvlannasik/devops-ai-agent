import { DevOpsAgent } from "./src/agent/index.js";
import { SlackApp } from "./src/app/index.js";
import logger from "./src/utils/logger/index.js";

async function main() {
  const agent = new DevOpsAgent();
  const slack = new SlackApp(agent);

  // graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await slack.stop();
    await agent.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await agent.initialize();
    await slack.start();
  } catch (err) {
    logger.error(`Failed to start: ${err}`);
    process.exit(1);
  }
}

main();
