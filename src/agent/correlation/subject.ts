// Subject correlation (2026-11-24): alert groups that are about the SAME THING merge into the open
// incident's thread, whatever their alertnames. The call-graph correlation beside it (topology.ts)
// joins services that call each other; it never saw these two storms, both read from production:
//
//   - 2026-11-10: cert-manager after the rebuild — six Certificates in five namespaces, each firing
//     CertificateExpiringSoon + RenewalOverdue + NotReady within ~4 min: 14 investigations of one
//     cause (the ClusterIssuer). Their `pod`/`node` labels are cert-manager's own scrape target, not
//     the certificate, and `name`/`issuer_name` drop out whenever a group spans two certificates —
//     so the key is the cert-manager family itself.
//   - 2026-11-14: master3-vm under MemoryPressure for eleven hours, evicting its DaemonSet pods
//     (node-exporter, metallb speaker) again and again; every replacement pod had a new name, so
//     every one was a new KubernetesPodNotHealthy group — 26 investigations of the node's problem.
//     A pod alert carries no node label; app/alerts resolves the pod's node with one pod listing.

/** Every Certificate* alert, whatever certificate, issuer or namespace: one storm, one cause. */
export const CERT_FAMILY = "cert-manager";
const CERT_WINDOW_MS = 30 * 60_000;
/** A node's incident collects what happens on that node while it is open, up to this long. */
const NODE_WINDOW_MS = 6 * 3_600_000;
/** An alert that started a little before the incident it belongs to (Alertmanager's group_wait). */
const EARLY_MS = 10 * 60_000;

export interface Subject {
  /** Correlation keys: `cert-manager`, `node:<name>`. */
  keys: string[];
  /** A pod-level alert's pod — its node is looked up only when a node incident is open. */
  pod?: { namespace: string; name: string };
  /** For the merge message: what the alert is about. */
  label: string;
}

export function subjectOf(labels: Record<string, string | undefined>): Subject {
  const alertname = labels.alertname ?? "";
  if (/^Certificate/.test(alertname) || labels.issuer_kind || labels.issuer_name) {
    const cert = labels.name && labels.namespace ? `${labels.namespace}/${labels.name}` : labels.namespace ? `certificates in ${labels.namespace}` : "certificates";
    return { keys: [CERT_FAMILY], label: cert };
  }
  if (labels.pod && labels.namespace) return { keys: [], pod: { namespace: labels.namespace, name: labels.pod }, label: `${labels.namespace}/${labels.pod}` };
  if (labels.node) return { keys: [`node:${labels.node}`], label: labels.node };
  return { keys: [], label: labels.namespace ?? alertname };
}

export interface SubjectCandidate {
  threadTs: string;
  channel: string;
  alertname: string;
  namespace: string | null;
  keys: string[];
  /** When the candidate's alert started (ms). */
  startedAt: number;
}

export interface SubjectRelation {
  candidate: SubjectCandidate;
  via: string;
}

/** Its own group re-sent with other labels (a new pod name) is not a relation — same rule as topology.ts. */
const ownGroup = (alert: { alertname: string; namespace: string | null }, c: SubjectCandidate) => c.alertname === alert.alertname && (c.namespace ?? "") === (alert.namespace ?? "");

/** The earliest open candidate sharing a key with this alert, inside that key's window. */
export function subjectMatch(alert: { alertname: string; namespace: string | null; keys: string[]; startsAt: number }, candidates: SubjectCandidate[]): SubjectRelation | null {
  const sorted = [...candidates].sort((a, b) => a.startedAt - b.startedAt);
  for (const c of sorted) {
    if (ownGroup(alert, c)) continue;
    const age = alert.startsAt - c.startedAt;
    for (const key of alert.keys) {
      if (!c.keys.includes(key)) continue;
      if (key === CERT_FAMILY && age <= CERT_WINDOW_MS && age >= -EARLY_MS) return { candidate: c, via: "the same cert-manager storm" };
      if (key.startsWith("node:") && age <= NODE_WINDOW_MS && age >= -EARLY_MS) return { candidate: c, via: `same node \`${key.slice(5)}\`` };
    }
  }
  return null;
}

/** Is there an open node incident a pod could belong to? (Gates the pod lookup — one MCP call.) */
export const hasNodeCandidate = (candidates: SubjectCandidate[], startsAt: number): boolean =>
  candidates.some((c) => c.keys.some((k) => k.startsWith("node:")) && startsAt - c.startedAt <= NODE_WINDOW_MS && startsAt - c.startedAt >= -EARLY_MS);

/** A pod alert on `node` → the node's open incident, if one is inside the window. */
export function podNodeMatch(alert: { alertname: string; namespace: string | null; startsAt: number }, node: string, candidates: SubjectCandidate[]): SubjectRelation | null {
  const key = `node:${node}`;
  const c = [...candidates]
    .sort((a, b) => a.startedAt - b.startedAt)
    .find((x) => !ownGroup(alert, x) && x.keys.includes(key) && alert.startsAt - x.startedAt <= NODE_WINDOW_MS && alert.startsAt - x.startedAt >= -EARLY_MS);
  return c ? { candidate: c, via: `its pod runs on \`${node}\`, which has this ${c.alertname} incident open` } : null;
}

/** k8s_list_pods' answer → the named pod's node, or null. */
export function nodeOfPod(raw: string, pod: string): string | null {
  try {
    const rows = JSON.parse(raw) as unknown;
    const list = Array.isArray(rows) ? rows : Array.isArray((rows as { pods?: unknown })?.pods) ? (rows as { pods: unknown[] }).pods : [];
    const hit = (list as Array<{ name?: unknown; node?: unknown }>).find((p) => p?.name === pod);
    return typeof hit?.node === "string" && hit.node ? hit.node : null;
  } catch {
    return null;
  }
}
