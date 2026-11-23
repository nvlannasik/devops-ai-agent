// Host silence (2026-11-24): the words for "these hosts stopped reporting" and "this one is back",
// built from what the agent holds itself — heartbeat ages and each host's last snapshot — because the
// moment this matters most is the moment Kubernetes cannot answer: 2026-11-21..23 the three VMs went
// silent within seconds of each other, two were control planes, etcd lost quorum, and for 66 h the
// only alert anywhere was FluxControllerDown on a worker.

/** What a host's last snapshot says it runs: an etcd member, a control plane (etcd or kube-apiserver). */
export function hostRoles(snapshot: Record<string, unknown> | null): { etcd: boolean; controlPlane: boolean } {
  const units = Array.isArray(snapshot?.units) ? (snapshot!.units as Array<Record<string, unknown>>) : [];
  const procs = Array.isArray(snapshot?.processes) ? (snapshot!.processes as Array<Record<string, unknown>>) : [];
  const etcd = units.some((u) => u?.unit === "etcd.service") || procs.some((p) => p?.name === "etcd");
  const apiserver = procs.some((p) => p?.name === "kube-apiserver");
  return { etcd, controlPlane: etcd || apiserver };
}

export interface WatchedHost {
  name: string;
  node: string | null;
  cluster: string | null;
  /** Seconds since its last heartbeat. */
  lastSeenSeconds: number;
  snapshot: Record<string, unknown> | null;
}

const label = (h: { name: string; node: string | null }) => h.node ?? h.name;
const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");

/** "66 h 57 min", "12 min", "45 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Slack renders this in the reader's own time zone; the fallback is UTC. */
const when = (d: Date) => `<!date^${Math.floor(d.getTime() / 1000)}^{date_short_pretty} {time}|${d.toISOString().slice(0, 16).replace("T", " ")} UTC>`;

/**
 * etcd's state among the hosts of one cluster, from the hosts' own reports: members are hosts whose
 * last snapshot shows etcd, a member is alive when it reported within `silentSeconds`. Null when fewer
 * than two members are known — one etcd is no quorum question, and none means no data.
 */
export function quorum(hosts: WatchedHost[], silentSeconds: number): { members: number; alive: string[]; silent: string[]; has: boolean } | null {
  const members = hosts.filter((h) => hostRoles(h.snapshot).etcd);
  if (members.length < 2) return null;
  const alive = members.filter((h) => h.lastSeenSeconds < silentSeconds).map(label);
  const silent = members.filter((h) => h.lastSeenSeconds >= silentSeconds).map(label);
  return { members: members.length, alive, silent, has: alive.length >= Math.floor(members.length / 2) + 1 };
}

/**
 * The announcement for hosts that just went silent (one message per tick, however many). `all` is
 * every host the agent knows, for the quorum and the "every host at once" reading.
 */
export function silenceMessage(silent: Array<WatchedHost & { lastSeen: Date }>, all: WatchedHost[], silentSeconds: number, now: Date): string {
  const names = silent.map(label);
  const first = silent.reduce((a, h) => (h.lastSeen < a ? h.lastSeen : a), silent[0]!.lastSeen);
  const last = silent.reduce((a, h) => (h.lastSeen > a ? h.lastSeen : a), silent[0]!.lastSeen);
  const lines: string[] = [
    silent.length === 1
      ? `🔌 *${names[0]} stopped reporting* — its devops-vm-agent last heartbeated ${when(first)} (${duration((now.getTime() - first.getTime()) / 1000)} ago).`
      : `🔌 *${silent.length} hosts stopped reporting* — ${list(names)}, last heard ${when(first)} (${duration((now.getTime() - first.getTime()) / 1000)} ago).`,
  ];
  const everyone = all.length >= 2 && all.every((h) => h.lastSeenSeconds >= silentSeconds);
  if (everyone) {
    // Every host at once is more likely the path to the agent (its /vm endpoint, the Ingress, the LAN
    // IP) than every machine failing — say so before anything about etcd, which would then be a guess.
    lines.push(`• *Every* known host is silent — more likely the hosts cannot reach the agent's \`/vm/\` endpoint (Ingress, LAN IP) than all of them down at once.`);
  } else {
    const clusters = new Map<string, WatchedHost[]>();
    for (const h of all) clusters.set(h.cluster ?? "", [...(clusters.get(h.cluster ?? "") ?? []), h]);
    for (const [cluster, hosts] of clusters) {
      const q = quorum(hosts, silentSeconds);
      if (!q || q.silent.length === 0) continue;
      const where = cluster ? ` in \`${cluster}\`` : "";
      if (!q.has) {
        lines.push(
          `• ⛔ *etcd has lost quorum*${where}: ${q.alive.length} of ${q.members} members reporting${q.alive.length ? ` (${list(q.alive)})` : ""}. ` +
            `The Kubernetes API cannot answer until one of ${list(q.silent)} is back — expect controllers that need it (Flux, ` +
            `kube-state-metrics, calico-kube-controllers) to restart in a loop and every \`kube_*\` alert to go quiet.`
        );
      } else {
        lines.push(`• ⚠️ etcd still has quorum${where} (${q.alive.length} of ${q.members} reporting) — losing one more of ${list(q.alive)} takes the Kubernetes API down.`);
      }
    }
    const cp = silent.filter((h) => hostRoles(h.snapshot).controlPlane).map(label);
    if (cp.length) lines.push(`• Control plane among them: ${list(cp)}.`);
    if (silent.length >= 2 && last.getTime() - first.getTime() <= 120_000) {
      lines.push(`• They went quiet within ${duration((last.getTime() - first.getTime()) / 1000)} of each other — look at what they share (a hypervisor, a switch, power) before Kubernetes.`);
    }
  }
  lines.push(`I'll post in this thread when each one reports again.`);
  return lines.join("\n");
}

/** The thread reply when a host reports again. `all` is every host now, for the quorum line. */
export function recoveryMessage(host: { name: string; node: string | null; cluster: string | null; silentSince: Date }, all: WatchedHost[], silentSeconds: number, now: Date): string {
  const lines = [`✅ \`${label(host)}\` is reporting again after ${duration((now.getTime() - host.silentSince.getTime()) / 1000)} of silence.`];
  const q = quorum(all.filter((h) => (h.cluster ?? "") === (host.cluster ?? "")), silentSeconds);
  if (q && hostRoles(all.find((h) => h.name === host.name)?.snapshot ?? null).etcd) {
    lines.push(
      q.has
        ? `etcd has quorum again (${q.alive.length} of ${q.members} reporting)${q.silent.length ? ` — still silent: ${list(q.silent)}` : ""}.`
        : `etcd still has NO quorum (${q.alive.length} of ${q.members} reporting) — still silent: ${list(q.silent)}.`
    );
  }
  return lines.join("\n");
}
