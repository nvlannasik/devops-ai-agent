import { DevOpsAgent } from "./src/agent/index.js";
import { SlackApp } from "./src/app/index.js";
import logger, { errDetail } from "./src/utils/logger/index.js";

async function main() {
  try {
    // inside the try: the constructor validates config (e.g. the router's backend registry)
    // and throws on a bad one — outside, that surfaces as a raw unhandled rejection
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

    await agent.initialize();
    await slack.start();
  } catch (err) {
    logger.error(`Failed to start: ${errDetail(err)}`);
    process.exit(1);
  }
}

main();
