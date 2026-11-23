import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { digestDue } from "../agent/digest/build.js";
import type { SlackHost } from "./host.js";

// The daily health digest's schedule (C1, agent/digest). A 5-minute timer asks whether today's digest
// is due (DIGEST_TIME .. +3 h, local); the first replica to claim the day in Postgres posts it, every
// other one sees the claim taken and stays quiet. A claim whose post then fails is logged and the day
// is skipped — never retried into a second message.
const TICK_MS = 5 * 60_000;

export class DigestSchedule {
  private timer: NodeJS.Timeout | null = null;
  /** The last local day this replica settled (posted, or saw claimed) — no claim query until the next. */
  private settled: string | null = null;

  constructor(private readonly host: Pick<SlackHost, "agent" | "app" | "stopping">) {}

  start(): void {
    const { enabled, channel, time, timeZone } = config.digest;
    if (!enabled) return void logger.info("[digest] off (DIGEST_ENABLED=false)");
    if (!config.incidents.enabled) return void logger.info("[digest] off — needs Postgres for the per-day claim (set DB_HOST)");
    if (!channel) return void logger.info("[digest] off — no DIGEST_CHANNEL or SLACK_ALERT_CHANNEL");
    logger.info(`[digest] daily at ${time} ${timeZone} to ${channel}`);
    const tick = async (): Promise<void> => {
      try {
        await this.runIfDue(new Date());
      } catch (err) {
        logger.error(`[digest] tick failed: ${errDetail(err)}`);
      } finally {
        if (!this.host.stopping) this.timer = setTimeout(() => void tick(), TICK_MS).unref();
      }
    };
    this.timer = setTimeout(() => void tick(), 30_000).unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Public for the test: one tick at `now`. Returns what it did. */
  async runIfDue(now: Date): Promise<"not-due" | "settled" | "lost" | "posted"> {
    const { channel, time, timeZone } = config.digest;
    const { due, day } = digestDue(now, timeZone, time);
    if (!due || !channel) return "not-due";
    if (this.settled === day) return "settled";
    if (!(await this.host.agent.claimDigest(day, channel))) {
      this.settled = day;
      return "lost";
    }
    this.settled = day;
    const digest = await this.host.agent.healthDigest(now);
    const res = await this.host.app.client.chat.postMessage({ channel, text: digest.text, mrkdwn: true, unfurl_links: false });
    if (res.ts) await this.host.agent.digestPosted(day, res.ts, digest.text).catch((e) => logger.warn(`[digest] posted but not recorded: ${errDetail(e)}`));
    logger.info(`[digest] posted the ${day} digest to ${channel}`);
    return "posted";
  }
}
