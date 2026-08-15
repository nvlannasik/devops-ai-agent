import { DevOpsAgent } from "./src/agent/index.js";
import { SlackApp } from "./src/app/index.js";
import { DashboardServer } from "./src/dashboard/server.js";
import logger, { errDetail } from "./src/utils/logger/index.js";

async function main() {
  try {
    // inside the try: the constructor validates config (e.g. the router's backend registry)
    // and throws on a bad one — outside, that surfaces as a raw unhandled rejection
    const agent = new DevOpsAgent();
    const slack = new SlackApp(agent);
    // The arrow is the point: the dashboard reads the tool list per request, so it reflects
    // whatever the agent is connected to now rather than what it had at boot (nothing, here —
    // initialize() runs further down).
    const dashboard = new DashboardServer(undefined, () => agent.mcpTools(), () => agent.skillsView());

    // graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      // dashboard LAST: it is auxiliary, and it is the one holding connections that can be
      // stuck on an unreachable database. Shutting it down first let a single open browser
      // tab delay slack.stop() and agent.shutdown() past the grace period, so Slack kept
      // delivering to a terminating pod and the SQS dispatcher never drained.
      await slack.stop();
      await agent.shutdown();
      await dashboard.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await agent.initialize();
    await slack.start();
    // last, and never fatal — see DashboardServer.start()
    await dashboard.start();
  } catch (err) {
    logger.error(`Failed to start: ${errDetail(err)}`);
    process.exit(1);
  }
}

main();
