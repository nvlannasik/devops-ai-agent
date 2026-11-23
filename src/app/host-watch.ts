import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { recoveryMessage, silenceMessage, type WatchedHost } from "../agent/vm/silence.js";
import type { VmStore } from "../agent/vm/store.js";
import type { SlackHost } from "./host.js";

// Host silence (2026-11-24): every minute, hosts whose devops-vm-agent stopped heartbeating are claimed
// (migrations/023 — one replica gets each) and announced together in the alert channel; a host that
// reports again is posted in that announcement's thread. Runs in the agent, not in Prometheus, on
// purpose: on 2026-11-21..23 two of three control planes were down, the Kubernetes API with them, and
// every kube_* alert was blind — the heartbeats were the one signal still arriving.
const TICK_MS = 60_000;

type Store = Pick<VmStore, "hosts" | "claimSilent" | "unclaimSilent" | "silenceAnnounced" | "claimRecovered">;

export class HostWatch {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly host: Pick<SlackHost, "app" | "stopping"> & { agent: { vmStore: Store } },
    now: () => number = Date.now
  ) {
    this.startedAt = now();
  }

  start(): void {
    if (!config.hostWatch.enabled) return void logger.info("[host-watch] off (HOST_WATCH_ENABLED=false)");
    if (!config.incidents.enabled) return void logger.info("[host-watch] off — needs Postgres (set DB_HOST)");
    if (config.vm.tokens.size === 0) return void logger.info("[host-watch] off — no VM_AGENT_TOKENS, no host reports to watch");
    if (!config.slack.alertChannel) return void logger.info("[host-watch] off — no SLACK_ALERT_CHANNEL");
    logger.info(`[host-watch] a host silent for ${config.hostWatch.silentMinutes} min is announced in ${config.slack.alertChannel}`);
    const tick = async (): Promise<void> => {
      try {
        await this.tick(new Date());
      } catch (err) {
        logger.error(`[host-watch] tick failed: ${errDetail(err)}`);
      } finally {
        if (!this.host.stopping) this.timer = setTimeout(() => void tick(), TICK_MS).unref();
      }
    };
    this.timer = setTimeout(() => void tick(), TICK_MS).unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass at `now`. Public for the test. Returns what it posted. */
  async tick(now: Date): Promise<{ silent: string[]; recovered: string[] }> {
    const channel = config.slack.alertChannel!;
    const minutes = config.hostWatch.silentMinutes;
    const store = this.host.agent.vmStore;
    const out = { silent: [] as string[], recovered: [] as string[] };

    // Recoveries first: a host that is back must not be counted silent in the same pass's quorum line.
    const back = await store.claimRecovered();
    if (back.length) {
      const all = await this.watched(store);
      for (const h of back) {
        const text = recoveryMessage(h, all, minutes * 60, now);
        await this.host.app.client.chat
          .postMessage({ channel: h.channel ?? channel, ...(h.ts ? { thread_ts: h.ts } : {}), text, mrkdwn: true })
          .then(() => out.recovered.push(h.node ?? h.name))
          .catch((e) => logger.warn(`[host-watch] recovery of ${h.name} not posted: ${errDetail(e)}`));
      }
    }

    // After any agent downtime every host looks silent until its next heartbeat (≤ 60 s): this
    // process says nothing about silence until it has been up longer than the threshold plus a minute.
    if (now.getTime() - this.startedAt < (minutes + 1) * 60_000) return out;

    const silent = await store.claimSilent(minutes);
    if (silent.length === 0) return out;
    const names = silent.map((h) => h.name);
    try {
      const all = await this.watched(store);
      const byName = new Map(all.map((h) => [h.name, h]));
      const text = silenceMessage(
        silent.map((h) => ({ ...(byName.get(h.name) ?? { ...h, lastSeenSeconds: (now.getTime() - h.lastSeen.getTime()) / 1000 }), lastSeen: h.lastSeen })),
        all,
        minutes * 60,
        now
      );
      const res = await this.host.app.client.chat.postMessage({ channel, text, mrkdwn: true });
      if (res.ts) await store.silenceAnnounced(names, channel, res.ts);
      out.silent.push(...silent.map((h) => h.node ?? h.name));
      logger.warn(`[host-watch] announced silent host(s): ${names.join(", ")}`);
    } catch (err) {
      // Give the claims back so the next minute tries again — a silence nobody was told about is the one failure this exists to prevent.
      await store.unclaimSilent(names).catch(() => {});
      logger.error(`[host-watch] could not announce ${names.join(", ")} — will retry: ${errDetail(err)}`);
    }
    return out;
  }

  private async watched(store: Store): Promise<WatchedHost[]> {
    return (await store.hosts()).map((h) => ({ name: h.name, node: h.node, cluster: h.cluster, lastSeenSeconds: h.lastSeenSeconds, snapshot: h.snapshot }));
  }
}
